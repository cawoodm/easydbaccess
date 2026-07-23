#!/usr/bin/env bash
#
# Live smoke test of the Datasette 1.0 JSON *write* API — the exact endpoints
# eda's Phase-2c write connector targets:
#   insert  →  POST /<db>/<table>/-/insert        {rows, return}
#   update  →  POST /<db>/<table>/<pk>/-/update   {update, return}
#   delete  →  POST /<db>/<table>/<pk>/-/delete   {}
# with  Authorization: Bearer dstok_…  and CORS enabled (--cors), so a browser
# can write cross-origin directly (no proxy).
#
# It spins up a throwaway local Datasette (1.0 alpha), runs a full CRUD cycle
# against a mutable DB, verifies the result, and tears everything down. This is
# a MANUAL dev script (needs `uvx` from uv and network for the first install);
# it is not part of CI. The write API does NOT exist on Datasette < 1.0.
#
# Usage:  scripts/datasette-write-smoke.sh
#   DATASETTE_VERSION=1.0a37  PORT=8124  override the defaults.
set -euo pipefail

VER="${DATASETTE_VERSION:-1.0a37}"
PORT="${PORT:-8124}"
SECRET="local-smoke-$$-${RANDOM}"
BASE="http://127.0.0.1:${PORT}"
DIR="$(mktemp -d)"
DB="${DIR}/smoke.db"
SRV=""

cleanup() { [ -n "${SRV}" ] && kill "${SRV}" 2>/dev/null || true; rm -rf "${DIR}"; }
trap cleanup EXIT

dsette() { uvx --from "datasette==${VER}" datasette "$@"; }

# A mutable DB with a primary-keyed table + two seed rows.
python3 - "${DB}" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)")
db.executemany("INSERT INTO items(id,name,qty) VALUES (?,?,?)", [(1, "apple", 3), (2, "pear", 7)])
db.commit(); db.close()
PY

TOKEN="$(dsette create-token root --secret "${SECRET}")"
dsette "${DB}" --root --cors --secret "${SECRET}" --host 127.0.0.1 --port "${PORT}" >"${DIR}/log" 2>&1 &
SRV=$!

curl -sS --retry-connrefused --retry 40 --retry-delay 1 -o /dev/null "${BASE}/-/versions.json" 2>>"${DIR}/log" \
  || { echo "FAIL: server did not come up"; cat "${DIR}/log"; exit 1; }

AUTH="Authorization: Bearer ${TOKEN}"
CT="Content-Type: application/json"

# Assert over a piped JSON body: `check <description> <python-bool-expr-over-d>`.
# Uses `python3 -c` (not a heredoc) so the curl output on stdin is preserved.
CHECK_PY='import json,sys; d=json.loads(sys.stdin.read() or "null"); ok=bool(eval(sys.argv[2])); print(("  ok   " if ok else "  FAIL ")+sys.argv[1]); sys.exit(0 if ok else 1)'
check() { python3 -c "${CHECK_PY}" "$1" "$2"; }

echo "== Datasette ${VER} write-API smoke test =="

curl -sS -D "${DIR}/h" -o /dev/null "${BASE}/smoke/items.json?_extra=columns,primary_keys,count"
grep -qi '^access-control-allow-origin: \*' "${DIR}/h" \
  && echo "  ok   CORS: Access-Control-Allow-Origin: *" \
  || { echo "  FAIL CORS header missing"; exit 1; }

curl -sS "${BASE}/smoke/items.json?_extra=columns,primary_keys,count&_size=0" \
  | check "read schema (pk=id, 3 columns, count=2)" \
    "d.get('primary_keys')==['id'] and d.get('columns')==['id','name','qty'] and d.get('count')==2"

curl -sS -X POST "${BASE}/smoke/items/-/insert" -H "${AUTH}" -H "${CT}" \
  -d '{"rows":[{"id":3,"name":"cherry","qty":12}],"return":true}' \
  | check "insert returns the new row" \
    "d.get('ok') and d['rows'][0]=={'id':3,'name':'cherry','qty':12}"

curl -sS -X POST "${BASE}/smoke/items/3/-/update" -H "${AUTH}" -H "${CT}" \
  -d '{"update":{"qty":99},"return":true}' \
  | check "update-by-pk returns the updated row" \
    "d.get('ok') and d['rows'][0]['qty']==99"

curl -sS -X POST "${BASE}/smoke/items/2/-/delete" -H "${AUTH}" -H "${CT}" -d '{}' \
  | check "delete-by-pk ok" "d.get('ok') is True"

curl -sS "${BASE}/smoke/items.json?_shape=array" \
  | check "final state = {apple:3, cherry:99}, pear gone" \
    "sorted((r['name'],r['qty']) for r in d)==[('apple',3),('cherry',99)]"

echo "== all write-API checks passed =="
