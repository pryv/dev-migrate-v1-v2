# Pryv v1.x → v2 Migration Toolkit

Exports data from a running v1.x Pryv.io system and produces a v2-compatible backup archive that can be restored into service-core v2 using `bin/backup.js --restore`.

## Supported Source Systems

| System | Version | Deployment | Tested |
|---|---|---|---|
| **open-pryv.io** | v1.9.2 / v1.9.3 | Raw (npm) or Docker | demo.datasafe.dev (6623 users) |
| **service-core** enterprise | v1.9.0 | Docker multi-container | me-dns1.pryv.io (14 users, 28K events, 262 attachments) |

Both MongoDB and SQLite storage engines for user index / account data are supported.

## Quick Start

### Prerequisites

- Node.js 18+
- Access to the v1.x MongoDB instance (direct or via Docker network)
- Access to the v1.x filesystem (for SQLite databases and attachments)
- For enterprise: access to Redis (service-register)

### Install

```bash
cd dev-migrate-v1-v2
npm install
```

### Export v1 Data

```bash
node export-v1.js <path-to-config.yml> <output-dir> [--register-dir <path>]
```

The config file is a YAML file with the following keys (can be the v1.x `api.yml` or a custom config):

| Config key | Purpose | Default |
|---|---|---|
| `database.host` | MongoDB host | `127.0.0.1` |
| `database.port` | MongoDB port | `27017` |
| `database.name` | MongoDB database name | `pryv-node` |
| `userFiles.path` | Base path for user dirs (SQLite DBs + attachments) | required |
| `storageUserIndex.engine` | `mongodb` or `sqlite` | `sqlite` |
| `storageUserAccount.engine` | `mongodb` or `sqlite` | `sqlite` |

User enumeration priority:
1. MongoDB `id4name` collection (if `storageUserIndex.engine = mongodb` and non-empty)
2. SQLite `user-index.db` at `{userFiles.path}/user-index.db`
3. Register data (if `--register-dir` provided or `register/` exists in output dir)
4. Fallback: `distinct("userId")` from MongoDB events + accesses collections

### Export Service-Register (Enterprise)

For enterprise deployments with a separate service-register backed by Redis:

```bash
node export-register.js <output-dir> [--redis-host HOST] [--redis-port PORT] [--redis-password PASS]
```

Exports:
- User profiles (`{username}:users` hash — username, email, language, registration timestamp)
- Server/core mappings (`{username}:server` — username → core FQDN)
- Email indexes (`{email}:email` — email → username)
- Invitation tokens

When register data is exported first into the same output directory, the core exporter automatically uses it to resolve usernames — important for setups where the core's `user-index.db` is not accessible or has unflushed WAL data.

```bash
# Recommended order for enterprise:
node export-register.js /backup --redis-host ...     # 1. Register first
node export-v1.js config.yml /backup                  # 2. Core exporter uses register data
node convert-config.js api.yml /backup/v2-config.yml  # 3. Config converter
```

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

Auto-detects MongoDB port, Redis port, `var-pryv` path, and v1 config location. Options:

```
--mongo-host HOST       MongoDB host (default: 127.0.0.1)
--mongo-port PORT       MongoDB port on host (default: auto-detect)
--db-name NAME          Database name (default: pryv-node)
--var-pryv PATH         Path to var-pryv volume on host
--user-index ENGINE     User index engine: mongodb|sqlite (default: sqlite)
--account ENGINE        Account storage engine: mongodb|sqlite (default: sqlite)
--v1-config PATH        Path to v1 api.yml config
--no-compress           Disable gzip compression
--redis-host HOST       Redis host for register export (default: 127.0.0.1)
--redis-port PORT       Redis port (default: auto-detect from Docker)
--redis-password PASS   Redis password
--skip-register         Skip register export
--skip-export           Skip core data export
--skip-convert          Skip config conversion
```

### Restore into v2

After exporting, restore into a running v2 service-core instance:

```bash
# From service-core directory:
node bin/backup.js --restore <backup-dir> --overwrite
node bin/backup.js --restore <backup-dir> --verify-integrity   # optional
```

## Deployment-Specific Guides

### open-pryv.io (raw install)

```bash
# From the open-pryv.io host:
cd migrate-v1-v2
node export-v1.js /path/to/configs/api.yml /tmp/backup
node convert-config.js /path/to/configs/api.yml /tmp/backup/v2-config.yml
```

Key paths:
- Config: `configs/api.yml`
- User data: `var-pryv/users/` (contains `user-index.db` + per-user dirs)
- MongoDB: usually `127.0.0.1:27017`

### Enterprise Docker (single-core, e.g. me-dns1.pryv.io)

The master config is at `/var/pryv/pryv/pryv.yml` (docker-compose). All data volumes are under `/var/pryv/pryv/`.

```bash
# 1. Find Docker internal IPs
MONGO_IP=$(sudo docker inspect pryvio_mongodb --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
REDIS_IP=$(sudo docker inspect pryvio_redis --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

# 2. Create export config
cat > export-config.yml << YAML
database:
  host: $MONGO_IP
  port: 27017
  name: pryv-node
userFiles:
  path: /var/pryv/pryv/core/data/users
storageUserIndex:
  engine: sqlite
storageUserAccount:
  engine: sqlite
YAML

# 3. Export register (needs Redis access)
node export-register.js /tmp/backup --redis-host $REDIS_IP --redis-port 6379

# 4. Export core data (needs sudo for SQLite file permissions)
sudo node export-v1.js export-config.yml /tmp/backup

# 5. Convert config
node convert-config.js /var/pryv/pryv/core/conf/core.yml /tmp/backup/v2-config.yml
```

Key paths:
- Docker compose: `/var/pryv/pryv/pryv.yml`
- Core config: `/var/pryv/pryv/core/conf/core.yml`
- User data: `/var/pryv/pryv/core/data/users/` (mounted as `/app/data/users` inside container)
- MongoDB: Docker internal network (use container IP)
- Redis: Docker internal network (use container IP)
- SQLite files owned by uid 9999 — run exporter with `sudo`

### Enterprise Multi-Core

Run the exporter **once per core**. Each core has its own MongoDB and filesystem.

1. Export register data once (shared across cores)
2. For each core: create a config pointing to that core's MongoDB + `userFiles.path`
3. Each core produces its own backup archive
4. Restore archives sequentially into v2

## Full Migration Steps

1. **Stop the v1.x API** (recommended — prevents data changes during export)
2. **Export register** (enterprise only — Redis user→core mappings)
3. **Run the core exporter** against MongoDB + filesystem
4. **Convert the config** from v1 to v2 format
5. **Review the v2 config** — fill in paths, verify settings
6. **Start a v2 service-core instance** with the new config
7. **Restore** from the backup archive
8. **Verify** data integrity (optional but recommended)

## What Gets Migrated

| Data | Source | Notes |
|---|---|---|
| Events | MongoDB `events` collection | Content, attachments metadata, history (headId) |
| Streams | MongoDB `streams` collection | Full hierarchy preserved |
| Accesses | MongoDB `accesses` collection | Tokens, permissions, all fields |
| Profile | MongoDB `profile` collection | |
| Webhooks | MongoDB `webhooks` collection | |
| Passwords | MongoDB `passwords` or SQLite `account-1.0.0.sqlite` | Bcrypt `$2b$` hashes — compatible |
| Key-value store | MongoDB `stores-key-value` or SQLite | Per-user store data |
| Attachments | Filesystem `{userFiles.path}/{c}/{b}/{a}/{userId}/attachments/` | Binary files copied as-is |
| Audit | SQLite `audit-*.sqlite` per user | If present |
| Platform data | SQLite `platform-wide.db` | Key-value pairs |
| Register: user profiles | Redis `{username}:users` hash | Username, email, language, registration time |
| Register: server mappings | Redis `{username}:server` | Username → core FQDN |
| Register: email indexes | Redis `{email}:email` | Email → username reverse lookup |
| Register: invitations | Redis `{token}:invitation` hash | Token metadata |
| Config | `api.yml` / `core.yml` | Converted to v2 format |

## What Does NOT Migrate

- **Sessions** — ephemeral, regenerated on login
- **Password reset requests** — ephemeral, TTL-based
- **MongoDB indexes** — rebuilt by v2 on startup
- **InfluxDB / HFS series data** — v1 stores series as regular events in MongoDB; they export as events. Migration to v2 HFS/InfluxDB format is a separate concern.
- **Redis access states** — ephemeral OAuth state, expires after TTL
- **Redis field reservations** — 10-minute registration locks

## Backup Format

The exporter produces a Plan 21 backup archive:

```
<output-dir>/
  manifest.json                     # backup metadata, user list
  platform/
    platform.jsonl.gz               # platform key-value data
  register/                         # enterprise only
    manifest.json                   # register export stats
    users.jsonl.gz                  # user profiles from Redis
    servers.jsonl.gz                # username → core mappings
    emails.jsonl.gz                 # email → username indexes
    invitations.jsonl.gz            # invitation token metadata
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

All JSONL files are gzip-compressed by default (`--no-compress` for plaintext). Data is sanitized: `_id`, `userId`, `__v` fields are stripped; `_id` is promoted to `id` where appropriate.

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
- SQLite files must be accessible from the host (for Docker deployments, data is on mounted volumes; may need `sudo` if owned by container user)
- SQLite WAL files may contain unflushed data — if `user-index.db` appears empty, the exporter falls back to register data or MongoDB `distinct("userId")`
- Register entries with invalid userId (e.g. `id: "0"`) are automatically skipped
- Very large deployments (millions of events) should monitor memory usage; the exporter uses async generators but some operations buffer in memory
- The config converter produces a starting point — manual review is always required
- Enterprise multi-core: each core must be exported separately
