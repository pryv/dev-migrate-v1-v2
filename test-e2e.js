#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * End-to-end test for the v1→v2 migration pipeline.
 *
 * Steps:
 * 1. Snapshot the current MongoDB data (counts + sample docs per collection)
 * 2. Run the exporter → backup archive
 * 3. Verify backup archive structure and data integrity
 * 4. Clear user data from v2
 * 5. Restore from backup archive
 * 6. Compare restored data with original snapshot
 *
 * Usage:
 *   node test-e2e.js <v1-config.yml>
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { MongoClient } = require('mongodb');
const YAML = require('yaml');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node test-e2e.js <v1-config.yml>');
  process.exit(1);
}

const configPath = path.resolve(args[0]);
const backupDir = '/tmp/test-e2e-migration-' + Date.now();
const raw = fs.readFileSync(configPath, 'utf8');
const config = YAML.parse(raw);

const COLLECTIONS = ['events', 'streams', 'accesses', 'profile', 'webhooks'];
let failures = 0;

function assert (condition, message) {
  if (!condition) {
    console.error('  FAIL:', message);
    failures++;
  } else {
    console.log('  OK:', message);
  }
}

async function main () {
  // Connect to MongoDB
  const mongoUrl = `mongodb://${config.database?.host || '127.0.0.1'}:${config.database?.port || 27017}`;
  const client = new MongoClient(mongoUrl);
  await client.connect();
  const db = client.db(config.database?.name || 'pryv-node');

  // Get all users
  const usersMap = {};
  const cursor = db.collection('id4name').find({});
  for await (const doc of cursor) {
    usersMap[doc.username] = doc.userId;
  }
  const userIds = Object.values(usersMap);
  const usernames = Object.keys(usersMap);

  console.log(`\nFound ${userIds.length} user(s): ${usernames.join(', ')}\n`);

  // =========================================================================
  // STEP 1: Snapshot original data
  // =========================================================================
  console.log('=== Step 1: Snapshot original data ===');
  const snapshots = {};

  for (const userId of userIds) {
    snapshots[userId] = {};
    for (const col of COLLECTIONS) {
      const docs = await db.collection(col).find({ userId }).toArray();
      snapshots[userId][col] = docs;
      console.log(`  ${col}: ${docs.length} docs`);
    }
    // Passwords
    const passwords = await db.collection('passwords').find({ userId }).sort({ time: 1 }).toArray();
    snapshots[userId].passwords = passwords;
    console.log(`  passwords: ${passwords.length} docs`);

    // Key-value store
    const kv = await db.collection('stores-key-value').find({ userId }).toArray();
    snapshots[userId].storeKeyValues = kv;
    console.log(`  stores-key-value: ${kv.length} docs`);
  }

  // =========================================================================
  // STEP 2: Export
  // =========================================================================
  console.log('\n=== Step 2: Run exporter ===');
  const { execSync } = require('child_process');
  const exportCmd = `node ${path.join(__dirname, 'export-v1.js')} ${configPath} ${backupDir}`;
  console.log('  Command:', exportCmd);
  const exportOutput = execSync(exportCmd, { encoding: 'utf8', timeout: 60000 });
  console.log(exportOutput);

  // =========================================================================
  // STEP 3: Verify backup archive
  // =========================================================================
  console.log('=== Step 3: Verify backup archive ===');

  // Check manifest
  const manifestPath = path.join(backupDir, 'manifest.json');
  assert(fs.existsSync(manifestPath), 'manifest.json exists');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(manifest.formatVersion === 1, 'format version is 1');
  assert(manifest.backupType === 'full', 'backup type is full');
  assert(manifest.users.length === userIds.length, `manifest has ${userIds.length} user(s)`);

  for (const userId of userIds) {
    const userDir = path.join(backupDir, 'users', userId);
    assert(fs.existsSync(userDir), `user dir exists for ${userId}`);

    // Check user manifest
    const userManifest = JSON.parse(fs.readFileSync(path.join(userDir, 'user-manifest.json'), 'utf8'));
    assert(userManifest.userId === userId, 'user manifest userId matches');

    // Compare counts with snapshot
    const snap = snapshots[userId];
    assert(userManifest.stats.events === snap.events.length,
      `events count: backup=${userManifest.stats.events} original=${snap.events.length}`);
    assert(userManifest.stats.streams === snap.streams.length,
      `streams count: backup=${userManifest.stats.streams} original=${snap.streams.length}`);
    assert(userManifest.stats.accesses === snap.accesses.length,
      `accesses count: backup=${userManifest.stats.accesses} original=${snap.accesses.length}`);

    // Verify exported data content
    console.log('\n  Verifying data content...');

    // Events: check all IDs are preserved
    const eventsDir = path.join(userDir, 'events');
    const exportedEvents = await readAllChunked(eventsDir, 'events');
    const originalEventIds = new Set(snap.events.map(e => e._id.toString()));
    const exportedEventIds = new Set(exportedEvents.map(e => e.id));
    assert(originalEventIds.size === exportedEventIds.size,
      `event IDs: original=${originalEventIds.size} exported=${exportedEventIds.size}`);
    // Check no internal fields leaked
    const hasInternalFields = exportedEvents.some(e => e._id || e.userId || e.__v);
    assert(!hasInternalFields, 'no internal fields (_id, userId, __v) in exported events');

    // Streams: check streamIds preserved
    const exportedStreams = await readJsonlGz(path.join(userDir, 'streams.jsonl.gz'));
    const originalStreamIds = new Set(snap.streams.map(s => s.streamId));
    const exportedStreamIds = new Set(exportedStreams.map(s => s.streamId));
    assert(originalStreamIds.size === exportedStreamIds.size,
      `stream IDs: original=${originalStreamIds.size} exported=${exportedStreamIds.size}`);
    // Verify streams don't have _id leak
    const streamsHaveInternal = exportedStreams.some(s => s._id || s.userId);
    assert(!streamsHaveInternal, 'no internal fields in exported streams');

    // Accesses: check tokens preserved
    const exportedAccesses = await readJsonlGz(path.join(userDir, 'accesses.jsonl.gz'));
    const originalTokens = new Set(snap.accesses.map(a => a.token).filter(Boolean));
    const exportedTokens = new Set(exportedAccesses.map(a => a.token).filter(Boolean));
    assert(originalTokens.size === exportedTokens.size,
      `access tokens: original=${originalTokens.size} exported=${exportedTokens.size}`);

    // Account data: check password count
    const exportedAccount = await readJsonlGz(path.join(userDir, 'account.jsonl.gz'));
    const accountData = exportedAccount[0];
    assert(accountData.passwords.length === snap.passwords.length,
      `passwords: original=${snap.passwords.length} exported=${accountData.passwords.length}`);
    // Verify password hashes match
    const originalHashes = snap.passwords.map(p => p.hash).sort();
    const exportedHashes = accountData.passwords.map(p => p.hash).sort();
    assert(JSON.stringify(originalHashes) === JSON.stringify(exportedHashes),
      'password hashes match exactly');
  }

  // =========================================================================
  // STEP 4: Clear and restore
  // =========================================================================
  console.log('\n=== Step 4: Clear user data and restore ===');

  for (const userId of userIds) {
    // Clear user data from all collections
    for (const col of COLLECTIONS) {
      await db.collection(col).deleteMany({ userId });
    }
    await db.collection('passwords').deleteMany({ userId });
    await db.collection('stores-key-value').deleteMany({ userId });
    // Don't delete from id4name — the restore expects the user to exist or will re-add

    // Verify cleared
    for (const col of COLLECTIONS) {
      const count = await db.collection(col).countDocuments({ userId });
      assert(count === 0, `${col} cleared (count=${count})`);
    }
  }

  // Now we need to restore. We can't use the full v2 restore orchestrator
  // (it requires boiler/storages init) but we CAN re-import via direct MongoDB
  // to validate the data round-trips correctly.
  console.log('\n  Restoring via direct MongoDB import...');

  for (const userId of userIds) {
    const userDir = path.join(backupDir, 'users', userId);

    // Re-import events
    const events = await readAllChunked(path.join(userDir, 'events'), 'events');
    if (events.length > 0) {
      const eventDocs = events.map(e => ({
        ...e,
        _id: e.id,
        userId
      }));
      // Remove the exported 'id' field — MongoDB uses _id
      for (const doc of eventDocs) { delete doc.id; }
      await db.collection('events').insertMany(eventDocs);
    }

    // Re-import streams (canonical id → MongoDB streamId)
    const streams = await readJsonlGz(path.join(userDir, 'streams.jsonl.gz'));
    if (streams.length > 0) {
      const streamDocs = streams.map(s => {
        const doc = { ...s, userId };
        if (doc.id != null && doc.streamId == null) {
          doc.streamId = doc.id;
          delete doc.id;
        }
        return doc;
      });
      await db.collection('streams').insertMany(streamDocs);
    }

    // Re-import accesses (canonical id → MongoDB _id)
    const accesses = await readJsonlGz(path.join(userDir, 'accesses.jsonl.gz'));
    if (accesses.length > 0) {
      const accessDocs = accesses.map(a => ({
        ...a,
        _id: a.id,
        userId
      }));
      for (const doc of accessDocs) { delete doc.id; }
      await db.collection('accesses').insertMany(accessDocs);
    }

    // Re-import profile (canonical id → MongoDB profileId)
    const profileItems = await readJsonlGz(path.join(userDir, 'profile.jsonl.gz'));
    if (profileItems.length > 0) {
      const profileDocs = profileItems.map(p => {
        const doc = { ...p, userId };
        if (doc.id != null && doc.profileId == null) {
          doc.profileId = doc.id;
          delete doc.id;
        }
        return doc;
      });
      await db.collection('profile').insertMany(profileDocs);
    }

    // Re-import webhooks
    const webhookItems = await readJsonlGz(path.join(userDir, 'webhooks.jsonl.gz'));
    if (webhookItems.length > 0) {
      const webhookDocs = webhookItems.map(w => ({ ...w, userId }));
      await db.collection('webhooks').insertMany(webhookDocs);
    }

    // Re-import passwords
    const account = (await readJsonlGz(path.join(userDir, 'account.jsonl.gz')))[0];
    if (account && account.passwords.length > 0) {
      const pwDocs = account.passwords.map(p => ({ ...p, userId }));
      await db.collection('passwords').insertMany(pwDocs);
    }

    console.log(`  Restored user ${userId}: events=${events.length} streams=${streams.length} accesses=${accesses.length}`);
  }

  // =========================================================================
  // STEP 5: Verify restored data matches original
  // =========================================================================
  console.log('\n=== Step 5: Verify restored data ===');

  for (const userId of userIds) {
    const snap = snapshots[userId];

    for (const col of COLLECTIONS) {
      const restored = await db.collection(col).find({ userId }).toArray();
      assert(restored.length === snap[col].length,
        `${col}: restored=${restored.length} original=${snap[col].length}`);
    }

    // Passwords
    const restoredPw = await db.collection('passwords').find({ userId }).sort({ time: 1 }).toArray();
    assert(restoredPw.length === snap.passwords.length,
      `passwords: restored=${restoredPw.length} original=${snap.passwords.length}`);

    // Verify key fields match for events
    const originalEvents = snap.events;
    const restoredEvents = await db.collection('events').find({ userId }).toArray();
    const origById = new Map(originalEvents.map(e => [e._id.toString(), e]));

    let eventFieldMismatches = 0;
    for (const re of restoredEvents) {
      const orig = origById.get(re._id.toString());
      if (!orig) {
        eventFieldMismatches++;
        continue;
      }
      // Check critical fields
      if (String(orig.type) !== String(re.type)) eventFieldMismatches++;
      if (orig.time !== re.time) eventFieldMismatches++;
      if (JSON.stringify(orig.streamIds) !== JSON.stringify(re.streamIds)) eventFieldMismatches++;
    }
    assert(eventFieldMismatches === 0,
      `event data integrity: ${eventFieldMismatches} mismatches out of ${restoredEvents.length}`);

    // Verify access tokens match
    const originalAccesses = snap.accesses;
    const restoredAccesses = await db.collection('accesses').find({ userId }).toArray();
    const origTokens = new Set(originalAccesses.map(a => a.token).filter(Boolean));
    const restTokens = new Set(restoredAccesses.map(a => a.token).filter(Boolean));
    assert(origTokens.size === restTokens.size,
      `access tokens preserved: ${restTokens.size}/${origTokens.size}`);
    for (const t of origTokens) {
      if (!restTokens.has(t)) {
        assert(false, `token "${t}" missing after restore`);
      }
    }
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('\n========================================');
  if (failures === 0) {
    console.log('ALL TESTS PASSED');
  } else {
    console.log(`${failures} TEST(S) FAILED`);
  }
  console.log('========================================');

  // Cleanup
  fs.rmSync(backupDir, { recursive: true, force: true });
  await client.close();
  process.exit(failures > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonlGz (filePath) {
  if (!fs.existsSync(filePath)) return [];
  const buffer = zlib.gunzipSync(fs.readFileSync(filePath));
  return buffer.toString('utf8').trim().split('\n')
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l));
}

async function readAllChunked (dir, baseName) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(baseName + '-') && f.endsWith('.jsonl.gz'))
    .sort();
  const all = [];
  for (const file of files) {
    const items = await readJsonlGz(path.join(dir, file));
    all.push(...items);
  }
  return all;
}

main().catch(err => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
