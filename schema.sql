-- The Inflictor — D1 Database Schema
-- All tables provisioned from Stage 1

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT    PRIMARY KEY NOT NULL,
  username              TEXT    UNIQUE NOT NULL,
  email                 TEXT    UNIQUE,
  password_hash         TEXT    NOT NULL,
  is_guest              INTEGER NOT NULL DEFAULT 0,
  premium_status        TEXT    NOT NULL DEFAULT 'free',  -- 'free' | 'trial' | 'premium'
  premium_expires_at    TEXT,
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT    PRIMARY KEY NOT NULL,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT    UNIQUE NOT NULL,
  expires_at TEXT    NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  user_id              TEXT    PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  theme                TEXT    NOT NULL DEFAULT 'light',
  wake_time            TEXT    NOT NULL DEFAULT '07:00',
  sound_enabled        INTEGER NOT NULL DEFAULT 1,
  notification_enabled INTEGER NOT NULL DEFAULT 0,
  notification_repeat  INTEGER NOT NULL DEFAULT 1,
  week_start_day       INTEGER NOT NULL DEFAULT 0,   -- 0=Sunday 1=Monday
  avatar_color         TEXT             DEFAULT '#d4af37',
  font_style           TEXT             DEFAULT 'classic',
  cheer_enabled        INTEGER NOT NULL DEFAULT 1,
  aww_enabled          INTEGER NOT NULL DEFAULT 1,
  avatar_data          TEXT,
  week_view            TEXT    NOT NULL DEFAULT 'rolling', -- rolling (today first) | calendar (Sun–Sat)
  report_frequency     TEXT    NOT NULL DEFAULT 'off',  -- off / daily / weekly (scheduled email)
  tz_offset            INTEGER,                          -- JS getTimezoneOffset() so the cron fires at the user's local evening
  report_last_sent     TEXT,                             -- YYYY-MM-DD of the last scheduled send (dedupe)
  report_meds          INTEGER NOT NULL DEFAULT 1,       -- meds/reminders in reports (privacy-display meds show their discreet label)
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT    PRIMARY KEY NOT NULL,
  user_id        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  color          TEXT    NOT NULL DEFAULT '#d4af37',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weekly_schedules (
  id            TEXT PRIMARY KEY NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start    TEXT NOT NULL,                        -- ISO date of week's first day
  schedule_data TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, week_start)
);

CREATE TABLE IF NOT EXISTS daily_schedules (
  id            TEXT PRIMARY KEY NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  schedule_data TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS task_logs (
  id              TEXT PRIMARY KEY NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  task_id         TEXT,
  task_name       TEXT NOT NULL,
  scheduled_start TEXT,
  scheduled_end   TEXT,
  status          TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
  logged_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS history (
  id               TEXT    PRIMARY KEY NOT NULL,
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date             TEXT    NOT NULL,
  summary_data     TEXT    NOT NULL DEFAULT '{}',
  tasks_completed  INTEGER NOT NULL DEFAULT 0,
  tasks_failed     INTEGER NOT NULL DEFAULT 0,
  notes            TEXT    NOT NULL DEFAULT '',
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date)
);

-- Per-activity memos (and pause notes) — synced so they survive reinstalls/devices.
CREATE TABLE IF NOT EXISTS memos (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  item_id    TEXT NOT NULL,                      -- activity id, or a pause-note key
  content    TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date, item_id)
);

-- Rate limiting — fixed-window counters keyed `bucket:id:windowStart`. Throttles brute-force logins,
-- signup/email spam, and endpoint hammering. Not tied to a user (keyed by IP/username/account id).
CREATE TABLE IF NOT EXISTS rate_limits (
  k          TEXT    PRIMARY KEY NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token        ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_memos_user_date       ON memos(user_id, date);
CREATE INDEX IF NOT EXISTS idx_sessions_user         ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user            ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_weekly_user           ON weekly_schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_user_date       ON daily_schedules(user_id, date);
CREATE INDEX IF NOT EXISTS idx_notes_user_date       ON notes(user_id, date);
CREATE INDEX IF NOT EXISTS idx_task_logs_user_date   ON task_logs(user_id, date);
CREATE INDEX IF NOT EXISTS idx_history_user_date     ON history(user_id, date);
CREATE INDEX IF NOT EXISTS idx_pw_reset_token        ON password_resets(token);
