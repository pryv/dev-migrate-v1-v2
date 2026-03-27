#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Docker E2E test for the v1→v2 migration pipeline.
 *
 * Assumes:
 * - A v1.x Docker instance is running on localhost:3033 (API)
 * - MongoDB is exposed on localhost:27033
 *
 * Steps:
 * 1. Create test users and data via the v1 API
 * 2. Run the exporter against the Docker MongoDB
 * 3. Verify backup archive
 * 4. Compare backup data with what was created via API
 * 5. Run config converter
 * 6. Verify converted config is valid v2 YAML
 *
 * Usage:
 *   node test-docker-e2e.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { MongoClient } = require('mongodb');
const { execSync } = require('child_process');

const API_URL = 'http://localhost:3033';
const MONGO_URL = 'mongodb://127.0.0.1:27033';
const DB_NAME = 'pryv-node';
const BACKUP_DIR = '/tmp/test-docker-e2e-' + Date.now();

let failures = 0;
let passes = 0;

function assert (condition, message) {
  if (!condition) {
    console.error('  FAIL:', message);
    failures++;
  } else {
    console.log('  OK:', message);
    passes++;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function apiRequest (method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, API_URL);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * API request with retry — the v1.x Docker image crashes on audit syslog
 * after certain operations. We wait and retry on connection reset.
 */
async function apiRequestRetry (method, urlPath, body, headers = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await apiRequest(method, urlPath, body, headers);
    } catch (e) {
      if (attempt < retries && (e.code === 'ECONNRESET' || e.code === 'ECONNREFUSED')) {
        console.log(`    (connection error, waiting for API restart... attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main () {
  console.log('Docker E2E Migration Test');
  console.log('=========================\n');

  // Check API is reachable
  try {
    const res = await apiRequestRetry('GET', '/');
    assert(res.body.meta?.apiVersion === '1.9.3-open', `v1 API is running (${res.body.meta?.apiVersion})`);
  } catch (e) {
    console.error('FATAL: Cannot reach v1 API at', API_URL, e.message);
    process.exit(1);
  }

  // =========================================================================
  // STEP 1: Create test users and data
  // =========================================================================
  console.log('\n=== Step 1: Create test data via v1 API ===');

  // Create user
  const username = 'migtest-' + Date.now();
  const password = 'TestPass123!';
  const email = username + '@test.pryv.io';

  const createRes = await apiRequestRetry('POST', '/users', {
    appId: 'pryv-test',
    username,
    password,
    email,
    languageCode: 'en'
  });
  assert(createRes.status === 201 || createRes.body.username === username,
    `user created: ${username} (status: ${createRes.status})`);

  // Login to get personal token — v1 API uses /:username/auth/login
  // Origin header required for trustedApps check
  const loginRes = await apiRequestRetry('POST', `/${username}/auth/login`, {
    username,
    password,
    appId: 'pryv-test'
  }, { Origin: API_URL });
  const token = loginRes.body?.token;
  assert(token != null, `got personal token: ${token?.substring(0, 10)}...`);

  if (!token) {
    console.error('FATAL: Cannot login. Body:', JSON.stringify(loginRes.body));
    process.exit(1);
  }

  // v1 API routes are all /:username/...
  const userPath = `/${username}`;

  // Create streams
  const stream1Res = await apiRequestRetry('POST', `${userPath}/streams`, {
    id: 'test-stream-1',
    name: 'Test Stream 1'
  }, { Authorization: token });
  assert(stream1Res.body.stream != null, 'stream 1 created');

  const stream2Res = await apiRequestRetry('POST', `${userPath}/streams`, {
    id: 'test-stream-2',
    name: 'Test Stream 2',
    parentId: 'test-stream-1'
  }, { Authorization: token });
  assert(stream2Res.body.stream != null, 'stream 2 (child) created');

  // Create events
  const createdEvents = [];
  for (let i = 0; i < 5; i++) {
    const evRes = await apiRequestRetry('POST', `${userPath}/events`, {
      streamIds: ['test-stream-1'],
      type: 'note/txt',
      content: `Migration test event #${i}`
    }, { Authorization: token });
    if (evRes.body.event) createdEvents.push(evRes.body.event);
  }
  assert(createdEvents.length === 5, `created ${createdEvents.length} events`);

  // Create a numerical event
  const numRes = await apiRequestRetry('POST', `${userPath}/events`, {
    streamIds: ['test-stream-2'],
    type: 'mass/kg',
    content: 75.5
  }, { Authorization: token });
  if (numRes.body.event) createdEvents.push(numRes.body.event);
  assert(numRes.body.event != null, 'numerical event created');

  // Create an event with attachment (multipart — skip for simplicity, use API)
  // Instead, verify the data exists in MongoDB
  const totalEvents = createdEvents.length;

  // Create a shared access
  const accessRes = await apiRequestRetry('POST', `${userPath}/accesses`, {
    name: 'test-shared-access',
    type: 'shared',
    permissions: [{ streamId: 'test-stream-1', level: 'read' }]
  }, { Authorization: token });
  assert(accessRes.body.access != null, 'shared access created');

  console.log(`\n  Summary: user=${username}, streams=2, events=${totalEvents}, accesses=1 (shared)`);

  // =========================================================================
  // STEP 2: Export via our toolkit
  // =========================================================================
  console.log('\n=== Step 2: Run exporter against Docker MongoDB ===');

  // Create a config that points to the Docker MongoDB (host-side port 27033)
  // userFiles path: the mounted volume on host for SQLite + attachments
  const exportConfigPath = '/tmp/docker-e2e-export-config.yml';
  const hostVarPryv = '/tmp/pryv-docker-test/var-pryv/api';
  const exportConfig = `
database:
  engine: mongodb
  host: 127.0.0.1
  port: 27033
  name: ${DB_NAME}
userFiles:
  path: ${hostVarPryv}
storageUserIndex:
  engine: sqlite
storageUserAccount:
  engine: sqlite
dnsLess:
  publicUrl: ${API_URL}
`;
  fs.writeFileSync(exportConfigPath, exportConfig);

  const exportCmd = `node ${path.join(__dirname, 'export-v1.js')} ${exportConfigPath} ${BACKUP_DIR}`;
  console.log('  Running:', exportCmd);
  const output = execSync(exportCmd, { encoding: 'utf8', timeout: 60000 });
  console.log(output);

  // =========================================================================
  // STEP 3: Verify backup archive
  // =========================================================================
  console.log('=== Step 3: Verify backup archive ===');

  const manifestPath = path.join(BACKUP_DIR, 'manifest.json');
  assert(fs.existsSync(manifestPath), 'manifest.json exists');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(manifest.formatVersion === 1, 'format version is 1');
  assert(manifest.users.length >= 1, `manifest has ${manifest.users.length} user(s)`);

  // Find our test user in the manifest (by username since id4name may be in SQLite)
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);

  const userManifest = manifest.users.find(u => u.username === username);
  assert(userManifest != null, 'test user found in backup manifest');
  const userId = userManifest?.userId;
  assert(userId != null, `found userId for ${username}: ${userId}`);

  if (!userManifest || !userId) {
    console.error('FATAL: Cannot find test user in backup. Aborting.');
    await client.close();
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    process.exit(1);
  }

  // +2 for system streams (created automatically by v1)
  assert(userManifest.stats.streams >= 2, `streams in backup: ${userManifest.stats.streams} (>= 2)`);
  assert(userManifest.stats.events >= totalEvents, `events in backup: ${userManifest.stats.events} (>= ${totalEvents})`);
  assert(userManifest.stats.accesses >= 2, `accesses in backup: ${userManifest.stats.accesses} (>= 2: personal + shared)`);

  // =========================================================================
  // STEP 4: Verify data content
  // =========================================================================
  console.log('\n=== Step 4: Verify exported data content ===');

  const userDir = path.join(BACKUP_DIR, 'users', userId);

  // Events
  const eventsDir = path.join(userDir, 'events');
  const exportedEvents = readAllChunked(eventsDir, 'events');
  assert(exportedEvents.length >= totalEvents,
    `exported events: ${exportedEvents.length} (>= ${totalEvents})`);

  // Check our test events are present
  const testEventContents = exportedEvents
    .filter(e => typeof e.content === 'string' && e.content.startsWith('Migration test event'))
    .map(e => e.content);
  assert(testEventContents.length === 5, `found ${testEventContents.length}/5 test note events`);

  // Check numerical event
  const numEvents = exportedEvents.filter(e => e.type === 'mass/kg' && e.content === 75.5);
  assert(numEvents.length === 1, 'numerical event preserved (mass/kg = 75.5)');

  // No internal fields
  const hasInternal = exportedEvents.some(e => e._id || e.userId || e.__v);
  assert(!hasInternal, 'no internal fields leaked in events');

  // Streams
  const exportedStreams = readJsonlGz(path.join(userDir, 'streams.jsonl.gz'));
  const testStreams = exportedStreams.filter(s =>
    s.streamId === 'test-stream-1' || s.streamId === 'test-stream-2'
  );
  assert(testStreams.length === 2, `found ${testStreams.length}/2 test streams`);

  // Verify parent-child relationship
  const stream2 = exportedStreams.find(s => s.streamId === 'test-stream-2');
  assert(stream2?.parentId === 'test-stream-1', 'stream hierarchy preserved');

  // Accesses
  const exportedAccesses = readJsonlGz(path.join(userDir, 'accesses.jsonl.gz'));
  const sharedAccess = exportedAccesses.find(a => a.name === 'test-shared-access');
  assert(sharedAccess != null, 'shared access found in backup');
  if (sharedAccess) {
    assert(sharedAccess.type === 'shared', 'access type is shared');
    assert(Array.isArray(sharedAccess.permissions), 'access has permissions array');
  }

  // Account data
  const accountData = readJsonlGz(path.join(userDir, 'account.jsonl.gz'));
  assert(accountData.length === 1, 'account data present');
  assert(accountData[0].passwords?.length >= 1, `passwords exported: ${accountData[0].passwords?.length}`);
  // Verify bcrypt hash format
  const firstHash = accountData[0].passwords[0]?.hash;
  assert(firstHash?.startsWith('$2'), `password hash is bcrypt: ${firstHash?.substring(0, 4)}...`);

  // =========================================================================
  // STEP 5: Test config converter
  // =========================================================================
  console.log('\n=== Step 5: Config converter ===');

  const v1ConfigPath = '/tmp/pryv-docker-test/configs/api.yml';
  const v2ConfigPath = '/tmp/docker-e2e-v2-config.yml';
  execSync(`node ${path.join(__dirname, 'convert-config.js')} ${v1ConfigPath} ${v2ConfigPath}`, { encoding: 'utf8' });
  assert(fs.existsSync(v2ConfigPath), 'v2 config file created');

  const YAML = require('yaml');
  const v2Config = YAML.parse(fs.readFileSync(v2ConfigPath, 'utf8'));
  assert(v2Config.storages?.engines?.mongodb?.host === 'open-pryv-mongo', 'MongoDB host preserved');
  assert(v2Config.storages?.engines?.mongodb?.port === 27017, 'MongoDB port preserved');
  assert(v2Config.storages?.engines?.mongodb?.name === 'pryv-node', 'MongoDB name preserved');
  assert(v2Config.cluster?.apiWorkers === 2, 'cluster config added');
  assert(v2Config.http?.port === 3000, 'HTTP port preserved');

  // =========================================================================
  // STEP 6: Cross-validate with MongoDB
  // =========================================================================
  console.log('\n=== Step 6: Cross-validate export vs MongoDB ===');

  // Count events in MongoDB for this user
  const mongoEventCount = await db.collection('events').countDocuments({ userId });
  assert(exportedEvents.length === mongoEventCount,
    `event count match: export=${exportedEvents.length} mongo=${mongoEventCount}`);

  const mongoStreamCount = await db.collection('streams').countDocuments({ userId });
  assert(exportedStreams.length === mongoStreamCount,
    `stream count match: export=${exportedStreams.length} mongo=${mongoStreamCount}`);

  const mongoAccessCount = await db.collection('accesses').countDocuments({ userId });
  assert(exportedAccesses.length === mongoAccessCount,
    `access count match: export=${exportedAccesses.length} mongo=${mongoAccessCount}`);

  // =========================================================================
  // Cleanup & Summary
  // =========================================================================
  await client.close();
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  fs.rmSync(exportConfigPath, { force: true });
  fs.rmSync(v2ConfigPath, { force: true });

  console.log('\n========================================');
  console.log(`  Passed: ${passes}`);
  console.log(`  Failed: ${failures}`);
  if (failures === 0) {
    console.log('  ALL TESTS PASSED');
  } else {
    console.log(`  ${failures} TEST(S) FAILED`);
  }
  console.log('========================================');
  process.exit(failures > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonlGz (filePath) {
  if (!fs.existsSync(filePath)) return [];
  const buffer = zlib.gunzipSync(fs.readFileSync(filePath));
  return buffer.toString('utf8').trim().split('\n')
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l));
}

function readAllChunked (dir, baseName) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(baseName + '-') && f.endsWith('.jsonl.gz'))
    .sort();
  const all = [];
  for (const file of files) {
    all.push(...readJsonlGz(path.join(dir, file)));
  }
  return all;
}

main().catch(err => {
  console.error('Docker E2E test failed:', err);
  process.exit(1);
});
