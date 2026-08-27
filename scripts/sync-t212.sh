#!/bin/bash
# Trading212 同步脚本 - 使用系统sqlite3

DB_PATH="${ASSET_TRACKER_DB_PATH:-/var/www/asset-tracker/database.sqlite}"
API_KEY="${T212_API_KEY:-}"
API_SECRET="${T212_API_SECRET:-}"

if [ -z "$API_KEY" ] || [ -z "$API_SECRET" ]; then
  echo "缺少 T212_API_KEY 或 T212_API_SECRET 环境变量" >&2
  exit 1
fi

# 获取数据
RESPONSE=$(curl -s -u "${API_KEY}:${API_SECRET}" \
  -H "Accept: application/json" \
  https://live.trading212.com/api/v0/equity/account/cash)

# 解析数据
total=$(echo $RESPONSE | grep -o '"total":[0-9.]*' | cut -d: -f2)
invested=$(echo $RESPONSE | grep -o '"invested":[0-9.]*' | cut -d: -f2)
ppl=$(echo $RESPONSE | grep -o '"ppl":-[0-9.]*\|"ppl":[0-9.]*' | cut -d: -f2)

echo "Trading212 同步: 总值=$total, 投入=$invested, 盈亏=$ppl"

# 获取平台ID
platform_id=$(sqlite3 "$DB_PATH" "SELECT id FROM platforms WHERE name='Trading212';")
currency_id=$(sqlite3 "$DB_PATH" "SELECT id FROM currencies WHERE code='GBP';")
asset_type_id=$(sqlite3 "$DB_PATH" "SELECT id FROM asset_types WHERE name='cash';")

# 计算成本单价
cost_price=$(echo "scale=6; $invested / $total" | bc)

# 删除旧数据
sqlite3 "$DB_PATH" "DELETE FROM assets WHERE platform_id=$platform_id;"

# 插入新数据
sqlite3 "$DB_PATH" "INSERT INTO assets (code, name, shares, cost_price, platform_id, currency_id, asset_type_id, user_id) VALUES ('T212-TOTAL', 'Trading212账户', $total, $cost_price, $platform_id, $currency_id, $asset_type_id, 1);"

echo "同步完成"
