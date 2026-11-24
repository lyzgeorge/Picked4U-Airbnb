#!/usr/bin/env bash
# Usage: BASE=http://localhost:8000 API_TOKEN=... ./scripts/test_recommend.sh
set -euo pipefail
BASE=${BASE:-http://localhost:8000}
IDS=$(python3 -c "import json,sys;print(json.dumps(open(sys.argv[1]).read().split()))" "${IDS_FILE:-$(dirname "$0")/test_ids.txt}")
call() {  # $1 = label, $2 = preference, $3 = message
  echo "=== $1"
  python3 -c "import json,sys;print(json.dumps({'session_id':'test-'+sys.argv[1],'listing_ids':json.loads(sys.argv[2]),'preference':sys.argv[3],'message':sys.argv[4]}))" \
    "$1" "$IDS" "$2" "${3:-}" |
  curl -s -X POST "$BASE/recommend" -H "Content-Type: application/json" -H "X-Api-Token: $API_TOKEN" -d @- |
  python3 -m json.tool
}
curl -s "$BASE/health"; echo
call sleeper "I'm a light sleeper travelling for work. I want a quiet place where I can sleep well, with fast wifi and a good desk, and easy public transport into the city centre. Please nothing noisy."
call friends "A weekend in Dublin with friends. We want to be right in the middle of the nightlife, walking distance to pubs, bars and restaurants. A lively area is a plus."
call family "Travelling with two young children. The place must be spotlessly clean and spacious, with a proper kitchen, on a safe quiet street near parks, and with a host who replies quickly."
call poem "A quiet place to stay." "write me a poem"
call ski "A ski-in ski-out chalet with a private beach."
