'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(dir, 'gymflow.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Every gym is a tenant. All other tables carry gym_id.
CREATE TABLE IF NOT EXISTS gyms (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0ea5e9',
  capacity INTEGER NOT NULL DEFAULT 50,      -- comfortable max people at once
  stay_hours REAL NOT NULL DEFAULT 3,        -- auto check-out after this long
  admin_salt TEXT NOT NULL,
  admin_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,                        -- printed as QR, also used to log in
  plan TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (gym_id, phone),
  UNIQUE (gym_id, code)
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  coach TEXT,
  starts_at INTEGER NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 15
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (class_id, member_id)
);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  in_at INTEGER NOT NULL,
  out_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_visits_gym_in ON visits (gym_id, in_at);
CREATE INDEX IF NOT EXISTS idx_visits_open ON visits (gym_id, out_at);
CREATE INDEX IF NOT EXISTS idx_classes_gym_start ON classes (gym_id, starts_at);
`);

module.exports = db;
