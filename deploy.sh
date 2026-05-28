#!/usr/bin/env bash
# TissuePlex — server setup script
#
# Run this ONCE on a fresh Ubuntu 24.04 server (as root or with sudo).
# It installs Docker, clones the repo, writes config files, and starts the app.
#
# Usage:
#   bash deploy.sh
#
# To update TissuePlex after a code change:
#   cd /opt/tissuplex && git pull
#   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

set -euo pipefail

REPO_URL="https://github.com/RaredonLab/TissuePlex.git"
REPO_DIR="/opt/tissuplex"

echo "========================================"
echo "  TissuePlex — server setup"
echo "========================================"
echo

# ── 1. System updates ─────────────────────────────────────────────────────────
echo "[1/6] Updating system packages..."
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q git curl rsync

# ── 2. Install Docker ─────────────────────────────────────────────────────────
if command -v docker &>/dev/null; then
  echo "[2/6] Docker already installed — skipping."
else
  echo "[2/6] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# ── 3. Clone or update repo ───────────────────────────────────────────────────
if [ -d "$REPO_DIR/.git" ]; then
  echo "[3/6] Repo already exists — pulling latest changes..."
  git -C "$REPO_DIR" pull
else
  echo "[3/6] Cloning TissuePlex..."
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"

# ── 4. Collect configuration ──────────────────────────────────────────────────
echo
echo "[4/6] Configuration"
echo "---------------------------------------"
read -rp "  Domain name (e.g. tissuplex.yourdomain.com): " DOMAIN
read -rp "  Data directory on this server (e.g. /mnt/tissuplex-data): " DATA_DIR

if [ ! -d "$DATA_DIR" ]; then
  echo "  WARNING: $DATA_DIR does not exist. Creating it now."
  mkdir -p "$DATA_DIR"
fi

# ── 5. Write config files ─────────────────────────────────────────────────────
echo
echo "[5/6] Writing Caddyfile and .env.prod..."

cat > "$REPO_DIR/Caddyfile" <<EOF
$DOMAIN {
    reverse_proxy frontend:80

    # To add password protection, see docs/cloud-deploy.md → "Password protection".
}
EOF

cat > "$REPO_DIR/.env.prod" <<EOF
DATA_PATH=$DATA_DIR
DUCKDB_MEMORY_LIMIT=8GB
BACKEND_MEMORY_LIMIT=12g
EOF

# ── 6. Build and start containers ─────────────────────────────────────────────
echo "[6/6] Building and starting TissuePlex (this may take a few minutes)..."
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

echo
echo "========================================"
echo "  Setup complete"
echo "========================================"
echo
echo "  Next steps:"
echo "  1. Upload your data:  run upload-data.sh on your Mac"
echo "  2. Point DNS:         create an A record for $DOMAIN → $(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')"
echo "  3. Access the viewer: https://$DOMAIN  (ready once DNS propagates, ~5–60 min)"
echo
echo "  Useful commands:"
echo "    View logs:    docker compose -f /opt/tissuplex/docker-compose.prod.yml logs -f"
echo "    Status:       docker compose -f /opt/tissuplex/docker-compose.prod.yml ps"
echo "    Stop:         docker compose -f /opt/tissuplex/docker-compose.prod.yml down"
echo "    Update code:  cd /opt/tissuplex && git pull && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build"
