#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://127.0.0.1:8080/health"
LOG_FILE="$SCRIPT_DIR/logs/health-check.log"
mkdir -p "$SCRIPT_DIR/logs"
if ! curl -s -f "$URL" > /dev/null 2>&1; then
  echo "[$(date)] 网站无法访问，正在重启..." >> "$LOG_FILE"
  cd "$SCRIPT_DIR" && pm2 restart asset-tracker
fi
