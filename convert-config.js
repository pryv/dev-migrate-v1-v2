#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * V1.x → V2 Config Converter
 *
 * Reads a v1.x api.yml config and produces a v2-compatible config file.
 *
 * Usage:
 *   node convert-config.js <v1-config.yml> [output.yml]
 *
 * If output is omitted, prints to stdout.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node convert-config.js <v1-config.yml> [output.yml]');
  process.exit(1);
}

const configPath = path.resolve(args[0]);
const outputPath = args[1] ? path.resolve(args[1]) : null;

// ---------------------------------------------------------------------------
// Load v1 config
// ---------------------------------------------------------------------------

const raw = fs.readFileSync(configPath, 'utf8');
const v1 = YAML.parse(raw);

// ---------------------------------------------------------------------------
// Build v2 config
// ---------------------------------------------------------------------------

const v2 = {};

// dnsLess — keep as-is
if (v1.dnsLess) {
  v2.dnsLess = { ...v1.dnsLess };
}

// reporting
if (v1.reporting) {
  v2.reporting = { ...v1.reporting };
}

// http — keep port/ip, add new v2 ports
v2.http = {
  ip: v1.http?.ip || '127.0.0.1',
  port: v1.http?.port || 3000,
  hfsPort: 4000,
  previewsPort: 3001
};

// --- Storages (v2 structure) ---
v2.storages = {
  base: { engine: 'mongodb' },
  platform: { engine: 'sqlite' },
  series: { engine: 'influxdb' },
  file: { engine: 'filesystem' },
  audit: { engine: 'sqlite' },
  engines: {
    mongodb: {
      authUser: v1.database?.authUser || '',
      authPassword: v1.database?.authPassword || '',
      host: v1.database?.host || '127.0.0.1',
      port: v1.database?.port || 27017,
      name: v1.database?.name || 'pryv-node',
      connectTimeoutMS: v1.database?.connectTimeoutMS || 60000,
      socketTimeoutMS: v1.database?.socketTimeoutMS || 60000
    },
    sqlite: {
      path: v1.userFiles?.path || 'REPLACE ME'
    },
    filesystem: {
      attachmentsDirPath: v1.eventFiles?.attachmentsDirPath || v1.userFiles?.path || 'REPLACE ME',
      previewsDirPath: v1.eventFiles?.previewsDirPath || 'REPLACE ME'
    },
    influxdb: {
      host: v1.influxdb?.host || '127.0.0.1',
      port: v1.influxdb?.port || 8086
    }
  }
};

// If v1 had SQLite events engine, note it (v2 doesn't have SQLite for base)
if (v1.database?.engine === 'sqlite') {
  v2._migration_notes = v2._migration_notes || [];
  v2._migration_notes.push('v1 used SQLite for events — v2 uses MongoDB or PostgreSQL. Data was exported to backup format.');
}

// eventFiles
if (v1.eventFiles) {
  v2.eventFiles = {};
  if (v1.eventFiles.previewsCacheMaxAge) v2.eventFiles.previewsCacheMaxAge = v1.eventFiles.previewsCacheMaxAge;
  if (v1.eventFiles.previewsCacheCleanUpCronTime) v2.eventFiles.previewsCacheCleanUpCronTime = v1.eventFiles.previewsCacheCleanUpCronTime;
}

// auth — keep as-is
if (v1.auth) {
  v2.auth = { ...v1.auth };
}

// customExtensions
if (v1.customExtensions) {
  v2.customExtensions = { ...v1.customExtensions };
}

// updates
if (v1.updates) {
  v2.updates = { ...v1.updates };
}

// webhooks
if (v1.webhooks) {
  v2.webhooks = { ...v1.webhooks };
}

// versioning
if (v1.versioning) {
  v2.versioning = { ...v1.versioning };
}

// user-account
if (v1['user-account']) {
  v2['user-account'] = { ...v1['user-account'] };
}

// custom.systemStreams → same location in v2
if (v1.custom) {
  v2.custom = { ...v1.custom };
}

// caching
if (v1.caching) {
  v2.caching = { ...v1.caching };
}

// logs
if (v1.logs) {
  v2.logs = { ...v1.logs };
}

// uploads
if (v1.uploads) {
  v2.uploads = { ...v1.uploads };
}

// trace
if (v1.trace) {
  v2.trace = { ...v1.trace };
}

// integrity
if (v1.integrity) {
  v2.integrity = { ...v1.integrity };
}

// accessTracking
if (v1.accessTracking) {
  v2.accessTracking = { ...v1.accessTracking };
}

// --- New v2 settings (defaults) ---

// Cluster config (new in v2)
v2.cluster = {
  apiWorkers: 2,
  hfsWorkers: 1,
  previewsWorker: true,
  runMigrations: true
};

// Core identity (new in v2 — single core default)
v2.core = {
  id: 'single',
  available: true
};

// Audit (new in v2)
v2.audit = {
  active: true,
  storage: {
    filter: {
      methods: { include: ['all'], exclude: [] }
    }
  }
};

// --- Strip v1-only settings ---
// These don't exist in v2:
// - openSource, backwardCompatibility, axonMessaging
// We simply don't include them.

// ---------------------------------------------------------------------------
// Remove settings that are v1-only (not copied above)
// ---------------------------------------------------------------------------
// backwardCompatibility.systemStreams.prefix, backwardCompatibility.tags
// axonMessaging — replaced by cluster + tcpBroker
// openSource — removed in v2

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Add header comment
const header = `# V2 configuration — converted from v1.x config
# Source: ${configPath}
# Converted: ${new Date().toISOString()}
#
# REVIEW BEFORE USE:
# - Verify all 'REPLACE ME' values
# - Adjust cluster.apiWorkers / hfsWorkers for your hardware
# - storages.engines.sqlite.path must point to the user data directory
# - storages.engines.filesystem paths must be set
`;

const yamlStr = YAML.stringify(v2, { lineWidth: 120 });
const output = header + '\n' + yamlStr;

if (outputPath) {
  fs.writeFileSync(outputPath, output);
  console.log('V2 config written to:', outputPath);
} else {
  process.stdout.write(output);
}
