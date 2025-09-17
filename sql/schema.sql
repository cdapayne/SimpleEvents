-- Evently Analytics MySQL schema
-- Run each statement in order (ensure database is created first)

CREATE TABLE IF NOT EXISTS accounts (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  plan ENUM('TRIAL','APP_SUMO_TIER1','APP_SUMO_TIER2','UNLIMITED') NOT NULL DEFAULT 'TRIAL',
  current_period_start DATETIME(6) NOT NULL,
  current_period_end DATETIME(6) NOT NULL,
  cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
  canceled_at DATETIME(6) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  role ENUM('owner','member') NOT NULL DEFAULT 'member',
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uniq_users_email (email),
  KEY idx_users_account (account_id),
  CONSTRAINT fk_users_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_keys (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  `key` VARCHAR(128) NOT NULL,
  label VARCHAR(255) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  disabled_at DATETIME(6) NULL,
  UNIQUE KEY uniq_api_keys_key (`key`),
  KEY idx_api_keys_account (account_id),
  CONSTRAINT fk_api_keys_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  app VARCHAR(120) NULL,
  type VARCHAR(255) NOT NULL,
  ts DATETIME(6) NOT NULL,
  user_id VARCHAR(255) NULL,
  session_id VARCHAR(255) NULL,
  properties JSON NULL,
  payload JSON NULL,
  source_ip VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY idx_events_account_ts (account_id, ts),
  KEY idx_events_account_type (account_id, type),
  CONSTRAINT fk_events_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reports (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  definition JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY idx_reports_account (account_id),
  CONSTRAINT fk_reports_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS plan_usage (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  period_start DATETIME(6) NOT NULL,
  period_end DATETIME(6) NOT NULL,
  events INT NOT NULL DEFAULT 0,
  events_ingested INT NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_plan_usage_account_period (account_id, period_start),
  CONSTRAINT fk_plan_usage_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS redemptions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  code VARCHAR(255) NOT NULL,
  redeemed_at DATETIME(6) NOT NULL,
  UNIQUE KEY uniq_redemptions_code (code),
  KEY idx_redemptions_account (account_id),
  CONSTRAINT fk_redemptions_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dashboard_items (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  report_id CHAR(36) NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'report',
  x INT NOT NULL,
  y INT NOT NULL,
  w INT NOT NULL,
  h INT NOT NULL,
  px_x DOUBLE NULL,
  px_y DOUBLE NULL,
  px_w DOUBLE NULL,
  px_h DOUBLE NULL,
  branding_title VARCHAR(255) NULL,
  branding_subtitle VARCHAR(255) NULL,
  branding_logo VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NULL,
  KEY idx_dashboard_items_account (account_id),
  KEY idx_dashboard_items_report (report_id),
  CONSTRAINT fk_dashboard_items_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_dashboard_items_report FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
