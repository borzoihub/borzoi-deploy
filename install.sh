#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Borzoi install bootstrap — fresh Pi one-liner.
#
# Typical invocation:
#   curl -fsSL https://raw.githubusercontent.com/borzoihub/borzoi-deploy/main/install.sh | bash
#
# Env var overrides:
#   INSTALL_DIR          target path (default: /opt/borzoi)
#   BORZOI_DEPLOY_REPO   git URL for the deploy bundle
# ============================================================================

INSTALL_DIR="${INSTALL_DIR:-/opt/borzoi}"
BORZOI_DEPLOY_REPO="${BORZOI_DEPLOY_REPO:-https://github.com/borzoihub/borzoi-deploy.git}"

echo "Installing borzoi-deploy → $INSTALL_DIR"
echo "Source repo: $BORZOI_DEPLOY_REPO"

# Ensure parent dir exists and is owned by invoking user.
sudo mkdir -p "$INSTALL_DIR"
sudo chown "$USER" "$INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Existing clone found — pulling latest."
  git -C "$INSTALL_DIR" pull
else
  echo "Cloning deploy bundle..."
  git clone --depth 1 "$BORZOI_DEPLOY_REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
exec ./setup.sh
