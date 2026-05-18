#!/usr/bin/env bash
# Sherlock self-update — single pass. Idempotent and safe to call multiple times.
# Both the launcher (on every app launch) and the server (via in-session polling
# every 30 min) invoke this. Uses .updating as a directory lock so concurrent
# invocations don't race on git/npm operations.

set -uo pipefail

APP_DIR="${SHERLOCK_APP_DIR:-$HOME/Library/Application Support/Sherlock}"
UPDATE_LOG="$APP_DIR/update.log"
UPDATE_LOCK="$APP_DIR/.updating"

mkdir -p "$APP_DIR"

# Inherit captured PATH so node/npm are available in GUI/server contexts.
if [ -f "$APP_DIR/.runtime-env" ]; then
  # shellcheck source=/dev/null
  source "$APP_DIR/.runtime-env"
fi

# Acquire update lock. If another update is running and the lock is fresh,
# bail out silently. Stale lock (>10 min) is treated as the owner having
# crashed and is removed.
if [ -d "$UPDATE_LOCK" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$UPDATE_LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -lt 600 ]; then
    echo "[$(date)] update: another update in progress (age=${age}s); skipping" >> "$UPDATE_LOG"
    exit 0
  fi
  echo "[$(date)] update: removing stale lock (age=${age}s)" >> "$UPDATE_LOG"
  rmdir "$UPDATE_LOCK" 2>/dev/null || true
fi
if ! mkdir "$UPDATE_LOCK" 2>/dev/null; then
  echo "[$(date)] update: failed to acquire lock; skipping" >> "$UPDATE_LOG"
  exit 0
fi
trap 'rmdir "$UPDATE_LOCK" 2>/dev/null || true' EXIT

# From here on, append everything to update.log for postmortem visibility.
exec >> "$UPDATE_LOG" 2>&1

echo "[$(date)] update: starting"
cd "$APP_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "[$(date)] update: $APP_DIR is not a git checkout; nothing to do"
  exit 0
fi

# Stale .git/index.lock from a previously killed git op blocks all future
# git work; sweep it preemptively.
if [ -f "$APP_DIR/.git/index.lock" ]; then
  lock_age=$(( $(date +%s) - $(stat -f %m "$APP_DIR/.git/index.lock" 2>/dev/null || echo 0) ))
  if [ "$lock_age" -gt 60 ]; then
    echo "[$(date)] update: removing stale .git/index.lock (age=${lock_age}s)"
    rm -f "$APP_DIR/.git/index.lock"
  fi
fi

old_head="$(git rev-parse HEAD 2>/dev/null || echo none)"

if ! fetch_err="$(git fetch origin release 2>&1)"; then
  echo "[$(date)] update: fetch failed; skipping"
  echo "[$(date)] update:   $fetch_err"
  exit 0
fi

old_lock_hash="$(shasum -a 256 package-lock.json 2>/dev/null | cut -d' ' -f1)"
old_bundle_hash="$(find "$APP_DIR/packaging/Sherlock.app" -type f 2>/dev/null | sort | xargs shasum -a 256 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"

# Reset with error capture + auto-recovery for the two common failure modes.
if ! reset_err="$(git reset --hard FETCH_HEAD 2>&1)"; then
  echo "[$(date)] update: reset failed"
  echo "[$(date)] update:   $reset_err"
  if echo "$reset_err" | grep -qi "index.lock"; then
    echo "[$(date)] update: removing index.lock and retrying"
    rm -f "$APP_DIR/.git/index.lock"
    if ! reset_err2="$(git reset --hard FETCH_HEAD 2>&1)"; then
      echo "[$(date)] update: retry failed: $reset_err2"
      exit 0
    fi
  elif echo "$reset_err" | grep -qi "local changes"; then
    echo "[$(date)] update: stashing local changes and retrying"
    git stash push -u -m "auto-stash-pre-update-$(date +%s)" 2>&1 || true
    if ! reset_err2="$(git reset --hard FETCH_HEAD 2>&1)"; then
      echo "[$(date)] update: retry failed: $reset_err2"
      exit 0
    fi
  else
    exit 0
  fi
fi

new_head="$(git rev-parse HEAD 2>/dev/null || echo none)"
if [ "$old_head" = "$new_head" ]; then
  echo "[$(date)] update: already up to date ($new_head)"
  exit 0
fi
echo "[$(date)] update: $old_head -> $new_head"

# Mark "updating" so the sidebar indicator switches over.
printf '{"state":"updating","at":%s}\n' "$(date +%s)" > "$APP_DIR/.update-status"

new_lock_hash="$(shasum -a 256 package-lock.json 2>/dev/null | cut -d' ' -f1)"
new_bundle_hash="$(find "$APP_DIR/packaging/Sherlock.app" -type f 2>/dev/null | sort | xargs shasum -a 256 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"

if [ "$old_lock_hash" != "$new_lock_hash" ]; then
  echo "[$(date)] update: package-lock changed, running npm install"
  npm install --silent 2>&1 || echo "[$(date)] update: npm install failed"
fi

echo "[$(date)] update: rebuilding frontend"
npm run build --silent 2>&1 || echo "[$(date)] update: build failed"

if [ "$old_bundle_hash" != "$new_bundle_hash" ] && [ -d "$APP_DIR/packaging/Sherlock.app" ]; then
  echo "[$(date)] update: .app bundle changed; refreshing /Applications/Sherlock.app"
  rm -rf "/Applications/Sherlock.app.tmp"
  if cp -R "$APP_DIR/packaging/Sherlock.app" "/Applications/Sherlock.app.tmp" 2>/dev/null; then
    rm -rf "/Applications/Sherlock.app"
    mv "/Applications/Sherlock.app.tmp" "/Applications/Sherlock.app"
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
      -f "/Applications/Sherlock.app" 2>/dev/null || true
    echo "[$(date)] update: .app bundle refreshed"
  else
    echo "[$(date)] update: .app bundle refresh failed (no write access?)"
  fi
fi

printf '{"state":"updated","at":%s,"head":"%s"}\n' "$(date +%s)" "$new_head" > "$APP_DIR/.update-status"
echo "[$(date)] update: complete (frontend live on next browser refresh; server-side code on next cold start or Restart Sherlock click)"
