#!/bin/bash
URL="http://localhost:8080"
LOG_FILE="/root/.openclaw/workspace/asset-tracker/logs/health-check.log"
if ! curl -s -f "$URL" > /dev/null 2>&1; then
  echo "[$(date)] 网站无法访问，正在重启..." >> "$LOG_FILE"
  cd /root/.openclaw/workspace/asset-tracker && pm2 restart asset-tracker
fi
