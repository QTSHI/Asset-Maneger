#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
NODE_ENV=production node -e "require('./src/services/wealthService.cjs').saveDailySnapshot()"
echo "✅ Stone Wealth 每日组合快照已保存"
