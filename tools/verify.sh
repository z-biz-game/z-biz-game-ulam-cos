#!/usr/bin/env bash
# One-shot acceptance gate for 谎话藏数 ULAM: the node suites first, then a real browser against a
# real server, driven over raw CDP (tools/playtest.mjs). Everything this script starts is killed on
# exit, including the Chrome it launched in a temp profile.
#
# PORTS ARE 5222 / 9372 ON PURPOSE AND MAY NOT COLLIDE: the sibling repos in this farm hold
# 5180/9340 (gridlock), 5191/9351 (tango), 5192/9352 (hanoi), 5212/9353 (staircase),
# 5221/9371 (euclid), 5223/9373 (loshu). Only ONE headless Chrome may bind a remote-debugging-port
# on this machine at a time, and an orphan from a killed agent squats the port and turns a browser
# run into a false "0 rows" verdict — so this script refuses to start until the coast is clear.
# Override with CDP_PORT= / WEB_PORT= if a sibling moved.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates the cores and, with no CDP client attached, the process does not exit on
# its own. This game is plain 2D canvas; default headless is enough.
#
#   bash tools/verify.sh                        # node suites + @boot @play @routes @save @pointer
#   SKIP_UNIT=1 bash tools/verify.sh            # browser only (what ci.yml's browser job runs)
#   SCENARIOS="pointer" bash tools/verify.sh    # one suite while editing the view
#   ALLOW_ORPHAN_CHROME=1 bash tools/verify.sh  # tolerate other builders' Chromes (still binds its
#                                               # OWN one on :9372 — it never rides a stranger)
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9372}
WEB_PORT=${WEB_PORT:-5222}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
SHOTS=${SHOTS_DIR:-/tmp/ulam-shots}
CHROME=${CHROME_BIN:-}

# ---- pre-flight: no other agent's Chrome may be squatting our debug port -------------------
if lsof -nP -iTCP:"$CDP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "devtools port :$CDP_PORT is already LISTENING — an orphan Chrome from another builder." >&2
  pgrep -fl remote-debugging-port >&2 || true
  exit 6
fi
if lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "web port :$WEB_PORT is already LISTENING — pick WEB_PORT." >&2
  exit 7
fi
ORPHANS=$(ps -Ao command= | awk '/remote-debugging[-]port/ && !/--type=/' | wc -l | tr -d ' ')  # instances, not processes: helper argvs repeat the flag
if [ "${ORPHANS}" != "0" ] && [ -z "${ALLOW_ORPHAN_CHROME:-}" ]; then
  echo "$ORPHANS headless Chrome(s) with a remote-debugging-port are already running on this" >&2
  echo "machine. One at a time is the rule; verify that they are yours, then set" >&2
  echo "ALLOW_ORPHAN_CHROME=1 CDP_PORT=<free port> to proceed." >&2
  ps -Ao pid=,etime=,command= | awk '/remote-debugging[-]port/ && !/--type=/' >&2 || true
  exit 8
fi

if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }
mkdir -p "$SHOTS"

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=1040,860 --no-first-run --no-default-browser-check about:blank >"$SHOTS/chrome.log" 2>&1 &
CPID=$!
node "$HERE/server.cjs" $WEB_PORT >"$SHOTS/server.log" 2>&1 &
SPID=$!
cleanup() {
  kill -9 $CPID $SPID 2>/dev/null
  # wait on every background pid: without this the shell prints a shower of `Killed: 9` after the
  # verdict, which reads like a failure to whoever is scrolling the log.
  wait $CPID 2>/dev/null
  wait $SPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits the script's stdout, and inside a
# pipeline it would hold the write end open for the full timeout and stall the consumer.
( sleep ${WD_TIMEOUT:-600}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile; poll the endpoints,
# never guess a sleep. BOTH endpoints: devtools AND the web root.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; exit 3; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || {
  echo "static server never answered on $BASE" >&2; exit 4; }
# Serving SOMETHING is not serving THE GAME: a server rooted at the wrong directory answers 200 with
# a sibling's index.html, and every browser assertion then runs against the wrong repo. The title is
# mixed case (谎话藏数 ULAM), hence -i, and js/main.js is what actually boots the shell.
SERVED=$(curl -fsS -m 3 "$BASE")
printf '%s' "$SERVED" | grep -qi "ulam" || {
  echo "$BASE answered but never mentions ulam — wrong document root?" >&2; exit 9; }
printf '%s' "$SERVED" | grep -q "js/main.js" || {
  echo "$BASE is not the ulam shell: no js/main.js in the served bytes" >&2; exit 9; }

cd "$HERE"
FAILED=0

echo "=== node suites ==="
# SKIP_UNIT=1 for the browser job in CI: the suites are their own job there.
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    node "$f" | tail -1 || FAILED=1
  done
  # 部署集闸：ci.yml 跑这两步、本地整闸以前一次都不跑（59 仓同形）。「本地全绿、线上 404 自己的
  # manifest / sw.js / 图标」这一类坏法缺的就是这一步。它不碰 Chrome，所以放在 node suites 里。
  echo "=== deploy-set ==="
  node tools/deploy-set.mjs || FAILED=1
  node tools/deploy-set-selftest.mjs || FAILED=1
fi

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# js/data/lots.js ships the baked 14-lot campaign plus a 33-row MINQ table (a megabyte of module
# text), and the shell only reports a state once it has routed, resolved the lot and measured the
# canvas — so wait on window.ulam.state.id rather than on a timer.
BOOT=""
for i in $(seq 1 80); do
  BOOT=$(node tools/playtest.mjs eval "window.ulam?window.ulam.state.id:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot lot: $BOOT"
[ "$BOOT" = "nope" ] && { echo "window.ulam never appeared at $BASE" >&2; exit 5; }
node tools/playtest.mjs shot "$SHOTS/boot.png" >/dev/null 2>&1

for s in ${SCENARIOS:-boot play routes save pointer}; do
  echo "=== @$s ==="
  OUT=$(node tools/playtest.mjs eval "@$s" nonav 2>&1)
  # The result JSON is cut out of the console by BRACE COUNTING, not JSON.parse of a whole line:
  # headless appends other text to the same line, and a parse-everything reader dies on it. The
  # counter walks string literals (with escapes) so a detail that quotes '{ not json' — which the
  # @save suite writes on purpose, to prove a corrupt 存档 degrades instead of throwing — cannot
  # fool it into running past the end. Zero rows is a failure: a dead harness must not read green.
  printf '%s\n' "$OUT" | python3 -c '
import sys, json
raw = sys.stdin.read()
start = raw.find("{")
if start < 0:
    print("NO RESULT", raw[-300:]); sys.exit(1)
depth = 0
instr = False
esc = False
end = -1
for i in range(start, len(raw)):
    ch = raw[i]
    if instr:
        if esc: esc = False
        elif ch == "\\": esc = True
        elif ch == "\x22": instr = False
        continue
    if ch == "\x22": instr = True
    elif ch == "{": depth += 1
    elif ch == "}":
        depth -= 1
        if depth == 0:
            end = i
            break
if end < 0:
    print("UNBALANCED JSON", raw[start:start+200]); sys.exit(1)
try: d = json.loads(raw[start:end + 1])
except Exception as e:
    print("BAD JSON", e, raw[start:start+200]); sys.exit(1)
rows = d.get("rows", [])
print("rows:", len(rows), "fail:", d.get("fail"))
for r in rows:
    if not r["pass"]: print("  FAIL", r["test"], json.dumps(r["detail"], ensure_ascii=False)[:300])
sys.exit(1 if d.get("fail") or not rows else 0)
' || FAILED=1
  # A clean console is part of the contract: a thrown page error, a refused resource or a canvas
  # readback warning all count, even when every assertion above happened to pass.
  if printf '%s' "$OUT" | grep -qE '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]'; then
    echo "  CONSOLE NOT CLEAN for @$s"
    printf '%s\n' "$OUT" | grep -E '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]' | head -5
    FAILED=1
  fi
  node tools/playtest.mjs shot "$SHOTS/$s.png" >/dev/null 2>&1
done

# The headline number, printed rather than implied: a click path that never spends a DP node.
# (Every suite asserts it too; this is the line that ends up in the report.)
echo "=== search nodes spent by the click path ==="
node tools/playtest.mjs eval "({ searchNodes: window.ulam.searchNodes(), closure: window.ulam.closure(), claimsBroke: window.ulam.claims().filter((x) => !x.held).length })" nonav | tail -8

echo "=== win shot (the card the shell owes the player) ==="
node tools/playtest.mjs eval "(async () => {
  const c = window.ulam;
  c.store.reset(); c.load('#/lot/7-1');
  await new Promise((r) => setTimeout(r, 220));
  let threw = null;
  try { c.autoPlay(24); } catch (e) { threw = String(e && e.message || e).slice(0, 120); }
  await new Promise((r) => setTimeout(r, 300));
  return { won: c.state.won, done: c.state.done, asked: c.state.asked, grade: c.state.grade,
           veil: c.state.veil, stars: document.getElementById('stars').textContent,
           verdict: document.getElementById('verdict').textContent,
           record: c.store.record('7-1'), finishThrew: threw };
})()" nonav | tail -12
node tools/playtest.mjs shot "$SHOTS/win.png" >/dev/null 2>&1

echo "=== console ==="
CONS=$(node tools/playtest.mjs logs)
echo "$CONS"
echo "$CONS" | grep -qE "\[(error|EXCEPTION|log:error)\]" && { echo "console has errors" >&2; FAILED=1; }

kill $WD 2>/dev/null
wait $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
