-- Serial Activation System — D1 Schema
-- Run once: wrangler d1 execute serial-activation-db --file=schema.sql

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  code            TEXT    NOT NULL UNIQUE,  -- short prefix used in serials, e.g. THINE, AVE
  is_subscription INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS serials (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  serial                  TEXT    NOT NULL UNIQUE,
  product_id              INTEGER NOT NULL REFERENCES products(id),
  customer_email          TEXT    NOT NULL,
  stripe_payment_id       TEXT,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  max_activations         INTEGER NOT NULL DEFAULT 2,
  is_active               INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_id    INTEGER NOT NULL REFERENCES serials(id),
  machine_id   TEXT    NOT NULL,
  activated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT,   -- NULL = lifetime, ISO date string = subscription
  last_checkin TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(serial_id, machine_id)
);

CREATE INDEX IF NOT EXISTS idx_serials_serial    ON serials(serial);
CREATE INDEX IF NOT EXISTS idx_serials_stripe_sub ON serials(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_activations_serial ON activations(serial_id);

-- -----------------------------------------------------------------------
-- Add your products here after applying the schema.
-- is_subscription: 0 = one-time lifetime, 1 = recurring subscription
-- -----------------------------------------------------------------------
-- INSERT INTO products (name, code, is_subscription) VALUES ('Test App',  'TEST',  0);
-- INSERT INTO products (name, code, is_subscription) VALUES ('Thine',     'THINE', 0);
-- INSERT INTO products (name, code, is_subscription) VALUES ('Ave',       'AVE',   1);
