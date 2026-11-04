-- =============================================================================
-- Migration: 002_v04_partners_proposals_schedules.sql
-- Description: V0.4 Advanced Partners, Directional Approval Policies,
--              Versioned Arrest Proposals/Negotiations, and Scheduled Arrests
-- =============================================================================

ALTER TABLE users
  ADD COLUMN invite_code VARCHAR(24) NULL AFTER username,
  ADD UNIQUE KEY uq_users_invite_code (invite_code);

ALTER TABLE partner_permissions
  ADD COLUMN proposal_id CHAR(36) NULL AFTER target_device_id,
  ADD COLUMN approved_revision INT NULL AFTER proposal_id,
  ADD COLUMN exact_blocking_configuration JSON NULL AFTER blocking_config_limits;

CREATE TABLE IF NOT EXISTS partner_approval_policies (
  id CHAR(36) NOT NULL,
  owner_user_id CHAR(36) NOT NULL,
  partner_user_id CHAR(36) NOT NULL,
  require_approval_before_arrest TINYINT(1) NOT NULL DEFAULT 1,
  explicitly_configured TINYINT(1) NOT NULL DEFAULT 0,
  notes VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_approval_policy_direction (owner_user_id, partner_user_id),
  KEY idx_approval_policy_partner (partner_user_id),
  CONSTRAINT fk_approval_policy_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_approval_policy_partner FOREIGN KEY (partner_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS arrest_proposals (
  proposal_id CHAR(36) NOT NULL,
  partnership_id CHAR(36) NOT NULL,
  owner_user_id CHAR(36) NOT NULL,
  partner_user_id CHAR(36) NOT NULL,
  target_device_id CHAR(36) NOT NULL,
  proposer_user_id CHAR(36) NOT NULL,
  recipient_user_id CHAR(36) NOT NULL,
  request_type ENUM(
    'IMMEDIATE',
    'SCHEDULED',
    'RECURRING',
    'STANDING_AUTHORIZATION'
  ) NOT NULL,
  current_revision INT NOT NULL DEFAULT 1,
  status ENUM(
    'DRAFT',
    'PENDING',
    'COUNTEROFFERED',
    'APPROVED',
    'REJECTED',
    'CANCELLED',
    'EXPIRED'
  ) NOT NULL DEFAULT 'PENDING',
  normalized_configuration JSON NOT NULL,
  reason VARCHAR(500) NULL,
  approved_revision INT NULL,
  resulting_permission_id CHAR(36) NULL,
  resulting_session_id CHAR(36) NULL,
  resulting_schedule_id CHAR(36) NULL,
  idempotency_key VARCHAR(128) NULL,
  expires_at DATETIME(3) NOT NULL,
  responded_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (proposal_id),
  UNIQUE KEY uq_proposals_proposer_idem (proposer_user_id, idempotency_key),
  KEY idx_proposals_owner_status (owner_user_id, status, created_at),
  KEY idx_proposals_partner_status (partner_user_id, status, created_at),
  KEY idx_proposals_recipient_status (recipient_user_id, status, expires_at),
  KEY idx_proposals_partnership (partnership_id, status),
  CONSTRAINT fk_proposals_partnership FOREIGN KEY (partnership_id) REFERENCES partnerships (id) ON DELETE CASCADE,
  CONSTRAINT fk_proposals_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_proposals_partner FOREIGN KEY (partner_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_proposals_device FOREIGN KEY (target_device_id) REFERENCES devices (id) ON DELETE CASCADE,
  CONSTRAINT fk_proposals_proposer FOREIGN KEY (proposer_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_proposals_recipient FOREIGN KEY (recipient_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS arrest_proposal_revisions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  proposal_id CHAR(36) NOT NULL,
  revision_number INT NOT NULL,
  proposer_user_id CHAR(36) NOT NULL,
  recipient_user_id CHAR(36) NOT NULL,
  request_type ENUM(
    'IMMEDIATE',
    'SCHEDULED',
    'RECURRING',
    'STANDING_AUTHORIZATION'
  ) NOT NULL,
  normalized_configuration JSON NOT NULL,
  reason VARCHAR(500) NULL,
  status ENUM(
    'DRAFT',
    'PENDING',
    'COUNTEROFFERED',
    'APPROVED',
    'REJECTED',
    'CANCELLED',
    'EXPIRED'
  ) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_proposal_revision (proposal_id, revision_number),
  KEY idx_proposal_revisions_proposal (proposal_id, revision_number),
  CONSTRAINT fk_revisions_proposal FOREIGN KEY (proposal_id) REFERENCES arrest_proposals (proposal_id) ON DELETE CASCADE,
  CONSTRAINT fk_revisions_proposer FOREIGN KEY (proposer_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_revisions_recipient FOREIGN KEY (recipient_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS scheduled_arrests (
  schedule_id CHAR(36) NOT NULL,
  proposal_id CHAR(36) NULL,
  permission_id CHAR(36) NOT NULL,
  owner_user_id CHAR(36) NOT NULL,
  partner_user_id CHAR(36) NOT NULL,
  target_device_id CHAR(36) NOT NULL,
  schedule_type ENUM('SCHEDULED', 'RECURRING') NOT NULL,
  session_type ENUM('SELF_ARREST', 'PARTNER_ARREST', 'MUTUAL_ARREST') NOT NULL DEFAULT 'PARTNER_ARREST',
  goal VARCHAR(255) NOT NULL,
  duration_minutes INT NOT NULL,
  blocking_configuration JSON NOT NULL,
  timezone VARCHAR(64) NOT NULL,
  scheduled_start_at DATETIME(3) NULL,
  scheduled_end_at DATETIME(3) NULL,
  recurrence_rule JSON NULL,
  occurrences_completed INT NOT NULL DEFAULT 0,
  max_occurrences INT NULL,
  next_occurrence_at DATETIME(3) NULL,
  status ENUM(
    'ACTIVE',
    'PAUSED',
    'COMPLETED',
    'CANCELLED',
    'REVOKED',
    'EXPIRED'
  ) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (schedule_id),
  KEY idx_schedules_device_next (target_device_id, status, next_occurrence_at),
  KEY idx_schedules_owner_status (owner_user_id, status, created_at),
  KEY idx_schedules_partner_status (partner_user_id, status, created_at),
  KEY idx_schedules_permission (permission_id),
  CONSTRAINT fk_schedules_proposal FOREIGN KEY (proposal_id) REFERENCES arrest_proposals (proposal_id) ON DELETE SET NULL,
  CONSTRAINT fk_schedules_permission FOREIGN KEY (permission_id) REFERENCES partner_permissions (permission_id) ON DELETE CASCADE,
  CONSTRAINT fk_schedules_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_schedules_partner FOREIGN KEY (partner_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_schedules_device FOREIGN KEY (target_device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
