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

const PLACEHOLDER = 'REPLACE ME';

/**
 * Build a v2 config object from a parsed v1 config.
 * @param {object} v1 - parsed v1 config
 * @returns {{ config: object, notes: string[] }} the v2 config and the review
 *   notes to print in the output header
 */
function convert (v1) {
  v1 = v1 || {};
  const v2 = {};
  const notes = [];

  // --- dnsLess / dns ---
  // v2 refuses a config that sets dns.domain without an explicit
  // dnsLess.isActive, and dnsLess.isActive defaults to true: always write it.
  const v1Domain = v1.dns?.domain;
  let dnsLessActive;
  if (typeof v1.dnsLess?.isActive === 'boolean') {
    dnsLessActive = v1.dnsLess.isActive;
  } else if (v1.dnsLess?.publicUrl) {
    dnsLessActive = true;
  } else {
    dnsLessActive = !v1Domain;
  }
  v2.dnsLess = { ...(v1.dnsLess || {}), isActive: dnsLessActive };
  if (dnsLessActive && !v2.dnsLess.publicUrl) {
    v2.dnsLess.publicUrl = PLACEHOLDER;
  }
  if (v1.dns) {
    v2.dns = { ...v1.dns };
  }
  if (!dnsLessActive) {
    notes.push('dnsLess.isActive is false: per-user subdomains need dns.domain plus an embedded DNS ' +
      '(dns.active: true on a core) or an external DNS. Review the dns block.');
  }

  // reporting
  if (v1.reporting) {
    v2.reporting = { ...v1.reporting };
  }

  // http: keep ip/port (and TLS files), add the v2 ports
  v2.http = {
    ip: v1.http?.ip || '127.0.0.1',
    port: v1.http?.port || 3000,
    hfsPort: 4000,
    previewsPort: 3001
  };
  if (v1.http?.ssl) {
    v2.http.ssl = { ...v1.http.ssl };
  }

  // --- Storages (v2 structure) ---
  // v2 has no MongoDB engine: user data goes to PostgreSQL (the v2 default;
  // SQLite is the alternative) and is restored from the backup archive.
  v2.storages = {
    base: { engine: 'postgresql' },
    platform: { engine: 'rqlite' },
    series: { engine: 'postgresql' },
    file: { engine: 'filesystem' },
    audit: { engine: 'sqlite' },
    engines: {
      postgresql: {
        host: '127.0.0.1',
        port: 5432,
        database: 'pryv-node',
        user: 'pryv',
        password: PLACEHOLDER
      },
      // storages.engines.sqlite.path is left out on purpose, see the note below
      filesystem: {
        previewsDirPath: v1.eventFiles?.previewsDirPath || PLACEHOLDER
      }
    }
  };
  // The v2 user data directory (storages.engines.sqlite.path) has the same
  // layout as the v1 userFiles.path (<base>/<c>/<b>/<a>/<userId>/, with the
  // event attachments under it), but v2 must not share the v1 tree: the v1
  // data reaches v2 through the backup archive, and the restore writes each
  // user's files there after clearing them (--overwrite). Left out, v2 uses
  // its default (var-pryv/users in the install directory).
  notes.push('storages.engines.sqlite.path (v2 user data directory: per-user databases and event attachments) is left out, ' +
    'so v2 uses its default var-pryv/users in the install directory; with Docker set it to a mounted path, ' +
    'e.g. /app/data/users. Do not point it at the v1 userFiles.path' +
    (v1.userFiles?.path ? ` (${v1.userFiles.path})` : '') +
    ': the v1 attachments are in the backup archive (users/<userId>/attachments/) and the restore writes them ' +
    'under this directory, clearing each user\'s files there first, so a shared tree would change the v1 data in place.');
  notes.push('storages.engines.postgresql: set host/port/database/user/password of the v2 PostgreSQL ' +
    '(an empty password is accepted only with trust/peer authentication). To use SQLite instead, set ' +
    'storages.base.engine and storages.series.engine to sqlite.');

  if (v1.database?.engine === 'sqlite') {
    notes.push('v1 used SQLite for events; the data was exported to the backup format and is restored into the v2 base engine.');
  }
  if (v1.influxdb) {
    notes.push('v1 had an InfluxDB block: v2 stores series in PostgreSQL by default (storages.series.engine). ' +
      'Set it to influxdb and add storages.engines.influxdb to keep using InfluxDB.');
  }

  // eventFiles
  if (v1.eventFiles) {
    const eventFiles = {};
    if (v1.eventFiles.previewsCacheMaxAge) eventFiles.previewsCacheMaxAge = v1.eventFiles.previewsCacheMaxAge;
    if (v1.eventFiles.previewsCacheCleanUpCronTime) eventFiles.previewsCacheCleanUpCronTime = v1.eventFiles.previewsCacheCleanUpCronTime;
    if (Object.keys(eventFiles).length > 0) v2.eventFiles = eventFiles;
  }

  // service (service info, required at boot) / access — same location in v2
  if (v1.service) {
    v2.service = { ...v1.service };
  }
  if (v1.access) {
    v2.access = { ...v1.access };
  }

  // services: same location in v2; service-register is built into v2
  if (v1.services) {
    const { register, ...services } = v1.services;
    if (register) notes.push('services.register dropped: v2 serves registration itself.');
    if (Object.keys(services).length > 0) v2.services = services;
  }

  // keys with the same location and meaning in v2: copied as-is
  for (const key of ['auth', 'customExtensions', 'updates', 'webhooks', 'versioning', 'user-account',
    'custom', 'caching', 'logs', 'uploads', 'trace', 'integrity', 'accessTracking']) {
    if (v1[key]) v2[key] = { ...v1[key] };
  }

  // --- New v2 settings (defaults) ---

  // Cluster config (new in v2)
  v2.cluster = {
    apiWorkers: 2,
    hfsWorkers: 1,
    previewsWorker: true
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

  // v1-only settings are not copied: database (MongoDB), openSource,
  // backwardCompatibility, axonMessaging (replaced by cluster + tcpBroker),
  // eventFiles.attachmentsDirPath (attachments live under the user directory).

  return { config: v2, notes };
}

/**
 * Render the converted config as YAML with a review header.
 */
function render (v2, notes, sourcePath) {
  const header = [
    '# V2 configuration — converted from v1.x config',
    `# Source: ${sourcePath}`,
    `# Converted: ${new Date().toISOString()}`,
    '#',
    '# REVIEW BEFORE USE:',
    `# - Verify all '${PLACEHOLDER}' values`,
    '# - Adjust cluster.apiWorkers / hfsWorkers for your hardware',
    '# - storages.engines.filesystem.previewsDirPath must be set',
    '# - Settings v2 requires that v1 did not have (e.g. platform.piiHmacKey,',
    '#   auth.filesReadTokenSecret) are reported by `node bin/check-config.js <this file>`',
    '#   run from the v2 install: it must pass before the first boot',
    ...notes.map((n) => `# - ${n}`),
    ''
  ].join('\n');
  return header + '\n' + YAML.stringify(v2, { lineWidth: 120 });
}

module.exports = { convert, render, PLACEHOLDER };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node convert-config.js <v1-config.yml> [output.yml]');
    process.exit(1);
  }

  const configPath = path.resolve(args[0]);
  const outputPath = args[1] ? path.resolve(args[1]) : null;

  const v1 = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  const { config, notes } = convert(v1);
  const output = render(config, notes, configPath);

  if (outputPath) {
    fs.writeFileSync(outputPath, output);
    console.log('V2 config written to:', outputPath);
  } else {
    process.stdout.write(output);
  }
}
