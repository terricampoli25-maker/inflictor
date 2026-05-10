-- The Inflictor — Stage 4 migration
-- Run with: wrangler d1 execute inflictor-db --file=schema_v2.sql
-- (append --local for dev)

ALTER TABLE settings ADD COLUMN avatar_color TEXT DEFAULT '#d4af37';
ALTER TABLE settings ADD COLUMN font_style   TEXT DEFAULT 'classic';
