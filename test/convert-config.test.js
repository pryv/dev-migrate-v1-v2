/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const YAML = require('yaml');

const { convert, PLACEHOLDER } = require('../convert-config');

const SCRIPT = path.join(__dirname, '..', 'convert-config.js');
const V1_OPEN_PRYV = path.join(__dirname, 'fixtures', 'v1-open-pryv-api.yml');

describe('convert-config', () => {
  describe('storages', () => {
    const v1 = {
      database: { engine: 'mongodb', host: 'mongo', port: 27017, name: 'pryv-node' },
      userFiles: { path: '/var/pryv/users' },
      eventFiles: { attachmentsDirPath: '/var/pryv/attachments', previewsDirPath: '/var/pryv/previews' },
      influxdb: { host: 'influx', port: 8086 }
    };
    const { config, notes } = convert(v1);

    it('uses PostgreSQL as base and series engine, never MongoDB', () => {
      assert.equal(config.storages.base.engine, 'postgresql');
      assert.equal(config.storages.series.engine, 'postgresql');
      assert.equal(config.storages.engines.mongodb, undefined);
      assert.ok(!JSON.stringify(config).includes('mongo'));
    });

    it('writes every PostgreSQL key v2 requires, with a password placeholder', () => {
      const pg = config.storages.engines.postgresql;
      for (const key of ['host', 'port', 'database', 'user']) {
        assert.ok(pg[key] != null && pg[key] !== '', `postgresql.${key} set`);
      }
      assert.equal(pg.password, PLACEHOLDER);
    });

    it('uses an engine v2 supports for platform storage', () => {
      assert.equal(config.storages.platform.engine, 'rqlite');
    });

    it('does not point the v2 user data directory at the v1 one, and says where the attachments go', () => {
      assert.equal(config.storages.engines.sqlite, undefined);
      const note = notes.find((n) => n.startsWith('storages.engines.sqlite.path'));
      assert.ok(note, 'user data directory note present');
      assert.ok(note.includes('/var/pryv/users'), 'note names the v1 userFiles.path');
      assert.ok(note.includes('users/<userId>/attachments/'), 'note says the attachments come from the archive');
    });

    it('keeps the previews path, drops the separate attachments path and InfluxDB', () => {
      assert.deepEqual(config.storages.engines.filesystem, { previewsDirPath: '/var/pryv/previews' });
      assert.equal(config.storages.engines.influxdb, undefined);
      assert.ok(notes.some((n) => n.includes('InfluxDB')));
    });

    it('does not write keys v2 no longer has', () => {
      assert.equal(config.database, undefined);
      assert.equal(config.cluster.runMigrations, undefined);
      assert.equal(config._migration_notes, undefined);
    });
  });

  describe('dnsLess / dns', () => {
    it('keeps a v1 dnsLess.publicUrl and sets isActive explicitly', () => {
      const { config } = convert({ dnsLess: { publicUrl: 'https://api.example.com/' } });
      assert.deepEqual(config.dnsLess, { publicUrl: 'https://api.example.com/', isActive: true });
    });

    it('writes isActive: false explicitly when v1 has dns.domain and no dnsLess', () => {
      const { config, notes } = convert({ dns: { domain: 'example.com' } });
      assert.equal(config.dns.domain, 'example.com');
      assert.equal(config.dnsLess.isActive, false);
      assert.ok(notes.some((n) => n.includes('dnsLess.isActive is false')));
    });

    it('keeps an explicit v1 dnsLess.isActive next to dns.domain', () => {
      const { config } = convert({ dns: { domain: 'example.com' }, dnsLess: { isActive: true, publicUrl: 'https://x.example.com/' } });
      assert.equal(config.dnsLess.isActive, true);
      assert.equal(config.dns.domain, 'example.com');
    });

    it('defaults to dnsLess with a publicUrl placeholder when v1 says nothing', () => {
      const { config } = convert({});
      assert.deepEqual(config.dnsLess, { isActive: true, publicUrl: PLACEHOLDER });
      assert.equal(config.dns, undefined);
    });
  });

  describe('service settings', () => {
    it('copies service, access and services, dropping services.register', () => {
      const { config, notes } = convert({
        service: { name: 'Test', serial: 1 },
        access: { defaultAuthUrl: 'https://auth.example.com/' },
        services: { email: { enabled: { welcome: true } }, register: { url: 'https://reg.example.com' } }
      });
      assert.deepEqual(config.service, { name: 'Test', serial: 1 });
      assert.deepEqual(config.access, { defaultAuthUrl: 'https://auth.example.com/' });
      assert.deepEqual(config.services, { email: { enabled: { welcome: true } } });
      assert.ok(notes.some((n) => n.includes('services.register')));
    });
  });

  describe('CLI', () => {
    it('converts the v1 open-pryv.io api.yml into a v2 config', () => {
      const out = execFileSync(process.execPath, [SCRIPT, V1_OPEN_PRYV], { encoding: 'utf8' });
      assert.ok(!/mongo/i.test(out.split('\n').filter((l) => !l.startsWith('#')).join('\n')));
      const v2 = YAML.parse(out);
      assert.equal(v2.storages.base.engine, 'postgresql');
      assert.equal(v2.dnsLess.isActive, true);
      assert.equal(v2.dnsLess.publicUrl, 'http://localhost:3000/');
      assert.equal(v2.service.name, 'Open-Pryv.io');
      assert.equal(v2.http.port, 3000);
      assert.equal(v2.cluster.apiWorkers, 2);
      assert.equal(v2.storages.engines.sqlite, undefined);
      assert.ok(out.includes('# - storages.engines.sqlite.path'), 'user data directory note in the header');
    });
  });
});
