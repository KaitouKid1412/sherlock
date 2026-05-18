#!/usr/bin/env bash
# Sherlock launcher: starts the local server (or reuses one already running)
# and triggers a background self-update from the `release` branch for the next launch.

set -uo pipefail

APP_DIR="$HOME/Library/Application Support/Sherlock"
PORT_FILE="$APP_DIR/port.txt"
START_LOCK="$APP_DIR/.starting"
LAUNCH_LOG="$APP_DIR/launcher.log"

mkdir -p "$APP_DIR"
exec >>"$LAUNCH_LOG" 2>&1
echo "[$(date)] launcher invoked"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "ERROR: $APP_DIR is not a git checkout. Run the installer first."
  exit 1
fi

cd "$APP_DIR"

# Ensure node/npm are on PATH (GUI-launched apps don't inherit shell PATH).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

check_existing() {
  if [ -f "$PORT_FILE" ]; then
    local port
    port="$(cat "$PORT_FILE" 2>/dev/null || echo "")"
    if [ -n "$port" ] && curl -sf "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      echo "server already running on $port; opening browser"
      open "http://127.0.0.1:$port"
      return 0
    fi
  fi
  return 1
}

# Fast path: existing server
if check_existing; then exit 0; fi

# Stale startup-lock cleanup (>60s old)
if [ -d "$START_LOCK" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$START_LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -gt 60 ]; then
    echo "removing stale startup lock (age=${age}s)"
    rmdir "$START_LOCK" 2>/dev/null || true
  fi
fi

# Claim the startup lock; if we can't, another launcher is already starting.
if ! mkdir "$START_LOCK" 2>/dev/null; then
  echo "another launcher is starting; waiting"
  for _ in $(seq 1 60); do
    sleep 0.5
    if check_existing; then exit 0; fi
  done
  echo "ERROR: timed out waiting for the other launcher"
  exit 1
fi
trap 'rmdir "$START_LOCK" 2>/dev/null || true' EXIT

# Start the server detached — it opens its own browser on boot.
echo "starting server"
rm -f "$PORT_FILE"
nohup npm start >"$APP_DIR/server.log" 2>&1 &
SERVER_PID=$!
disown
echo "server pid=$SERVER_PID"

# Background self-update for the NEXT launch (does not affect this one).
(
  echo "[$(date)] update: starting"
  if ! git fetch origin release 2>/dev/null; then
    echo "[$(date)] update: fetch failed (offline or no release branch yet); skipping"
    exit 0
  fi
  old_lock="$(shasum -a 256 package-lock.json 2>/dev/null | cut -d' ' -f1)"
  if ! git reset --hard origin/release 2>/dev/null; then
    echo "[$(date)] update: reset failed; skipping"
    exit 0
  fi
  new_lock="$(shasum -a 256 package-lock.json 2>/dev/null | cut -d' ' -f1)"
  if [ "$old_lock" != "$new_lock" ]; then
    echo "[$(date)] update: package-lock changed, running npm install"
    npm install --silent 2>&1 || echo "[$(date)] update: npm install failed"
  fi
  echo "[$(date)] update: complete (applies on next launch)"
) >>"$APP_DIR/update.log" 2>&1 &
disown

# Release the lock once port.txt is written (server is responsive).
for _ in $(seq 1 60); do
  if [ -f "$PORT_FILE" ]; then
    echo "server booted; launcher exiting"
    exit 0
  fi
  sleep 0.5
done
echo "WARN: server did not write port.txt within 30s"
exit 0
