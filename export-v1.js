#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * V1.x Data Exporter
 *
 * Reads directly from a v1.x Pryv.io system (MongoDB + SQLite + filesystem)
 * and writes data in Plan 21 backup format via FilesystemBackupWriter.
 *
 * Usage:
 *   node export-v1.js <path-to-v1-config.yml> <output-dir>
 *
 * The config must be the v1.x api.yml (or equivalent) with database and
 * userFiles settings.
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const SQLite3 = require('better-sqlite3');
const YAML = require('yaml');
const { createFilesystemBackupWriter } = require('./lib/backup/FilesystemBackupWriter');
const { sanitize } = require('./lib/backup/sanitize');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node export-v1.js <v1-config.yml> <output-dir> [--register-dir <path>]');
  process.exit(1);
}

const configPath = path.resolve(args[0]);
const outputDir = path.resolve(args[1]);
let registerDir = null;
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--register-dir' && args[i + 1]) {
    registerDir = path.resolve(args[++i]);
  }
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

function loadConfig (filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const config = YAML.parse(raw);
  return {
    database: {
      host: config.database?.host || '127.0.0.1',
      port: config.database?.port || 27017,
      name: config.database?.name || 'pryv-node',
      authUser: config.database?.authUser || '',
      authPassword: config.database?.authPassword || '',
      engine: config.database?.engine || 'mongodb'
    },
    userFilesPath: config.userFiles?.path || config.eventFiles?.attachmentsDirPath,
    storageUserIndex: config.storageUserIndex?.engine || 'sqlite',
    storageUserAccount: config.storageUserAccount?.engine || 'sqlite',
    dnsLess: config.dnsLess || {},
    http: config.http || {}
  };
}

// ---------------------------------------------------------------------------
// User directory path (mirrors v1.x userLocalDirectory.js)
// ---------------------------------------------------------------------------

function getUserDirPath (basePath, userId) {
  if (!userId || userId.length < 3) throw new Error('Invalid userId: ' + userId);
  const dir1 = userId.substr(userId.length - 1, 1);
  const dir2 = userId.substr(userId.length - 2, 1);
  const dir3 = userId.substr(userId.length - 3, 1);
  return path.join(basePath, dir1, dir2, dir3, userId);
}

// ---------------------------------------------------------------------------
// Register data (for username resolution in enterprise setups)
// ---------------------------------------------------------------------------

/**
 * Load register users.jsonl.gz to build userId→username map.
 * Register data contains { id, username, email, ... } per user.
 */
function loadRegisterUsernames (regDir) {
  const zlib = require('zlib');
  const usersFile = path.join(regDir, 'users.jsonl.gz');
  if (!fs.existsSync(usersFile)) {
    const plain = path.join(regDir, 'users.jsonl');
    if (!fs.existsSync(plain)) return null;
    const content = fs.readFileSync(plain, 'utf8');
    return parseRegisterUsers(content);
  }
  const content = zlib.gunzipSync(fs.readFileSync(usersFile)).toString('utf8');
  return parseRegisterUsers(content);
}

function parseRegisterUsers (content) {
  const map = {}; // userId → username
  for (const line of content.trim().split('\n')) {
    if (!line) continue;
    const obj = JSON.parse(line);
    // Skip entries with invalid/missing userId (e.g. id="0", legacy data)
    if (obj.id && obj.username && obj.id.length > 3) {
      map[obj.id] = obj.username;
    }
  }
  return Object.keys(map).length > 0 ? map : null;
}

// ---------------------------------------------------------------------------
// User enumeration
// ---------------------------------------------------------------------------

async function getAllUsers (config, db) {
  if (config.storageUserIndex === 'mongodb') {
    const users = await getAllUsersMongo(db);
    if (Object.keys(users).length > 0) return users;
    // Fallback: id4name collection empty, try SQLite
    console.log('  (id4name collection empty, falling back to SQLite)');
  }

  // Try SQLite user-index.db
  const sqliteUsers = getAllUsersSQLite(config.userFilesPath);
  if (sqliteUsers) return sqliteUsers;

  // Try register data (if --register-dir provided or register/ exists in output)
  const regMap = tryLoadRegisterMap();
  if (regMap) {
    console.log(`  (using register data for user enumeration: ${Object.keys(regMap).length} users)`);
    return regMap;
  }

  // Last resort: enumerate from distinct userId in events collection
  console.log('  (no user index found, enumerating from MongoDB events.distinct("userId"))');
  return getAllUsersFallback(db);
}

/**
 * Try to load register data for username resolution.
 * Checks --register-dir, then outputDir/register/.
 */
function tryLoadRegisterMap () {
  const dirs = [registerDir, path.join(outputDir, 'register')].filter(Boolean);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const idToName = loadRegisterUsernames(dir);
    if (idToName) {
      // Convert to {username: userId} format
      const users = {};
      for (const [userId, username] of Object.entries(idToName)) {
        users[username] = userId;
      }
      return users;
    }
  }
  return null;
}

async function getAllUsersMongo (db) {
  const col = db.collection('id4name');
  const cursor = col.find({});
  const users = {};
  for await (const doc of cursor) {
    users[doc.username] = doc.userId;
  }
  return users;
}

function getAllUsersSQLite (basePath) {
  const dbPath = path.join(basePath, 'user-index.db');
  if (!fs.existsSync(dbPath)) return null;
  const sqlDb = new SQLite3(dbPath, { readonly: true });
  let rows;
  try {
    rows = sqlDb.prepare('SELECT username, userId FROM id4name').all();
  } catch (e) {
    sqlDb.close();
    return null;
  }
  sqlDb.close();
  if (rows.length === 0) return null;
  const users = {};
  for (const row of rows) {
    users[row.username] = row.userId;
  }
  return users;
}

/**
 * Fallback: enumerate users from distinct userId values in events/accesses.
 * If register data available, resolves real usernames; otherwise uses userId.
 */
async function getAllUsersFallback (db) {
  const userIds = await db.collection('events').distinct('userId');
  // Also check accesses for users with no events
  const accessUserIds = await db.collection('accesses').distinct('userId');
  const allIds = new Set([...userIds, ...accessUserIds]);

  // Try to resolve usernames from register data
  let idToName = null;
  const dirs = [registerDir, path.join(outputDir, 'register')].filter(Boolean);
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      idToName = loadRegisterUsernames(dir);
      if (idToName) break;
    }
  }

  const users = {};
  let resolved = 0;
  for (const userId of allIds) {
    if (!userId) continue;
    const username = idToName?.[userId] || userId;
    if (username !== userId) resolved++;
    users[username] = userId;
  }
  console.log(`  (found ${Object.keys(users).length} users via fallback, ${resolved} usernames resolved from register)`);
  return users;
}

// ---------------------------------------------------------------------------
// Account data reading
// ---------------------------------------------------------------------------

async function readAccountData (config, db, userId, basePath) {
  if (config.storageUserAccount === 'mongodb') {
    return readAccountDataMongo(db, userId);
  } else {
    return readAccountDataSQLite(userId, basePath);
  }
}

async function readAccountDataMongo (db, userId) {
  // Passwords
  const passwordsCursor = db.collection('passwords').find({ userId }).sort({ time: 1 });
  const passwords = [];
  for await (const doc of passwordsCursor) {
    passwords.push({ hash: doc.hash, time: doc.time, createdBy: doc.createdBy });
  }

  // Key-value store
  const kvCursor = db.collection('stores-key-value').find({ userId });
  const storeKeyValues = [];
  for await (const doc of kvCursor) {
    storeKeyValues.push({ storeId: doc.storeId, key: doc.key, value: doc.value });
  }

  return { passwords, storeKeyValues };
}

function readAccountDataSQLite (userId, basePath) {
  const userDir = getUserDirPath(basePath, userId);
  const dbPath = path.join(userDir, 'account-1.0.0.sqlite');

  const result = { passwords: [], storeKeyValues: [] };

  if (!fs.existsSync(dbPath)) return result;

  const sqlDb = new SQLite3(dbPath, { readonly: true });

  try {
    const pwRows = sqlDb.prepare('SELECT time, hash, createdBy FROM passwords ORDER BY time ASC').all();
    result.passwords = pwRows;
  } catch (e) {
    // Table may not exist
  }

  try {
    const kvRows = sqlDb.prepare('SELECT storeId, key, value FROM storeKeyValueData').all();
    result.storeKeyValues = kvRows;
  } catch (e) {
    // Table may not exist
  }

  sqlDb.close();
  return result;
}

// ---------------------------------------------------------------------------
// MongoDB collection readers (async generators for memory efficiency)
// ---------------------------------------------------------------------------

async function * readCollection (db, collectionName, userId) {
  const col = db.collection(collectionName);
  const cursor = col.find({ userId });
  for await (const doc of cursor) {
    yield sanitize(doc);
  }
}

async function * readEvents (db, userId) {
  yield * readCollection(db, 'events', userId);
}

async function * readStreams (db, userId) {
  yield * readCollection(db, 'streams', userId);
}

async function * readAccesses (db, userId) {
  yield * readCollection(db, 'accesses', userId);
}

async function * readProfile (db, userId) {
  yield * readCollection(db, 'profile', userId);
}

async function * readWebhooks (db, userId) {
  yield * readCollection(db, 'webhooks', userId);
}

async function * readFollowedSlices (db, userId) {
  yield * readCollection(db, 'followedSlices', userId);
}

// ---------------------------------------------------------------------------
// Attachment export
// ---------------------------------------------------------------------------

async function exportAttachments (userWriter, basePath, userId) {
  const userDir = getUserDirPath(basePath, userId);
  const attachDir = path.join(userDir, 'attachments');

  if (!fs.existsSync(attachDir)) return;

  const eventDirs = fs.readdirSync(attachDir, { withFileTypes: true });
  for (const eventEntry of eventDirs) {
    if (!eventEntry.isDirectory()) continue;
    const eventId = eventEntry.name;
    const eventAttachDir = path.join(attachDir, eventId);
    const files = fs.readdirSync(eventAttachDir, { withFileTypes: true });
    for (const fileEntry of files) {
      if (!fileEntry.isFile()) continue;
      const fileId = fileEntry.name;
      const readStream = fs.createReadStream(path.join(eventAttachDir, fileId));
      await userWriter.writeAttachment(eventId, fileId, readStream);
    }
  }
}

// ---------------------------------------------------------------------------
// Audit export (per-user SQLite)
// ---------------------------------------------------------------------------

async function * readAudit (basePath, userId) {
  const userDir = getUserDirPath(basePath, userId);
  if (!fs.existsSync(userDir)) return;

  const files = fs.readdirSync(userDir).filter(f => f.startsWith('audit-') && f.endsWith('.sqlite'));
  for (const file of files) {
    const dbPath = path.join(userDir, file);
    const sqlDb = new SQLite3(dbPath, { readonly: true });
    try {
      const rows = sqlDb.prepare('SELECT * FROM audit').all();
      for (const row of rows) {
        // Parse JSON fields if present
        const item = { ...row };
        if (typeof item.content === 'string') {
          try { item.content = JSON.parse(item.content); } catch (e) { /* keep as string */ }
        }
        yield item;
      }
    } catch (e) {
      // audit table may not exist in some files
    }
    sqlDb.close();
  }
}

// ---------------------------------------------------------------------------
// Platform data export
// ---------------------------------------------------------------------------

async function * readPlatformData (config) {
  const dbPath = path.join(config.userFilesPath, 'platform-wide.db');
  if (!fs.existsSync(dbPath)) return;

  const sqlDb = new SQLite3(dbPath, { readonly: true });
  try {
    const rows = sqlDb.prepare('SELECT key, value FROM keyValue').all();
    for (const row of rows) {
      yield { key: row.key, value: row.value };
    }
  } catch (e) {
    // Table may not exist
  }
  sqlDb.close();
}

// ---------------------------------------------------------------------------
// Main export flow
// ---------------------------------------------------------------------------

async function main () {
  const config = loadConfig(configPath);
  console.log('Loaded config from:', configPath);
  console.log('  Database:', config.database.name, '@', config.database.host + ':' + config.database.port);
  console.log('  User files:', config.userFilesPath);
  console.log('  User index engine:', config.storageUserIndex);
  console.log('  User account engine:', config.storageUserAccount);

  // Connect to MongoDB
  let authStr = '';
  if (config.database.authUser) {
    authStr = encodeURIComponent(config.database.authUser) + ':' + encodeURIComponent(config.database.authPassword) + '@';
  }
  const mongoUrl = `mongodb://${authStr}${config.database.host}:${config.database.port}`;
  console.log('\nConnecting to MongoDB...');
  const client = new MongoClient(mongoUrl);
  await client.connect();
  const db = client.db(config.database.name);
  console.log('Connected.');

  // Enumerate users
  console.log('\nEnumerating users...');
  const usersByName = await getAllUsers(config, db);
  const userCount = Object.keys(usersByName).length;
  console.log(`Found ${userCount} users.`);

  // Create backup writer
  const writer = createFilesystemBackupWriter(outputDir, { compress: true });
  const userManifests = [];
  let userIndex = 0;

  for (const [username, userId] of Object.entries(usersByName)) {
    userIndex++;
    console.log(`\n[${userIndex}/${userCount}] Exporting user: ${username} (${userId})`);

    const userWriter = await writer.openUser(userId, username);

    // Events
    process.stdout.write('  events...');
    await userWriter.writeEvents(readEvents(db, userId));
    console.log(' done');

    // Streams
    process.stdout.write('  streams...');
    await userWriter.writeStreams(readStreams(db, userId));
    console.log(' done');

    // Accesses
    process.stdout.write('  accesses...');
    await userWriter.writeAccesses(readAccesses(db, userId));
    console.log(' done');

    // Profile
    process.stdout.write('  profile...');
    await userWriter.writeProfile(readProfile(db, userId));
    console.log(' done');

    // Webhooks
    process.stdout.write('  webhooks...');
    await userWriter.writeWebhooks(readWebhooks(db, userId));
    console.log(' done');

    // Account data (passwords + key-value store)
    process.stdout.write('  account...');
    const accountData = await readAccountData(config, db, userId, config.userFilesPath);
    await userWriter.writeAccountData(accountData);
    console.log(' done');

    // Attachments
    process.stdout.write('  attachments...');
    await exportAttachments(userWriter, config.userFilesPath, userId);
    console.log(' done');

    // Audit
    process.stdout.write('  audit...');
    await userWriter.writeAudit(readAudit(config.userFilesPath, userId));
    console.log(' done');

    const userManifest = await userWriter.close();
    userManifests.push(userManifest);

    console.log(`  Stats: ${JSON.stringify(userManifest.stats)}`);
  }

  // Platform data
  console.log('\nExporting platform data...');
  await writer.writePlatformData(readPlatformData(config));
  console.log('Done.');

  // Write manifest
  await writer.writeManifest({
    coreVersion: '1.9.x-export',
    config: {
      engine: 'mongodb',
      domain: config.dnsLess?.publicUrl || 'unknown'
    },
    userManifests,
    backupType: 'full',
    backupTimestamp: Date.now()
  });

  await writer.close();
  await client.close();

  console.log(`\nExport complete! Backup written to: ${outputDir}`);
  console.log(`Total users exported: ${userCount}`);
}

main().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
