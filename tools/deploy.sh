#!/bin/sh
# Deploys this checkout onto the box that serves bahn.hopeajahti.lol. Meant to be run by a pull hook on the
# integration branch; safe to run by hand. Nothing here touches .env files or stored calls.
#
#   APP_DIR      the live app checkout (a clone of this repo), default /home/assistant/projects/bahn-control-room
#   DOSSIER_DIR  the live dossier/call service tree, default /home/assistant/projects/road-dossier
#   APP_UNIT     systemd user unit of the app (127.0.0.1:8797), default bahn-control-room
#   DOSSIER_UNIT systemd user unit of the call service (127.0.0.1:8799), default road-dossier
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP_DIR=${APP_DIR:-/home/assistant/projects/bahn-control-room}
DOSSIER_DIR=${DOSSIER_DIR:-/home/assistant/projects/road-dossier}
APP_UNIT=${APP_UNIT:-bahn-control-room}
DOSSIER_UNIT=${DOSSIER_UNIT:-road-dossier}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

say() { printf '\n== %s\n' "$*"; }

# 1. The call service: this repo's dossier/ over the live tree, keeping its env and its stored calls, runs and audio.
say "dossier -> $DOSSIER_DIR"
mkdir -p "$DOSSIER_DIR/data/out"
rsync -a --delete --exclude .env --exclude node_modules --exclude data/out --exclude data/dataset --exclude .git "$HERE/dossier/" "$DOSSIER_DIR/"
[ -e "$DOSSIER_DIR/data/dataset" ] || ln -s "$HERE/dataset/data" "$DOSSIER_DIR/data/dataset"
( cd "$DOSSIER_DIR" && npm ci --no-audit --no-fund --silent && npm run -s typecheck )
if systemctl --user restart "$DOSSIER_UNIT" 2>/dev/null; then :; else
  echo "no user unit $DOSSIER_UNIT: start it by hand with: cd $DOSSIER_DIR && npm run serve"
fi

# 2. The app. When APP_DIR is this very checkout, build in place; else bring that checkout to this commit first.
say "app -> $APP_DIR"
if [ "$APP_DIR" != "$HERE" ]; then
  git -C "$APP_DIR" fetch -q "$HERE" HEAD
  git -C "$APP_DIR" checkout -q --detach FETCH_HEAD
fi
( cd "$APP_DIR/starter" && npm ci --no-audit --no-fund --silent && npm run -s typecheck && npm run -s build > /tmp/bahn-build.log 2>&1 ) || { tail -40 /tmp/bahn-build.log; exit 1; }
systemctl --user restart "$APP_UNIT"
for i in $(seq 1 20); do curl -sf -o /dev/null 127.0.0.1:8797/api/sim/state && break; sleep 1; done

# 3. A restart re-anchors the simulated clock at SIM_NOW while stored telemetry is ahead of it: move the clock up.
latest=$(docker exec bahn-pg psql -U controlroom -At -c "select coalesce(extract(epoch from max(at))::bigint, 0) from cr_telemetry" 2>/dev/null || echo 0)
now=$(curl -s 127.0.0.1:8797/api/sim/state | python3 -c "import json,sys,datetime;print(int(datetime.datetime.fromisoformat(json.load(sys.stdin)['now'].replace('Z','+00:00')).timestamp()))" 2>/dev/null || echo 0)
gap=$(( (latest - now) / 60 + 1 ))
while [ "$gap" -gt 0 ]; do
  step=$gap; [ "$step" -gt 120 ] && step=120
  curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"minutes\":$step}" 127.0.0.1:8797/api/sim/clock
  gap=$((gap - step))
done

say "deployed $(git -C "$HERE" rev-parse --short HEAD)"
for p in /api/build /api/sim/state / /demo /dealer; do curl -s -o /dev/null -w "  $p %{http_code} %{time_total}s\n" 127.0.0.1:8797$p; done
curl -s 127.0.0.1:8799/health; echo
