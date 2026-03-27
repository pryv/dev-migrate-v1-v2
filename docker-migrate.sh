#!/bin/bash
# ---------------------------------------------------------------------------
# Pryv v1.x → v2 Docker Migration Script
#
# Orchestrates the full migration from a Docker-based v1.x deployment
# to a v2-compatible backup archive + config.
#
# Usage:
#   ./docker-migrate.sh <v1-docker-compose-dir> <output-dir> [options]
#
# Options:
#   --mongo-host HOST    MongoDB host (default: auto-detect from docker)
#   --mongo-port PORT    MongoDB port on host (default: auto-detect)
#   --db-name NAME       MongoDB database name (default: pryv-node)
#   --var-pryv PATH      Path to var-pryv volume on host (default: auto-detect)
#   --user-index ENGINE  User index engine: mongodb|sqlite (default: sqlite)
#   --account ENGINE     Account storage engine: mongodb|sqlite (default: sqlite)
#   --v1-config PATH     Path to v1 api.yml config (default: auto-detect)
#   --skip-export        Skip export step (use existing backup)
#   --skip-convert       Skip config conversion step
#   --no-compress        Disable gzip compression on backup
#   --help               Show this help
#
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Defaults
MONGO_HOST=""
MONGO_PORT=""
DB_NAME="pryv-node"
VAR_PRYV=""
USER_INDEX="sqlite"
ACCOUNT_ENGINE="sqlite"
V1_CONFIG=""
SKIP_EXPORT=false
SKIP_CONVERT=false
SKIP_REGISTER=false
COMPRESS="true"
REDIS_HOST=""
REDIS_PORT=""
REDIS_PASSWORD=""

usage() {
  head -25 "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
}

# Parse arguments
if [ $# -lt 2 ]; then
  echo "Error: Missing required arguments"
  echo "Usage: $0 <v1-docker-compose-dir> <output-dir> [options]"
  exit 1
fi

V1_DIR="$(cd "$1" && pwd)"
OUTPUT_DIR="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
shift 2

while [ $# -gt 0 ]; do
  case "$1" in
    --mongo-host)   MONGO_HOST="$2"; shift 2 ;;
    --mongo-port)   MONGO_PORT="$2"; shift 2 ;;
    --db-name)      DB_NAME="$2"; shift 2 ;;
    --var-pryv)     VAR_PRYV="$2"; shift 2 ;;
    --user-index)   USER_INDEX="$2"; shift 2 ;;
    --account)      ACCOUNT_ENGINE="$2"; shift 2 ;;
    --v1-config)    V1_CONFIG="$2"; shift 2 ;;
    --skip-export)  SKIP_EXPORT=true; shift ;;
    --skip-convert) SKIP_CONVERT=true; shift ;;
    --skip-register) SKIP_REGISTER=true; shift ;;
    --no-compress)  COMPRESS="false"; shift ;;
    --redis-host)   REDIS_HOST="$2"; shift 2 ;;
    --redis-port)   REDIS_PORT="$2"; shift 2 ;;
    --redis-password) REDIS_PASSWORD="$2"; shift 2 ;;
    --help|-h)      usage ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "============================================"
echo "  Pryv v1.x → v2 Migration"
echo "============================================"
echo ""
echo "  Source dir:  $V1_DIR"
echo "  Output dir:  $OUTPUT_DIR"
echo ""

# ---------------------------------------------------------------------------
# Auto-detect Docker MongoDB
# ---------------------------------------------------------------------------
if [ -z "$MONGO_HOST" ]; then
  MONGO_HOST="127.0.0.1"
fi

if [ -z "$MONGO_PORT" ]; then
  echo ">> Auto-detecting MongoDB port from Docker..."
  # Try to find the mongo container's published port
  MONGO_CONTAINER=$(docker ps --filter "ancestor=mongo" --filter "status=running" --format '{{.Names}}' | head -1)
  if [ -z "$MONGO_CONTAINER" ]; then
    MONGO_CONTAINER=$(docker ps --filter "name=mongo" --filter "status=running" --format '{{.Names}}' | head -1)
  fi
  if [ -n "$MONGO_CONTAINER" ]; then
    MONGO_PORT=$(docker port "$MONGO_CONTAINER" 27017 2>/dev/null | head -1 | sed 's/.*://')
    echo "   Found container: $MONGO_CONTAINER -> port $MONGO_PORT"
  fi
  if [ -z "$MONGO_PORT" ]; then
    echo "   Could not auto-detect. Using default 27017."
    MONGO_PORT="27017"
  fi
fi

# ---------------------------------------------------------------------------
# Auto-detect var-pryv volume
# ---------------------------------------------------------------------------
if [ -z "$VAR_PRYV" ]; then
  echo ">> Auto-detecting var-pryv path..."
  # Common locations for open-pryv.io Docker deployments
  for candidate in \
    "$V1_DIR/var-pryv/api" \
    "$V1_DIR/var-pryv" \
    "$V1_DIR/../var-pryv/api" \
    "$V1_DIR/../var-pryv"; do
    if [ -d "$candidate" ] && [ -f "$candidate/user-index.db" -o -f "$candidate/platform-wide.db" ]; then
      VAR_PRYV="$(cd "$candidate" && pwd)"
      echo "   Found: $VAR_PRYV"
      break
    fi
  done
  if [ -z "$VAR_PRYV" ]; then
    echo "   ERROR: Could not find var-pryv directory. Use --var-pryv to specify."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Auto-detect v1 config
# ---------------------------------------------------------------------------
if [ -z "$V1_CONFIG" ]; then
  echo ">> Auto-detecting v1 config..."
  for candidate in \
    "$V1_DIR/configs/api.yml" \
    "$V1_DIR/../configs/api.yml" \
    "$V1_DIR/config/api.yml"; do
    if [ -f "$candidate" ]; then
      V1_CONFIG="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
      echo "   Found: $V1_CONFIG"
      break
    fi
  done
  if [ -z "$V1_CONFIG" ]; then
    echo "   WARNING: No v1 config found. Config conversion will be skipped."
    SKIP_CONVERT=true
  fi
fi

echo ""
echo "  MongoDB:       $MONGO_HOST:$MONGO_PORT/$DB_NAME"
echo "  var-pryv:      $VAR_PRYV"
echo "  User index:    $USER_INDEX"
echo "  Account:       $ACCOUNT_ENGINE"
echo "  v1 config:     ${V1_CONFIG:-<not found>}"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Export
# ---------------------------------------------------------------------------
if [ "$SKIP_EXPORT" = false ]; then
  echo "============================================"
  echo "  Step 1: Export v1.x data"
  echo "============================================"

  EXPORT_CONFIG=$(mktemp /tmp/pryv-migrate-config-XXXXXX.yml)
  cat > "$EXPORT_CONFIG" <<YAML
database:
  engine: mongodb
  host: $MONGO_HOST
  port: $MONGO_PORT
  name: $DB_NAME
userFiles:
  path: $VAR_PRYV
storageUserIndex:
  engine: $USER_INDEX
storageUserAccount:
  engine: $ACCOUNT_ENGINE
dnsLess:
  publicUrl: http://localhost
YAML

  BACKUP_DIR="$OUTPUT_DIR/backup"
  mkdir -p "$BACKUP_DIR"

  COMPRESS_FLAG=""
  if [ "$COMPRESS" = "false" ]; then
    COMPRESS_FLAG="--no-compress"
  fi

  echo ""
  node "$SCRIPT_DIR/export-v1.js" "$EXPORT_CONFIG" "$BACKUP_DIR"
  rm -f "$EXPORT_CONFIG"

  echo ""
  echo "  Backup written to: $BACKUP_DIR"
else
  echo ">> Skipping export (--skip-export)"
  BACKUP_DIR="$OUTPUT_DIR/backup"
fi

# ---------------------------------------------------------------------------
# Step 2: Convert config
# ---------------------------------------------------------------------------
if [ "$SKIP_CONVERT" = false ] && [ -n "$V1_CONFIG" ]; then
  echo ""
  echo "============================================"
  echo "  Step 2: Convert v1.x config to v2"
  echo "============================================"
  echo ""

  V2_CONFIG="$OUTPUT_DIR/v2-config.yml"
  node "$SCRIPT_DIR/convert-config.js" "$V1_CONFIG" "$V2_CONFIG"

  echo ""
  echo "  v2 config written to: $V2_CONFIG"
  echo "  IMPORTANT: Review and update 'REPLACE ME' values before using."
else
  echo ""
  echo ">> Skipping config conversion"
fi

# ---------------------------------------------------------------------------
# Step 3: Export service-register (Redis)
# ---------------------------------------------------------------------------
if [ "$SKIP_REGISTER" = false ]; then
  # Auto-detect Redis
  if [ -z "$REDIS_HOST" ]; then
    REDIS_HOST="127.0.0.1"
  fi
  if [ -z "$REDIS_PORT" ]; then
    echo ""
    echo ">> Auto-detecting Redis port from Docker..."
    REDIS_CONTAINER=$(docker ps --filter "name=redis" --filter "status=running" --format '{{.Names}}' | head -1)
    if [ -n "$REDIS_CONTAINER" ]; then
      REDIS_PORT=$(docker port "$REDIS_CONTAINER" 6379 2>/dev/null | head -1 | sed 's/.*://')
      if [ -n "$REDIS_PORT" ]; then
        echo "   Found container: $REDIS_CONTAINER -> port $REDIS_PORT"
      fi
    fi
    if [ -z "$REDIS_PORT" ]; then
      echo "   Could not auto-detect Redis port. Using default 6379."
      REDIS_PORT="6379"
    fi
  fi

  echo ""
  echo "============================================"
  echo "  Step 3: Export service-register (Redis)"
  echo "============================================"
  echo ""

  REGISTER_ARGS="$BACKUP_DIR --redis-host $REDIS_HOST --redis-port $REDIS_PORT"
  if [ -n "$REDIS_PASSWORD" ]; then
    REGISTER_ARGS="$REGISTER_ARGS --redis-password $REDIS_PASSWORD"
  fi
  if [ "$COMPRESS" = "false" ]; then
    REGISTER_ARGS="$REGISTER_ARGS --no-compress"
  fi

  node "$SCRIPT_DIR/export-register.js" $REGISTER_ARGS || {
    echo "  WARNING: Register export failed. Continuing without register data."
  }
else
  echo ""
  echo ">> Skipping register export (--skip-register)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  Migration output ready"
echo "============================================"
echo ""
echo "  Output directory: $OUTPUT_DIR"
echo ""
if [ -d "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/manifest.json" ]; then
  USER_COUNT=$(node -e "const m=require('$BACKUP_DIR/manifest.json'); console.log(m.users.length)")
  echo "  Backup: $BACKUP_DIR"
  echo "    Users exported: $USER_COUNT"
  echo "    Format: Plan 21 (JSONL + gzip)"
fi
if [ -d "$BACKUP_DIR/register" ] && [ -f "$BACKUP_DIR/register/manifest.json" ]; then
  REG_USERS=$(node -e "const m=require('$BACKUP_DIR/register/manifest.json'); console.log(m.stats.users)")
  REG_SERVERS=$(node -e "const m=require('$BACKUP_DIR/register/manifest.json'); console.log(m.stats.servers)")
  echo ""
  echo "  Register: $BACKUP_DIR/register"
  echo "    User profiles: $REG_USERS"
  echo "    Server mappings: $REG_SERVERS"
fi
if [ -f "$OUTPUT_DIR/v2-config.yml" ]; then
  echo ""
  echo "  Config: $OUTPUT_DIR/v2-config.yml"
fi
echo ""
echo "  Next steps:"
echo "    1. Review v2-config.yml and fill in any 'REPLACE ME' values"
echo "    2. Start your v2 service-core instance"
echo "    3. Restore: node service-core/bin/backup.js --restore $BACKUP_DIR --overwrite"
echo "    4. Optionally verify: node service-core/bin/backup.js --restore $BACKUP_DIR --verify-integrity"
echo ""
