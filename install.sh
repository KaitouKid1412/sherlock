#!/usr/bin/env bash
# Sherlock installer. Run once per machine:
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/install.sh | bash
#
# After this completes, double-click Sherlock in /Applications to launch.

set -euo pipefail

# ---- EDIT THIS LINE BEFORE PUBLISHING ----
REPO_URL="${SHERLOCK_REPO_URL:-https://github.com/KaitouKid1412/sherlock.git}"
# ------------------------------------------

APP_DIR="$HOME/Library/Application Support/Sherlock"
APPLICATIONS="/Applications"
MIN_NODE_MAJOR=20

say()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!  %s\033[0m\n" "$*" >&2; }
die()  { printf "\033[1;31mxx  %s\033[0m\n" "$*" >&2; exit 1; }

# 1. macOS check
[ "$(uname -s)" = "Darwin" ] || die "Sherlock currently supports macOS only."

# 2. Node 20+ check (opens the official .pkg installer if missing/old)
ensure_node() {
  local current_major=0
  if command -v node >/dev/null 2>&1; then
    current_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if [ "$current_major" -ge "$MIN_NODE_MAJOR" ]; then
    say "Node $(node -v) detected."
    return 0
  fi

  warn "Node ${MIN_NODE_MAJOR}+ is required (found: ${current_major:-none})."
  say "Downloading the official Node.js LTS installer..."

  local index_url="https://nodejs.org/dist/latest-v${MIN_NODE_MAJOR}.x/"
  local pkg_name pkg_url tmp_pkg
  pkg_name="$(curl -fsSL "$index_url" | grep -oE "node-v[0-9.]+\.pkg" | head -1)"
  [ -n "$pkg_name" ] || die "Couldn't find a Node .pkg installer at $index_url"
  pkg_url="${index_url}${pkg_name}"
  tmp_pkg="/tmp/$pkg_name"
  curl -fL --progress-bar "$pkg_url" -o "$tmp_pkg"

  say "Opening the Node installer. Click through the prompts, then re-run this installer."
  open "$tmp_pkg"
  exit 0
}

ensure_node

# 3. Git check (preinstalled on macOS, but verify)
command -v git >/dev/null 2>&1 || die "git is required but not found. Run: xcode-select --install"

# 4. Clone or update the repo
if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing Sherlock checkout at $APP_DIR"
  git -C "$APP_DIR" fetch origin
  if git -C "$APP_DIR" show-ref --quiet refs/remotes/origin/release; then
    git -C "$APP_DIR" reset --hard origin/release
  else
    git -C "$APP_DIR" reset --hard origin/main
  fi
else
  say "Cloning Sherlock to $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth=1 "$REPO_URL" "$APP_DIR"
fi

# 5. Install dependencies + build the frontend
say "Installing dependencies (this can take a minute)..."
( cd "$APP_DIR" && npm install --silent )

say "Building the frontend..."
( cd "$APP_DIR" && npm run build --silent )

# 6. Make sure the launcher is executable
chmod +x "$APP_DIR/scripts/launcher.sh"
chmod +x "$APP_DIR/packaging/Sherlock.app/Contents/MacOS/Sherlock"

# 7. Copy Sherlock.app into /Applications (replace if exists)
say "Installing Sherlock.app into $APPLICATIONS"
rm -rf "$APPLICATIONS/Sherlock.app"
cp -R "$APP_DIR/packaging/Sherlock.app" "$APPLICATIONS/Sherlock.app"

# 8. Done
cat <<EOF

\033[1;32m✓ Sherlock installed.\033[0m

Next:
  • If you haven't already, install + sign in to the Claude Code CLI:
      curl -fsSL https://claude.ai/install.sh | bash
      claude login

  • Then launch Sherlock from /Applications or Spotlight.

EOF
