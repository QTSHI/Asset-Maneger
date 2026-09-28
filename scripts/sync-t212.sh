#!/bin/bash
# Compatibility entry point for existing cron jobs. The Node sync reconciles
# positions and cash atomically; this script must never write SQLite directly.
set -eu

script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd -P)"
project_root="$(dirname "$script_dir")"

if [ -z "${T212_API_KEY:-}" ] || [ -z "${T212_API_SECRET:-}" ]; then
  echo '缺少 T212_API_KEY 或 T212_API_SECRET 环境变量' >&2
  exit 1
fi

# The service resolves relative paths from its working directory. Preserve the
# caller's original relative database path before moving to the project root.
if [ -n "${ASSET_TRACKER_DB_PATH:-}" ]; then
  case "$ASSET_TRACKER_DB_PATH" in
    /*) ;;
    *) ASSET_TRACKER_DB_PATH="$PWD/$ASSET_TRACKER_DB_PATH" ;;
  esac
else
  ASSET_TRACKER_DB_PATH="$project_root/database.sqlite"
fi

if [ ! -f "$ASSET_TRACKER_DB_PATH" ]; then
  echo "数据库文件不存在：$ASSET_TRACKER_DB_PATH" >&2
  exit 1
fi

export ASSET_TRACKER_DB_PATH
cd "$project_root"
exec node "$script_dir/sync-trading212.cjs"
