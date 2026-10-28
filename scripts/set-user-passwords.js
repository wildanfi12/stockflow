#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, scrypt: scryptCallback } = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(scryptCallback);
const dataFile = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'howell-stockflow.db');
const credentialsFile = process.argv[2];

async function main() {
  if (!credentialsFile) throw new Error('Usage: node scripts/set-user-passwords.js /path/to/credentials.json');
  const credentialsPath = path.resolve(credentialsFile);
  const stat = fs.statSync(credentialsPath);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Credentials file must be private (chmod 600).');
  }
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  if (!Array.isArray(credentials) || credentials.length !== 4) {
    throw new Error('Credentials must include exactly admin, faiz, nick, and aris.');
  }
  const expected = new Set(['admin', 'faiz', 'nick', 'aris']);
  const seen = new Set();
  const prepared = [];
  for (const entry of credentials) {
    const username = String(entry.username || '').trim().toLowerCase();
    const password = String(entry.password || '');
    if (!expected.has(username) || seen.has(username)) throw new Error('Unexpected or duplicate username in credentials file.');
    if (password.length < 16 || password.length > 256) throw new Error(`Password for ${username} must have 16–256 characters.`);
    seen.add(username);
    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
    prepared.push({ username, salt, hash });
  }
  if (seen.size !== expected.size) throw new Error('Credentials are missing one or more required accounts.');

  const db = new DatabaseSync(dataFile);
  try {
    db.exec('BEGIN IMMEDIATE');
    const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
    if (!userCols.has('password_salt')) db.exec('ALTER TABLE users ADD COLUMN password_salt TEXT');
    if (!userCols.has('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
    const update = db.prepare('UPDATE users SET password_salt=?,password_hash=?,active=1 WHERE username=?');
    for (const row of prepared) {
      const result = update.run(row.salt, row.hash, row.username);
      if (Number(result.changes) !== 1) throw new Error(`Account ${row.username} is missing or ambiguous.`);
    }
    const sessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_sessions'").get();
    if (sessions) db.exec('DELETE FROM auth_sessions');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
  console.log('Password hashes saved for admin, faiz, nick, and aris.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
