-- Migration 004: V0.6 Full Chat, Structured Requests, and Live Session Modifications
-- Directional partner chat, rich requests in conversation, temporary app access overrides, and live rule changes

CREATE TABLE IF NOT EXISTS conversations (
  id VARCHAR(36) PRIMARY KEY,
  partnership_id VARCHAR(36) NOT NULL UNIQUE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_message_at TIMESTAMP(3) NULL,
  CONSTRAINT fk_conversations_partnership FOREIGN KEY (partnership_id) REFERENCES partnerships(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  joined_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_read_message_id VARCHAR(36) NULL,
  last_read_at TIMESTAMP(3) NULL,
  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT fk_cm_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_cm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  sender_user_id VARCHAR(36) NOT NULL,
  client_message_id VARCHAR(64) NOT NULL,
  message_type ENUM('TEXT', 'STRUCTURED_REQUEST', 'SYSTEM_EVENT') NOT NULL DEFAULT 'TEXT',
  text_content TEXT NULL,
  structured_payload JSON NULL,
  status ENUM('SENT', 'DELIVERED', 'READ') NOT NULL DEFAULT 'SENT',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uk_messages_client_msg (conversation_id, client_message_id),
  INDEX idx_messages_conv_created (conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS structured_requests (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL UNIQUE,
  conversation_id VARCHAR(36) NOT NULL,
  request_type ENUM(
    'REQUEST_EARLY_RELEASE',
    'REQUEST_TEMPORARY_APP_ACCESS',
    'REQUEST_ADD_ALLOWED_APP',
    'REQUEST_REMOVE_BLOCKED_APP',
    'REQUEST_CHANGE_BLOCKING_MODE',
    'REQUEST_SESSION_EXTENSION',
    'REQUEST_SCHEDULE_CHANGE',
    'REQUEST_CUSTOM_ACTION'
  ) NOT NULL,
  initiator_user_id VARCHAR(36) NOT NULL,
  recipient_user_id VARCHAR(36) NOT NULL,
  session_id VARCHAR(36) NULL,
  status ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
  duration_minutes INT NULL,
  target_package VARCHAR(255) NULL,
  parameters_json JSON NULL,
  decision_reason VARCHAR(500) NULL,
  decided_at TIMESTAMP(3) NULL,
  expires_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_sr_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_initiator FOREIGN KEY (initiator_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_recipient FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_session FOREIGN KEY (session_id) REFERENCES arrest_sessions(id) ON DELETE SET NULL,
  INDEX idx_sr_conv_status (conversation_id, status),
  INDEX idx_sr_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS temporary_app_access_grants (
  id VARCHAR(36) PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  device_id VARCHAR(36) NOT NULL,
  package_name VARCHAR(255) NOT NULL,
  granted_duration_minutes INT NOT NULL,
  granted_by_user_id VARCHAR(36) NOT NULL,
  starts_at TIMESTAMP(3) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  revoked_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_taag_session FOREIGN KEY (session_id) REFERENCES arrest_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_taag_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_taag_grantor FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_taag_session_pkg (session_id, package_name),
  INDEX idx_taag_device_exp (device_id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_rule_revisions (
  id VARCHAR(36) PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  revision_number INT NOT NULL,
  modified_by_user_id VARCHAR(36) NOT NULL,
  rule_changes JSON NOT NULL,
  applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_srr_session FOREIGN KEY (session_id) REFERENCES arrest_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_srr_modifier FOREIGN KEY (modified_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uk_srr_session_rev (session_id, revision_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE commands MODIFY COLUMN command_type ENUM(
  'START_ARREST',
  'REQUEST_RELEASE',
  'APPROVE_RELEASE',
  'DENY_RELEASE',
  'END_SESSION',
  'SYNC_SESSION',
  'APPLY_TEMPORARY_APP_ACCESS',
  'REVOKE_TEMPORARY_APP_ACCESS',
  'UPDATE_SESSION_RULES'
) NOT NULL;
