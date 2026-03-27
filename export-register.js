#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * V1.x Service-Register Exporter
 *
 * Reads user→core mappings and user profiles from the service-register's
 * Redis database and writes them to the backup archive.
 *
 * Usage:
 *   node export-register.js <output-dir> [options]
 *
 * Options:
 *   --redis-host HOST      Redis host (default: 127.0.0.1)
 *   --redis-port PORT      Redis port (default: 6379)
 *   --redis-password PASS  Redis password (default: none)
 *   --no-compress          Disable gzip
 *
 * Output: writes register/ directory inside <output-dir> with:
 *   register/users.jsonl.gz     — user profile hashes
 *   register/servers.jsonl.gz   — username→core mappings
 *   register/emails.jsonl.gz    — email→username indexes
 *   register/manifest.json      — summary
 *
 * Can be used standalone or as part of docker-migrate.sh.
 * The output is compatible with Plan 21 backup format conventions.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const redis = require('redis');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const opts = {
  redisHost: '127.0.0.1',
  redisPort: 6379,
  redisPassword: null,
  compress: true,
  outputDir: null
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--redis-host': opts.redisHost = args[++i]; break;
    case '--redis-port': opts.redisPort = parseInt(args[++i], 10); break;
    case '--redis-password': opts.redisPassword = args[++i]; break;
    case '--no-compress': opts.compress = false; break;
    case '--help':
    case '-h':
      console.log('Usage: node export-register.js <output-dir> [--redis-host HOST] [--redis-port PORT] [--redis-password PASS] [--no-compress]');
      process.exit(0);
      break;
    default:
      if (!opts.outputDir) opts.outputDir = path.resolve(args[i]);
      else { console.error('Unknown argument:', args[i]); process.exit(1); }
  }
}

if (!opts.outputDir) {
  console.error('Usage: node export-register.js <output-dir> [options]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeJsonlFile (filePath, items, compress) {
  const lines = items.map(item => JSON.stringify(item));
  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  const buffer = Buffer.from(content, 'utf8');
  if (compress) {
    fs.writeFileSync(filePath, zlib.gzipSync(buffer));
  } else {
    fs.writeFileSync(filePath, buffer);
  }
  return items.length;
}

function jsonlFileName (baseName, compress) {
  return compress ? baseName + '.jsonl.gz' : baseName + '.jsonl';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main () {
  console.log('Service-Register Exporter');
  console.log('  Redis:', opts.redisHost + ':' + opts.redisPort);
  console.log('  Output:', opts.outputDir);

  // Connect to Redis
  const client = redis.createClient({
    socket: {
      host: opts.redisHost,
      port: opts.redisPort
    },
    password: opts.redisPassword || undefined
  });
  client.on('error', (err) => console.error('Redis error:', err.message));
  await client.connect();
  console.log('Connected to Redis.');

  const registerDir = path.join(opts.outputDir, 'register');
  fs.mkdirSync(registerDir, { recursive: true });

  // --- Export user profiles ---
  console.log('\nExporting user profiles...');
  const userKeys = [];
  for await (const key of client.scanIterator({ MATCH: '*:users', COUNT: 100 })) {
    userKeys.push(key);
  }

  const users = [];
  for (const key of userKeys) {
    const data = await client.hGetAll(key);
    if (data && Object.keys(data).length > 0) {
      users.push(data);
    }
  }
  const usersFile = path.join(registerDir, jsonlFileName('users', opts.compress));
  writeJsonlFile(usersFile, users, opts.compress);
  console.log(`  ${users.length} user profiles exported`);

  // --- Export server/core mappings ---
  console.log('Exporting server mappings...');
  const serverKeys = [];
  for await (const key of client.scanIterator({ MATCH: '*:server', COUNT: 100 })) {
    serverKeys.push(key);
  }

  const servers = [];
  for (const key of serverKeys) {
    const username = key.replace(/:server$/, '');
    const server = await client.get(key);
    if (server) {
      servers.push({ username, server });
    }
  }
  const serversFile = path.join(registerDir, jsonlFileName('servers', opts.compress));
  writeJsonlFile(serversFile, servers, opts.compress);
  console.log(`  ${servers.length} server mappings exported`);

  // --- Export email indexes ---
  console.log('Exporting email indexes...');
  const emailKeys = [];
  for await (const key of client.scanIterator({ MATCH: '*:email', COUNT: 100 })) {
    emailKeys.push(key);
  }

  const emails = [];
  for (const key of emailKeys) {
    const email = key.replace(/:email$/, '');
    const username = await client.get(key);
    if (username) {
      emails.push({ email, username });
    }
  }
  const emailsFile = path.join(registerDir, jsonlFileName('emails', opts.compress));
  writeJsonlFile(emailsFile, emails, opts.compress);
  console.log(`  ${emails.length} email indexes exported`);

  // --- Export invitation tokens ---
  console.log('Exporting invitation tokens...');
  const invitationKeys = [];
  for await (const key of client.scanIterator({ MATCH: '*:invitation', COUNT: 100 })) {
    invitationKeys.push(key);
  }

  const invitations = [];
  for (const key of invitationKeys) {
    const token = key.replace(/:invitation$/, '');
    const data = await client.hGetAll(key);
    if (data && Object.keys(data).length > 0) {
      invitations.push({ token, ...data });
    }
  }
  const invitationsFile = path.join(registerDir, jsonlFileName('invitations', opts.compress));
  writeJsonlFile(invitationsFile, invitations, opts.compress);
  console.log(`  ${invitations.length} invitation tokens exported`);

  // --- Write manifest ---
  const manifest = {
    exportTimestamp: Date.now(),
    stats: {
      users: users.length,
      servers: servers.length,
      emails: emails.length,
      invitations: invitations.length
    }
  };
  fs.writeFileSync(path.join(registerDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  await client.disconnect();

  console.log('\nRegister export complete!');
  console.log(`  Users: ${users.length}`);
  console.log(`  Server mappings: ${servers.length}`);
  console.log(`  Email indexes: ${emails.length}`);
  console.log(`  Invitations: ${invitations.length}`);
  console.log(`  Output: ${registerDir}`);
}

main().catch(err => {
  console.error('Register export failed:', err);
  process.exit(1);
});
