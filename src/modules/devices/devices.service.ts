import { randomUUID } from 'node:crypto';
import type { AuditService, RequestContextMeta } from '../../services/audit.service';
import { sha256Hex } from '../../shared/crypto';
import { Errors } from '../../shared/errors';
import type { Clock } from '../../shared/time';
import type { DeviceRecord, PaginatedResult } from '../../types/domain';
import type { DataStore } from '../../types/repositories';

export interface SerializedDevice {
  id: string;
  userId: string;
  installationId: string | null;
  deviceName: string;
  platform: 'ANDROID';
  manufacturer: string | null;
  model: string | null;
  appVersion: string;
  androidVersion: string;
  sdkInt: number | null;
  deviceStatus: 'ACTIVE' | 'INACTIVE' | 'REVOKED';
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeDevice(device: DeviceRecord): SerializedDevice {
  return {
    id: device.id,
    userId: device.userId,
    installationId: device.installationId,
    deviceName: device.deviceName,
    platform: device.platform,
    manufacturer: device.manufacturer,
    model: device.model,
    appVersion: device.appVersion,
    androidVersion: device.androidVersion,
    sdkInt: device.sdkInt,
    deviceStatus: device.deviceStatus,
    lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
    revokedAt: device.revokedAt ? device.revokedAt.toISOString() : null,
    createdAt: device.createdAt.toISOString(),
    updatedAt: device.updatedAt.toISOString()
  };
}

export class DevicesService {
  constructor(
    private readonly store: DataStore,
    private readonly auditService: AuditService,
    private readonly clock: Clock
  ) {}

  async registerDevice(
    userId: string,
    input: {
      installationId?: string;
      deviceName: string;
      platform?: 'ANDROID';
      manufacturer?: string;
      model?: string;
      appVersion: string;
      androidVersion: string;
      sdkInt?: number;
      fcmToken?: string;
    },
    context?: RequestContextMeta
  ): Promise<{ device: SerializedDevice; created: boolean }> {
    return this.store.withTransaction(async (repos) => {
      const now = this.clock.now();

      let device: DeviceRecord | null = null;
      let created = false;

      if (input.installationId) {
        const existing = await repos.devices.findByUserAndInstallation(
          userId,
          input.installationId
        );
        if (existing && existing.deviceStatus !== 'REVOKED') {
          device = await repos.devices.update(existing.id, {
            deviceName: input.deviceName,
            manufacturer: input.manufacturer ?? existing.manufacturer,
            model: input.model ?? existing.model,
            appVersion: input.appVersion,
            androidVersion: input.androidVersion,
            sdkInt: input.sdkInt ?? existing.sdkInt,
            deviceStatus: 'ACTIVE',
            lastSeenAt: now,
            updatedAt: now
          });
        } else if (existing && existing.deviceStatus === 'REVOKED') {
          // Clear installationId on revoked device or reactivate cleanly under a new device ID:
          // Creating a fresh device record requires unique (user_id, installation_id), so we reactivate
          // or issue a distinct replacement only if not revoked. For a revoked installation, re-binding
          // creates a clean audit trail while restoring ACTIVE status for the owner.
          device = await repos.devices.update(existing.id, {
            deviceName: input.deviceName,
            manufacturer: input.manufacturer ?? existing.manufacturer,
            model: input.model ?? existing.model,
            appVersion: input.appVersion,
            androidVersion: input.androidVersion,
            sdkInt: input.sdkInt ?? existing.sdkInt,
            deviceStatus: 'ACTIVE',
            revokedAt: null,
            lastSeenAt: now,
            updatedAt: now
          });
        }
      }

      if (!device) {
        created = true;
        device = await repos.devices.create({
          id: randomUUID(),
          userId,
          installationId: input.installationId ?? null,
          deviceName: input.deviceName,
          platform: 'ANDROID',
          manufacturer: input.manufacturer ?? null,
          model: input.model ?? null,
          appVersion: input.appVersion,
          androidVersion: input.androidVersion,
          sdkInt: input.sdkInt ?? null,
          deviceStatus: 'ACTIVE',
          lastSeenAt: now,
          revokedAt: null,
          createdAt: now,
          updatedAt: now
        });
      }

      if (input.fcmToken) {
        await repos.pushTokens.upsertForDevice({
          id: randomUUID(),
          deviceId: device.id,
          fcmToken: input.fcmToken,
          tokenHash: sha256Hex(input.fcmToken),
          now
        });
      }

      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        actorDeviceId: device.id,
        action: created ? 'DEVICE_REGISTERED' : 'DEVICE_REGISTRATION_REFRESHED',
        resourceType: 'DEVICE',
        resourceId: device.id,
        result: 'SUCCESS',
        context,
        metadata: {
          appVersion: device.appVersion,
          androidVersion: device.androidVersion
        }
      });

      return { device: serializeDevice(device), created };
    });
  }

  async listMyDevices(
    userId: string,
    options: { includeRevoked?: boolean; limit: number; offset: number }
  ): Promise<PaginatedResult<SerializedDevice>> {
    const page = await this.store.repositories.devices.listByUser(userId, options);
    return {
      ...page,
      items: page.items.map(serializeDevice)
    };
  }

  async getMyDevice(userId: string, deviceId: string): Promise<SerializedDevice> {
    const device = await this.store.repositories.devices.findById(deviceId);
    if (!device || device.userId !== userId) {
      throw Errors.notFound('DEVICE_NOT_FOUND', 'Device was not found.');
    }
    return serializeDevice(device);
  }

  async updateMyDevice(
    userId: string,
    deviceId: string,
    updates: {
      deviceName?: string;
      manufacturer?: string | null;
      model?: string | null;
      appVersion?: string;
      androidVersion?: string;
      sdkInt?: number | null;
      deviceStatus?: 'ACTIVE' | 'INACTIVE';
    },
    context?: RequestContextMeta
  ): Promise<SerializedDevice> {
    return this.store.withTransaction(async (repos) => {
      const existing = await repos.devices.findByIdForUpdate(deviceId);
      if (!existing || existing.userId !== userId) {
        throw Errors.notFound('DEVICE_NOT_FOUND', 'Device was not found.');
      }
      if (existing.deviceStatus === 'REVOKED') {
        throw Errors.conflict(
          'DEVICE_REVOKED',
          'Revoked devices cannot be updated directly. Re-register the installation.'
        );
      }

      const now = this.clock.now();
      const updated = await repos.devices.update(deviceId, {
        ...updates,
        lastSeenAt: now,
        updatedAt: now
      });
      if (!updated) {
        throw Errors.notFound('DEVICE_NOT_FOUND', 'Device was not found.');
      }

      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        actorDeviceId: deviceId,
        action: 'DEVICE_UPDATED',
        resourceType: 'DEVICE',
        resourceId: deviceId,
        result: 'SUCCESS',
        context
      });

      return serializeDevice(updated);
    });
  }

  async revokeMyDevice(
    userId: string,
    deviceId: string,
    context?: RequestContextMeta
  ): Promise<SerializedDevice> {
    return this.store.withTransaction(async (repos) => {
      const existing = await repos.devices.findByIdForUpdate(deviceId);
      if (!existing || existing.userId !== userId) {
        throw Errors.notFound('DEVICE_NOT_FOUND', 'Device was not found.');
      }

      if (existing.deviceStatus === 'REVOKED') {
        return serializeDevice(existing);
      }

      const now = this.clock.now();
      const updated = await repos.devices.update(deviceId, {
        deviceStatus: 'REVOKED',
        revokedAt: now,
        updatedAt: now
      });

      const revokedTokens = await repos.pushTokens.revokeAllForDevice(
        deviceId,
        'DEVICE_REVOKED_BY_OWNER',
        now
      );
      const revokedPermissions = await repos.partnerPermissions.revokeAllForDevice(deviceId, {
        revokedByUserId: userId,
        revokeReason: 'Target device was revoked by owner',
        now
      });
      const expiredCommands = await repos.commands.expirePendingForDeviceRevocation(
        deviceId,
        'Target device was revoked by owner',
        now
      );

      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        actorDeviceId: deviceId,
        action: 'DEVICE_REVOKED',
        resourceType: 'DEVICE',
        resourceId: deviceId,
        result: 'SUCCESS',
        context,
        metadata: {
          revokedPushTokens: revokedTokens,
          revokedPartnerPermissions: revokedPermissions,
          expiredPendingCommands: expiredCommands
        }
      });

      return serializeDevice(updated!);
    });
  }

  async upsertPushToken(
    userId: string,
    deviceId: string,
    fcmToken: string,
    context?: RequestContextMeta
  ): Promise<{ deviceId: string; status: 'ACTIVE'; updatedAt: string }> {
    return this.store.withTransaction(async (repos) => {
      const device = await repos.devices.findByIdForUpdate(deviceId);
      if (!device || device.userId !== userId) {
        throw Errors.notFound('DEVICE_NOT_FOUND', 'Device was not found.');
      }
      if (device.deviceStatus === 'REVOKED') {
        throw Errors.conflict(
          'DEVICE_REVOKED',
          'Cannot register push token for a revoked device.'
        );
      }

      const now = this.clock.now();
      await repos.pushTokens.upsertForDevice({
        id: randomUUID(),
        deviceId,
        fcmToken,
        tokenHash: sha256Hex(fcmToken),
        now
      });
      await repos.devices.touchLastSeen(deviceId, now);

      await this.auditService.record(repos.auditLogs, {
        actorUserId: userId,
        actorDeviceId: deviceId,
        action: 'DEVICE_PUSH_TOKEN_UPDATED',
        resourceType: 'DEVICE',
        resourceId: deviceId,
        result: 'SUCCESS',
        context
      });

      return {
        deviceId,
        status: 'ACTIVE' as const,
        updatedAt: now.toISOString()
      };
    });
  }
}
