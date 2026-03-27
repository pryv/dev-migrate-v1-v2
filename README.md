# Pryv v1.x → v2 Migration Toolkit

Exports data from a running v1.x Pryv.io system and produces a v2-compatible backup archive that can be restored into service-core v2 using `bin/backup.js --restore`.

## Supported Source Systems

- **open-pryv.io** v1.9.2 / v1.9.3 (single-node, Docker or raw)
- **service-core** v1.9.3 enterprise (Docker multi-node)
- Both MongoDB and SQLite storage engines for user index / account data

## Quick Start

### Prerequisites

- Node.js 18+
- Access to the v1.x MongoDB instance
- Access to the v1.x `var-pryv/` filesystem (for SQLite databases and attachments)

### Install

```bash
cd dev-migrate-v1-v2
npm install
```

### Export v1 Data

```bash
node export-v1.js <path-to-v1-config.yml> <output-dir>
```

The config file is the v1.x `api.yml` (or equivalent). Key settings the exporter reads:

| Config key | Purpose |
|---|---|
| `database.host/port/name` | MongoDB connection |
| `userFiles.path` | Base path for SQLite DBs and attachments |
| `storageUserIndex.engine` | `mongodb` or `sqlite` (default: sqlite) |
| `storageUserAccount.engine` | `mongodb` or `sqlite` (default: sqlite) |

### Convert Config

```bash
node convert-config.js <v1-config.yml> [output.yml]
```

Produces a v2-compatible config. If output is omitted, prints to stdout. Review the output and fill in any `REPLACE ME` values before using.

### Docker Migration (all-in-one)

For Docker-based v1.x deployments:

```bash
./docker-migrate.sh <v1-docker-compose-dir> <output-dir> [options]
```

The script auto-detects MongoDB port, `var-pryv` path, and v1 config location. Override with options if needed:

```
--mongo-host HOST     MongoDB host (default: 127.0.0.1)
--mongo-port PORT     MongoDB port on host (default: auto-detect)
--db-name NAME        Database name (default: pryv-node)
--var-pryv PATH       Path to var-pryv volume on host
--user-index ENGINE   User index engine: mongodb|sqlite (default: sqlite)
--account ENGINE      Account storage engine: mongodb|sqlite (default: sqlite)
--v1-config PATH      Path to v1 api.yml config
--no-compress         Disable gzip compression
```

### Restore into v2

After exporting, restore into a running v2 service-core instance:

```bash
# From service-core directory:
node bin/backup.js --restore <backup-dir> --overwrite
node bin/backup.js --restore <backup-dir> --verify-integrity   # optional
```

## Full Migration Steps

1. **Stop the v1.x API** (recommended — prevents data changes during export)
2. **Run the exporter** against the v1 MongoDB + filesystem
3. **Convert the config** from v1 `api.yml` to v2 format
4. **Review the v2 config** — fill in paths, verify settings
5. **Start a v2 service-core instance** with the new config
6. **Restore** from the backup archive
7. **Verify** data integrity (optional but recommended)

## What Gets Migrated

| Data | Source | Notes |
|---|---|---|
| Events | MongoDB `events` collection | Includes content, attachments metadata, history (headId) |
| Streams | MongoDB `streams` collection | Full hierarchy preserved |
| Accesses | MongoDB `accesses` collection | Tokens, permissions, all fields |
| Profile | MongoDB `profile` collection | |
| Webhooks | MongoDB `webhooks` collection | |
| Passwords | MongoDB `passwords` or SQLite `account-1.0.0.sqlite` | Bcrypt hashes preserved (compatible) |
| Key-value store | MongoDB `stores-key-value` or SQLite | Per-user store data |
| Attachments | Filesystem `var-pryv/users/{c}/{b}/{a}/{userId}/attachments/` | Binary files copied as-is |
| Audit | SQLite `audit-*.sqlite` per user | If present |
| Platform data | SQLite `platform-wide.db` | Key-value pairs |
| Config | `api.yml` | Converted to v2 format |

## What Does NOT Migrate

- **Sessions** — ephemeral, regenerated on login
- **Password reset requests** — ephemeral, TTL-based
- **MongoDB indexes** — rebuilt by v2 on startup
- **InfluxDB / HFS series data** — v1 stores series as regular events in MongoDB; they export as events. Migration to v2 HFS/InfluxDB format is a separate concern.
- **service-register data** — enterprise multi-node user→core mappings need separate handling

## Backup Format

The exporter produces a Plan 21 backup archive:

```
<output-dir>/
  manifest.json                     # backup metadata, user list
  platform/
    platform.jsonl.gz               # platform key-value data
  users/
    <userId>/
      user-manifest.json            # per-user metadata + stats
      streams.jsonl.gz
      accesses.jsonl.gz
      profile.jsonl.gz
      webhooks.jsonl.gz
      account.jsonl.gz              # passwords + key-value store
      events/
        events-0001.jsonl.gz        # chunked (50MB max per chunk)
      attachments/
        <fileId>                    # binary attachment files
      audit/
        audit-0001.jsonl.gz         # if audit data exists
```

All JSONL files are gzip-compressed by default. Data is sanitized: `_id`, `userId`, `__v` fields are stripped; `_id` is promoted to `id` where appropriate.

## Testing

### Direct E2E test (requires MongoDB with v1/v2 data)

```bash
node test-e2e.js test-config.yml
```

### Docker E2E test (requires Docker + open-pryv.io image)

```bash
# Build the v1 image first:
cd open-pryv.io
PRYV_TAG=1.9.3 docker compose -f docker/docker-compose-build.yml build open-pryv-api

# Start test environment and run:
node test-docker-e2e.js
```

## Known Limitations

- The exporter reads MongoDB directly — the v1 API does not need to be running
- SQLite files must be accessible from the host (for Docker, this means mounted volumes)
- Very large deployments (millions of events) should monitor memory usage; the exporter uses async generators but some operations buffer in memory
- The config converter produces a starting point — manual review is always required
