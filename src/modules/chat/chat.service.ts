import { randomUUID } from 'node:crypto';
import type { AuditService } from '../../services/audit.service';
import { Errors } from '../../shared/errors';
import type { Clock } from '../../shared/time';
import {
  NON_TERMINAL_CLOUD_SESSION_STATUSES,
  type MessageDeliveryStatus,
  type MessageRecord,
  type MessageType,
  type SessionRuleRevisionRecord,
  type StructuredRequestRecord,
  type StructuredRequestStatus,
  type StructuredRequestType,
  type TemporaryAppAccessGrantRecord,
  type UserRecord
} from '../../types/domain';
import type { DataStore } from '../../types/repositories';
import type { CommandsService } from '../commands/commands.service';
import type { NotificationService } from '../notifications/notification.service';

export interface SerializedUserSummary {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface SerializedStructuredRequest {
  id: string;
  messageId: string;
  conversationId: string;
  requestType: StructuredRequestType;
  initiator: SerializedUserSummary;
  recipient: SerializedUserSummary;
  sessionId: string | null;
  status: StructuredRequestStatus;
  durationMinutes: number | null;
  targetPackage: string | null;
  parameters: Record<string, unknown> | null;
  decisionReason: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedMessage {
  id: string;
  conversationId: string;
  sender: SerializedUserSummary;
  clientMessageId: string;
  messageType: MessageType;
  textContent: string | null;
  structuredRequest: SerializedStructuredRequest | null;
  status: MessageDeliveryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedConversation {
  id: string;
  partnershipId: string;
  partner: SerializedUserSummary;
  unreadCount: number;
  lastMessage: SerializedMessage | null;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedTemporaryGrant {
  id: string;
  sessionId: string;
  deviceId: string;
  packageName: string;
  grantedDurationMinutes: number;
  grantedByUserId: string;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  isCurrentlyActive: boolean;
  createdAt: string;
}

function toUserSummary(u: UserRecord): SerializedUserSummary {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl
  };
}

export class ChatService {
  constructor(
    private readonly store: DataStore,
    private readonly commandsService: CommandsService,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService,
    private readonly clock: Clock,
    private readonly defaultCommandTtlSeconds: number = 300
  ) {}

  async getOrCreateConversationForPartnership(
    userId: string,
    partnershipId: string
  ): Promise<SerializedConversation> {
    const partnership = await this.store.repositories.partnerships.findById(partnershipId);
    if (!partnership) {
      throw Errors.notFound('PARTNERSHIP_NOT_FOUND', 'Partnership was not found.');
    }
    if (partnership.userLowId !== userId && partnership.userHighId !== userId) {
      throw Errors.forbidden('FORBIDDEN', 'You are not a member of this partnership.');
    }
    if (partnership.state !== 'ACCEPTED') {
      throw Errors.badRequest('PARTNERSHIP_REQUIRED', 'Chat is only available for accepted partnerships.');
    }

    const partnerId = partnership.userLowId === userId ? partnership.userHighId : partnership.userLowId;
    let conversation = await this.store.repositories.conversations.findByPartnershipId(partnershipId);

    if (!conversation) {
      const now = this.clock.now();
      conversation = await this.store.repositories.conversations.create(
        {
          id: randomUUID(),
          partnershipId,
          createdAt: now,
          updatedAt: now,
          lastMessageAt: null
        },
        [partnership.userLowId, partnership.userHighId]
      );
    }

    const partnerUser = await this.store.repositories.users.findById(partnerId);
    if (!partnerUser) {
      throw Errors.notFound('NOT_FOUND', 'Partner user not found.');
    }

    const member = await this.store.repositories.conversations.findMember(conversation.id, userId);
    const unreadCount = await this.store.repositories.messages.countUnreadForUser(
      conversation.id,
      member?.lastReadAt ?? null,
      userId
    );

    return {
      id: conversation.id,
      partnershipId: conversation.partnershipId,
      partner: toUserSummary(partnerUser),
      unreadCount,
      lastMessage: null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString()
    };
  }

  async listConversations(
    userId: string,
    options: { limit: number; offset: number }
  ): Promise<{ items: SerializedConversation[]; total: number; limit: number; offset: number }> {
    const paged = await this.store.repositories.conversations.listByUser(userId, options);
    const items: SerializedConversation[] = [];

    for (const conv of paged.items) {
      const members = await this.store.repositories.conversations.listMembers(conv.id);
      const partnerMember = members.find((m) => m.userId !== userId);
      if (!partnerMember) continue;

      const partnerUser = await this.store.repositories.users.findById(partnerMember.userId);
      if (!partnerUser) continue;

      const myMember = members.find((m) => m.userId === userId);
      const unreadCount = await this.store.repositories.messages.countUnreadForUser(
        conv.id,
        myMember?.lastReadAt ?? null,
        userId
      );

      // Latest message
      const latestMessages = await this.store.repositories.messages.listByConversation(conv.id, {
        limit: 1,
        offset: 0
      });
      let lastMsg: SerializedMessage | null = null;
      if (latestMessages.items.length > 0) {
        const rawMsg = latestMessages.items[latestMessages.items.length - 1];
        if (rawMsg) {
          lastMsg = await this.enrichMessage(rawMsg);
        }
      }

      items.push({
        id: conv.id,
        partnershipId: conv.partnershipId,
        partner: toUserSummary(partnerUser),
        unreadCount,
        lastMessage: lastMsg,
        createdAt: conv.createdAt.toISOString(),
        updatedAt: conv.updatedAt.toISOString()
      });
    }

    return {
      items,
      total: paged.total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async getConversationById(userId: string, conversationId: string): Promise<SerializedConversation> {
    const conv = await this.store.repositories.conversations.findById(conversationId);
    if (!conv) {
      throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found.');
    }
    const member = await this.store.repositories.conversations.findMember(conversationId, userId);
    if (!member) {
      throw Errors.forbidden('FORBIDDEN', 'You are not a member of this conversation.');
    }

    const members = await this.store.repositories.conversations.listMembers(conversationId);
    const partnerMember = members.find((m) => m.userId !== userId);
    if (!partnerMember) {
      throw Errors.notFound('NOT_FOUND', 'Partner not found in conversation.');
    }
    const partnerUser = await this.store.repositories.users.findById(partnerMember.userId);
    if (!partnerUser) {
      throw Errors.notFound('NOT_FOUND', 'Partner user record not found.');
    }

    const unreadCount = await this.store.repositories.messages.countUnreadForUser(
      conversationId,
      member.lastReadAt,
      userId
    );

    return {
      id: conv.id,
      partnershipId: conv.partnershipId,
      partner: toUserSummary(partnerUser),
      unreadCount,
      lastMessage: null,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString()
    };
  }

  async listMessages(
    userId: string,
    conversationId: string,
    options: {
      limit: number;
      offset: number;
      beforeDate?: string;
      afterDate?: string;
    }
  ): Promise<{ items: SerializedMessage[]; total: number; limit: number; offset: number }> {
    const member = await this.store.repositories.conversations.findMember(conversationId, userId);
    if (!member) {
      throw Errors.forbidden('FORBIDDEN', 'You are not a member of this conversation.');
    }

    const paged = await this.store.repositories.messages.listByConversation(conversationId, {
      limit: options.limit,
      offset: options.offset,
      beforeDate: options.beforeDate ? new Date(options.beforeDate) : undefined,
      afterDate: options.afterDate ? new Date(options.afterDate) : undefined
    });

    const enriched = await Promise.all(paged.items.map((m) => this.enrichMessage(m)));
    return {
      items: enriched,
      total: paged.total,
      limit: options.limit,
      offset: options.offset
    };
  }

  async sendTextMessage(
    userId: string,
    conversationId: string,
    clientMessageId: string,
    text: string
  ): Promise<SerializedMessage> {
    const member = await this.store.repositories.conversations.findMember(conversationId, userId);
    if (!member) {
      throw Errors.forbidden('FORBIDDEN', 'You are not a member of this conversation.');
    }

    // Check existing for clientMessageId deduplication
    const existing = await this.store.repositories.messages.findByClientMessageId(
      conversationId,
      clientMessageId
    );
    if (existing) {
      return this.enrichMessage(existing);
    }

    const now = this.clock.now();
    const message: MessageRecord = {
      id: randomUUID(),
      conversationId,
      senderUserId: userId,
      clientMessageId,
      messageType: 'TEXT',
      textContent: text,
      structuredPayload: null,
      status: 'SENT',
      createdAt: now,
      updatedAt: now
    };

    const created = await this.store.repositories.messages.create(message);
    await this.store.repositories.conversations.updateLastMessageAt(conversationId, now, now);

    // Notify recipient
    const members = await this.store.repositories.conversations.listMembers(conversationId);
    const recipient = members.find((m) => m.userId !== userId);
    if (recipient) {
      await this.notificationService.notifyUserEvent(recipient.userId, 'CHAT_MESSAGE', created.id);
    }

    return this.enrichMessage(created);
  }

  async createStructuredRequest(
    userId: string,
    conversationId: string,
    params: {
      clientMessageId: string;
      requestType: StructuredRequestType;
      sessionId?: string;
      targetPackage?: string;
      durationMinutes?: number;
      parameters?: Record<string, unknown>;
      messageText?: string;
    }
  ): Promise<SerializedMessage> {
    const member = await this.store.repositories.conversations.findMember(conversationId, userId);
    if (!member) {
      throw Errors.forbidden('FORBIDDEN', 'You are not a member of this conversation.');
    }

    const existingMsg = await this.store.repositories.messages.findByClientMessageId(
      conversationId,
      params.clientMessageId
    );
    if (existingMsg) {
      return this.enrichMessage(existingMsg);
    }

    const members = await this.store.repositories.conversations.listMembers(conversationId);
    const recipientMember = members.find((m) => m.userId !== userId);
    if (!recipientMember) {
      throw Errors.notFound('NOT_FOUND', 'Recipient partner not found in conversation.');
    }

    const now = this.clock.now();
    const messageId = randomUUID();
    const requestId = randomUUID();

    // Validate active session context for session-modifying requests
    if (params.sessionId) {
      const activeSession = await this.store.repositories.sessions.findById(params.sessionId);
      if (!activeSession) {
        throw Errors.notFound('SESSION_NOT_FOUND', 'Active session not found.');
      }
      if (!(NON_TERMINAL_CLOUD_SESSION_STATUSES as readonly string[]).includes(activeSession.status)) {
        throw Errors.badRequest('SESSION_ALREADY_ENDED', 'Cannot request modification on a completed session.');
      }
    }

    const structuredRequest: StructuredRequestRecord = {
      id: requestId,
      messageId,
      conversationId,
      requestType: params.requestType,
      initiatorUserId: userId,
      recipientUserId: recipientMember.userId,
      sessionId: params.sessionId ?? null,
      status: 'PENDING',
      durationMinutes: params.durationMinutes ?? null,
      targetPackage: params.targetPackage ?? null,
      parametersJson: params.parameters ?? null,
      decisionReason: null,
      decidedAt: null,
      expiresAt: new Date(now.getTime() + 15 * 60_000), // 15 min expiration
      createdAt: now,
      updatedAt: now
    };

    const message: MessageRecord = {
      id: messageId,
      conversationId,
      senderUserId: userId,
      clientMessageId: params.clientMessageId,
      messageType: 'STRUCTURED_REQUEST',
      textContent: params.messageText ?? null,
      structuredPayload: {
        requestId,
        requestType: params.requestType,
        targetPackage: params.targetPackage ?? null,
        durationMinutes: params.durationMinutes ?? null
      },
      status: 'SENT',
      createdAt: now,
      updatedAt: now
    };

    await this.store.repositories.structuredRequests.create(structuredRequest);
    const createdMsg = await this.store.repositories.messages.create(message);
    await this.store.repositories.conversations.updateLastMessageAt(conversationId, now, now);

    // Notify recipient
    await this.notificationService.notifyUserEvent(recipientMember.userId, 'STRUCTURED_REQUEST', requestId);

    return this.enrichMessage(createdMsg);
  }

  async respondToStructuredRequest(
    userId: string,
    requestId: string,
    params: {
      decision: 'APPROVE' | 'REJECT';
      reason?: string;
    }
  ): Promise<SerializedStructuredRequest> {
    const request = await this.store.repositories.structuredRequests.findById(requestId);
    if (!request) {
      throw Errors.notFound('REQUEST_NOT_FOUND', 'Structured request was not found.');
    }
    if (request.recipientUserId !== userId) {
      throw Errors.forbidden('FORBIDDEN', 'Only the assigned recipient partner can respond to this request.');
    }
    if (request.status !== 'PENDING') {
      throw Errors.conflict('REQUEST_INVALID_STATE', `Request has already been ${request.status.toLowerCase()}.`);
    }

    const now = this.clock.now();
    const newStatus: StructuredRequestStatus = params.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';

    const updated = await this.store.repositories.structuredRequests.updateDecision(requestId, {
      status: newStatus,
      decisionReason: params.reason ?? null,
      decidedAt: now,
      updatedAt: now
    });

    // Execute real-time command action if approved
    if (params.decision === 'APPROVE') {
      await this.executeApprovedRequestAction(updated, now);
    }

    // Insert system event message into the chat
    const actor = await this.store.repositories.users.findById(userId);
    const systemText = `${actor?.displayName ?? 'Partner'} ${newStatus.toLowerCase()} ${formatRequestSummary(request)}` +
      (params.reason ? `: "${params.reason}"` : '');

    const sysMsg: MessageRecord = {
      id: randomUUID(),
      conversationId: request.conversationId,
      senderUserId: userId,
      clientMessageId: `sys_${requestId}_${newStatus}`,
      messageType: 'SYSTEM_EVENT',
      textContent: systemText,
      structuredPayload: {
        requestId: request.id,
        status: newStatus,
        reason: params.reason ?? null
      },
      status: 'SENT',
      createdAt: now,
      updatedAt: now
    };
    await this.store.repositories.messages.create(sysMsg);
    await this.store.repositories.conversations.updateLastMessageAt(request.conversationId, now, now);

    // Notify requester
    await this.notificationService.notifyUserEvent(request.initiatorUserId, 'REQUEST_RESPONSE', request.id);

    return this.serializeStructuredRequest(updated);
  }

  async cancelStructuredRequest(
    userId: string,
    requestId: string
  ): Promise<SerializedStructuredRequest> {
    const request = await this.store.repositories.structuredRequests.findById(requestId);
    if (!request) {
      throw Errors.notFound('REQUEST_NOT_FOUND', 'Structured request was not found.');
    }
    if (request.initiatorUserId !== userId) {
      throw Errors.forbidden('FORBIDDEN', 'Only the initiator can cancel this request.');
    }
    if (request.status !== 'PENDING') {
      throw Errors.conflict('REQUEST_INVALID_STATE', `Request is not pending (status: ${request.status}).`);
    }

    const now = this.clock.now();
    const updated = await this.store.repositories.structuredRequests.updateDecision(requestId, {
      status: 'CANCELLED',
      decisionReason: 'Cancelled by initiator',
      decidedAt: now,
      updatedAt: now
    });

    return this.serializeStructuredRequest(updated);
  }

  async markConversationRead(
    userId: string,
    conversationId: string,
    lastReadMessageId: string
  ): Promise<void> {
    const member = await this.store.repositories.conversations.findMember(conversationId, userId);
    if (!member) {
      throw Errors.forbidden('FORBIDDEN', 'You are not a member of this conversation.');
    }
    const now = this.clock.now();
    await this.store.repositories.conversations.updateLastRead(conversationId, userId, {
      lastReadMessageId,
      lastReadAt: now
    });
  }

  async listActiveTemporaryGrants(
    userId: string,
    sessionId: string
  ): Promise<SerializedTemporaryGrant[]> {
    const session = await this.store.repositories.sessions.findById(sessionId);
    if (!session) {
      throw Errors.notFound('SESSION_NOT_FOUND', 'Session not found.');
    }
    if (session.ownerUserId !== userId && session.initiatedByUserId !== userId) {
      throw Errors.forbidden('FORBIDDEN', 'You are not a participant in this session.');
    }

    const now = this.clock.now();
    const grants = await this.store.repositories.temporaryAppAccessGrants.listActiveBySession(sessionId, now);
    return grants.map((g) => ({
      id: g.id,
      sessionId: g.sessionId,
      deviceId: g.deviceId,
      packageName: g.packageName,
      grantedDurationMinutes: g.grantedDurationMinutes,
      grantedByUserId: g.grantedByUserId,
      startsAt: g.startsAt.toISOString(),
      expiresAt: g.expiresAt.toISOString(),
      revokedAt: g.revokedAt?.toISOString() ?? null,
      isCurrentlyActive: g.revokedAt === null && g.startsAt <= now && g.expiresAt > now,
      createdAt: g.createdAt.toISOString()
    }));
  }

  async revokeTemporaryGrant(userId: string, grantId: string): Promise<void> {
    const grant = await this.store.repositories.temporaryAppAccessGrants.findById(grantId);
    if (!grant) {
      throw Errors.notFound('GRANT_NOT_FOUND', 'Grant not found.');
    }
    const session = await this.store.repositories.sessions.findById(grant.sessionId);
    if (!session) {
      throw Errors.notFound('SESSION_NOT_FOUND', 'Session not found.');
    }
    if (session.initiatedByUserId !== userId && grant.grantedByUserId !== userId) {
      throw Errors.forbidden('FORBIDDEN', 'Only the controlling partner can revoke temporary app access.');
    }

    const now = this.clock.now();
    await this.store.repositories.temporaryAppAccessGrants.revoke(grantId, now);

    // Enqueue real-time revoke command to device
    const cmd = await this.store.repositories.commands.create({
      commandId: randomUUID(),
      sessionId: session.sessionId,
      targetDeviceId: grant.deviceId,
      issuedByUserId: userId,
      commandType: 'REVOKE_TEMPORARY_APP_ACCESS',
      payload: {
        grantId,
        packageName: grant.packageName,
        reason: 'Revoked early by controlling partner'
      },
      status: 'PENDING',
      idempotencyKey: `cmd_rev_taag_${grantId}_${now.getTime()}`,
      resultMetadata: null,
      failureReason: null,
      pushDeliveryStatus: 'NOT_ATTEMPTED',
      pushAttempts: 0,
      lastPushAttemptAt: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.defaultCommandTtlSeconds * 1000),
      deliveredAt: null,
      acknowledgedAt: null,
      executedAt: null,
      updatedAt: now
    });
    await this.notificationService.notifyCommandAvailable(cmd);
  }

  private async executeApprovedRequestAction(
    request: StructuredRequestRecord,
    now: Date
  ): Promise<void> {
    if (!request.sessionId) return;
    const session = await this.store.repositories.sessions.findById(request.sessionId);
    if (!session) return;

    switch (request.requestType) {
      case 'REQUEST_EARLY_RELEASE': {
        // Controlling partner approved release request: dispatch APPROVE_RELEASE command
        const cmd = await this.store.repositories.commands.create({
          commandId: randomUUID(),
          sessionId: session.sessionId,
          targetDeviceId: session.targetDeviceId,
          issuedByUserId: request.recipientUserId,
          commandType: 'APPROVE_RELEASE',
          payload: {
            requestId: request.id,
            reason: request.decisionReason ?? 'Approved via partner chat'
          },
          status: 'PENDING',
          idempotencyKey: `cmd_rel_${request.id}`,
          resultMetadata: null,
          failureReason: null,
          pushDeliveryStatus: 'NOT_ATTEMPTED',
          pushAttempts: 0,
          lastPushAttemptAt: null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + this.defaultCommandTtlSeconds * 1000),
          deliveredAt: null,
          acknowledgedAt: null,
          executedAt: null,
          updatedAt: now
        });
        await this.notificationService.notifyCommandAvailable(cmd);
        break;
      }

      case 'REQUEST_TEMPORARY_APP_ACCESS': {
        if (!request.targetPackage) return;
        const duration = request.durationMinutes ?? 10;
        const grantId = randomUUID();
        const startsAt = now;
        const expiresAt = new Date(now.getTime() + duration * 60_000);

        const grant: TemporaryAppAccessGrantRecord = {
          id: grantId,
          sessionId: session.sessionId,
          deviceId: session.targetDeviceId,
          packageName: request.targetPackage,
          grantedDurationMinutes: duration,
          grantedByUserId: request.recipientUserId,
          startsAt,
          expiresAt,
          revokedAt: null,
          createdAt: now
        };
        await this.store.repositories.temporaryAppAccessGrants.create(grant);

        // Enqueue APPLY_TEMPORARY_APP_ACCESS command to target device
        const cmd = await this.store.repositories.commands.create({
          commandId: randomUUID(),
          sessionId: session.sessionId,
          targetDeviceId: session.targetDeviceId,
          issuedByUserId: request.recipientUserId,
          commandType: 'APPLY_TEMPORARY_APP_ACCESS',
          payload: {
            grantId,
            packageName: request.targetPackage,
            durationMinutes: duration,
            startsAtUtc: startsAt.toISOString(),
            expiresAtUtc: expiresAt.toISOString()
          },
          status: 'PENDING',
          idempotencyKey: `cmd_taag_${grantId}`,
          resultMetadata: null,
          failureReason: null,
          pushDeliveryStatus: 'NOT_ATTEMPTED',
          pushAttempts: 0,
          lastPushAttemptAt: null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + this.defaultCommandTtlSeconds * 1000),
          deliveredAt: null,
          acknowledgedAt: null,
          executedAt: null,
          updatedAt: now
        });
        await this.notificationService.notifyCommandAvailable(cmd);
        break;
      }

      case 'REQUEST_ADD_ALLOWED_APP':
      case 'REQUEST_REMOVE_BLOCKED_APP':
      case 'REQUEST_CHANGE_BLOCKING_MODE': {
        const nextRev = (await this.store.repositories.sessionRuleRevisions.getLatestRevisionNumber(session.sessionId)) + 1;
        const rev: SessionRuleRevisionRecord = {
          id: randomUUID(),
          sessionId: session.sessionId,
          revisionNumber: nextRev,
          modifiedByUserId: request.recipientUserId,
          ruleChanges: {
            requestType: request.requestType,
            targetPackage: request.targetPackage ?? null,
            parameters: request.parametersJson ?? null
          },
          appliedAt: now
        };
        await this.store.repositories.sessionRuleRevisions.create(rev);

        // Enqueue UPDATE_SESSION_RULES command
        const cmd = await this.store.repositories.commands.create({
          commandId: randomUUID(),
          sessionId: session.sessionId,
          targetDeviceId: session.targetDeviceId,
          issuedByUserId: request.recipientUserId,
          commandType: 'UPDATE_SESSION_RULES',
          payload: {
            revisionNumber: nextRev,
            ruleChanges: rev.ruleChanges
          },
          status: 'PENDING',
          idempotencyKey: `cmd_srr_${rev.id}`,
          resultMetadata: null,
          failureReason: null,
          pushDeliveryStatus: 'NOT_ATTEMPTED',
          pushAttempts: 0,
          lastPushAttemptAt: null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + this.defaultCommandTtlSeconds * 1000),
          deliveredAt: null,
          acknowledgedAt: null,
          executedAt: null,
          updatedAt: now
        });
        await this.notificationService.notifyCommandAvailable(cmd);
        break;
      }

      case 'REQUEST_SESSION_EXTENSION': {
        const extMinutes = request.durationMinutes ?? 15;
        const oldExpected = session.expectedEndAt ?? now;
        const newExpected = new Date(oldExpected.getTime() + extMinutes * 60_000);
        await this.store.repositories.sessions.updateStatusAndFields(session.sessionId, {
          expectedEndAt: newExpected,
          updatedAt: now
        });

        const cmd = await this.store.repositories.commands.create({
          commandId: randomUUID(),
          sessionId: session.sessionId,
          targetDeviceId: session.targetDeviceId,
          issuedByUserId: request.recipientUserId,
          commandType: 'UPDATE_SESSION_RULES',
          payload: {
            action: 'SESSION_EXTENSION',
            extendedByMinutes: extMinutes,
            newExpectedEndAtUtc: newExpected.toISOString()
          },
          status: 'PENDING',
          idempotencyKey: `cmd_ext_${request.id}`,
          resultMetadata: null,
          failureReason: null,
          pushDeliveryStatus: 'NOT_ATTEMPTED',
          pushAttempts: 0,
          lastPushAttemptAt: null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + this.defaultCommandTtlSeconds * 1000),
          deliveredAt: null,
          acknowledgedAt: null,
          executedAt: null,
          updatedAt: now
        });
        await this.notificationService.notifyCommandAvailable(cmd);
        break;
      }

      default:
        break;
    }
  }

  private async enrichMessage(msg: MessageRecord): Promise<SerializedMessage> {
    const sender = await this.store.repositories.users.findById(msg.senderUserId);
    let structuredReq: SerializedStructuredRequest | null = null;
    if (msg.messageType === 'STRUCTURED_REQUEST') {
      const found = await this.store.repositories.structuredRequests.findByMessageId(msg.id);
      if (found) {
        structuredReq = await this.serializeStructuredRequest(found);
      }
    }

    return {
      id: msg.id,
      conversationId: msg.conversationId,
      sender: sender ? toUserSummary(sender) : { id: msg.senderUserId, username: 'unknown', displayName: 'User', avatarUrl: null },
      clientMessageId: msg.clientMessageId,
      messageType: msg.messageType,
      textContent: msg.textContent,
      structuredRequest: structuredReq,
      status: msg.status,
      createdAt: msg.createdAt.toISOString(),
      updatedAt: msg.updatedAt.toISOString()
    };
  }

  private async serializeStructuredRequest(req: StructuredRequestRecord): Promise<SerializedStructuredRequest> {
    const initiator = await this.store.repositories.users.findById(req.initiatorUserId);
    const recipient = await this.store.repositories.users.findById(req.recipientUserId);

    return {
      id: req.id,
      messageId: req.messageId,
      conversationId: req.conversationId,
      requestType: req.requestType,
      initiator: initiator ? toUserSummary(initiator) : { id: req.initiatorUserId, username: 'unknown', displayName: 'User', avatarUrl: null },
      recipient: recipient ? toUserSummary(recipient) : { id: req.recipientUserId, username: 'unknown', displayName: 'User', avatarUrl: null },
      sessionId: req.sessionId,
      status: req.status,
      durationMinutes: req.durationMinutes,
      targetPackage: req.targetPackage,
      parameters: req.parametersJson,
      decisionReason: req.decisionReason,
      decidedAt: req.decidedAt?.toISOString() ?? null,
      expiresAt: req.expiresAt?.toISOString() ?? null,
      createdAt: req.createdAt.toISOString(),
      updatedAt: req.updatedAt.toISOString()
    };
  }
}

function formatRequestSummary(req: StructuredRequestRecord): string {
  switch (req.requestType) {
    case 'REQUEST_EARLY_RELEASE':
      return 'early release request';
    case 'REQUEST_TEMPORARY_APP_ACCESS':
      return `temporary access to ${req.targetPackage ?? 'app'} (${req.durationMinutes ?? 10} min)`;
    case 'REQUEST_ADD_ALLOWED_APP':
      return `request to allow ${req.targetPackage ?? 'app'}`;
    case 'REQUEST_REMOVE_BLOCKED_APP':
      return `request to unblock ${req.targetPackage ?? 'app'}`;
    case 'REQUEST_SESSION_EXTENSION':
      return `session extension (${req.durationMinutes ?? 15} min)`;
    default:
      return 'request';
  }
}
