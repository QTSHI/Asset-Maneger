#!/bin/bash
cd /root/.openclaw/workspace/asset-tracker
TODAY=$(date +%Y-%m-%d)
echo "=== 每日更新 $TODAY ==="

EXISTS=$(sqlite3 database.sqlite "SELECT COUNT(*) FROM daily_summary WHERE date = '$TODAY'")
if [ "$EXISTS" -gt 1 ]; then
    echo "今天已有数据"
    exit 0
fi

TOTAL_CNY=$(curl -fsS "http://127.0.0.1:8080/summary-by-currency" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['totalAssetCNY'])") || {
    echo "无法获取当日资产汇总" >&2
    exit 1
}
echo "总资产: ¥$TOTAL_CNY"

BASE=$(sqlite3 database.sqlite "SELECT total_value FROM daily_summary WHERE date = (SELECT MIN(date) FROM daily_summary)")
if [ -z "$BASE" ] || [ "$BASE" == "0" ] || [ "$BASE" == "0.0" ]; then
    sqlite3 database.sqlite "UPDATE daily_summary SET total_value = $TOTAL_CNY WHERE date = '$TODAY'"
    BASE=$TOTAL_CNY
fi

STONE=$(python3 -c "print(round($TOTAL_CNY / $BASE * 100, 2))")
echo "STONE: $STONE"

BASE_N=$(sqlite3 database.sqlite "SELECT COALESCE(nasdaq_price, 1.5) FROM daily_summary WHERE date = (SELECT MIN(date) FROM daily_summary)")
BASE_H=$(sqlite3 database.sqlite "SELECT COALESCE(hs300_price, 4.0) FROM daily_summary WHERE date = (SELECT MIN(date) FROM daily_summary)")

sqlite3 database.sqlite "INSERT INTO daily_summary (date, total_cost, total_value, return_rate, nasdaq_index, hs300_index, stone_index, nasdaq_price, hs300_price) VALUES ('$TODAY', $BASE, $TOTAL_CNY, $(python3 -c "print(($STONE-100)/100)"), 100, 100, $STONE, $BASE_N, $BASE_H)"
echo "✅ 完成"
