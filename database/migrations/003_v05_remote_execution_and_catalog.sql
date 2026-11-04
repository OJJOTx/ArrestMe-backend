-- ============================================================================
-- ArrestMe Backend — V0.5 Migration: Remote Arrest Execution, Scheduling & App Catalog
-- Compatible with MySQL 8.0+ / MariaDB on Hostinger
-- ============================================================================

CREATE TABLE IF NOT EXISTS device_app_catalogs (
  device_id CHAR(36) NOT NULL,
  owner_user_id CHAR(36) NOT NULL,
  apps_json JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (device_id),
  KEY idx_device_app_catalogs_owner (owner_user_id),
  CONSTRAINT fk_device_app_catalogs_device
    FOREIGN KEY (device_id) REFERENCES devices (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_device_app_catalogs_owner
    FOREIGN KEY (owner_user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE scheduled_arrests
  ADD COLUMN IF NOT EXISTS last_materialized_session_id CHAR(36) NULL AFTER next_occurrence_at,
  ADD COLUMN IF NOT EXISTS last_materialized_at DATETIME(3) NULL AFTER last_materialized_session_id;
