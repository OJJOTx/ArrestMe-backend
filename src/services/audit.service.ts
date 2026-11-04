import type { Clock } from '../shared/time';
import type { AuditResult } from '../types/domain';
import type { AuditLogsRepository } from '../types/repositories';

export interface RequestContextMeta {
  ipAddress?: string | null;
  requestId?: string | null;
  userAgent?: string | null;
}

export class AuditService {
  constructor(private readonly clock: Clock) {}

  async record(
    auditRepo: AuditLogsRepository,
    params: {
      actorUserId?: string | null;
      actorDeviceId?: string | null;
      action: string;
      resourceType: string;
      resourceId: string;
      result: AuditResult;
      context?: RequestContextMeta;
      metadata?: Record<string, unknown> | null;
    }
  ): Promise<void> {
    await auditRepo.append({
      actorUserId: params.actorUserId ?? null,
      actorDeviceId: params.actorDeviceId ?? null,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      result: params.result,
      ipAddress: params.context?.ipAddress ?? null,
      requestId: params.context?.requestId ?? null,
      metadata: params.metadata ?? null,
      createdAt: this.clock.now()
    });
  }
}
