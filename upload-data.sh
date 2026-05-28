#!/usr/bin/env bash
# TissuePlex — data upload script
#
# Run this on your Mac to transfer your Xenium dataset(s) to the server.
# rsync is resumable — if the upload is interrupted, just run the script again
# and it will continue where it left off.
#
# Usage:
#   bash upload-data.sh

set -euo pipefail

# ── Configuration — edit these two lines ──────────────────────────────────────
SERVER_IP="YOUR_SERVER_IP"                          # e.g. 143.198.50.12
LOCAL_DATA_DIR="/Users/msbr/Large Files/Xenium/for-docker-testing"
# ─────────────────────────────────────────────────────────────────────────────

REMOTE_DATA_DIR="/mnt/tissuplex-data"

echo "Uploading data to ${SERVER_IP}:${REMOTE_DATA_DIR}"
echo "Source: $LOCAL_DATA_DIR"
echo
echo "This may take a long time for large datasets."
echo "The upload is resumable — re-run this script if it is interrupted."
echo

rsync \
  --archive \
  --verbose \
  --progress \
  --partial \
  --human-readable \
  --exclude="*.tmp" \
  --exclude=".DS_Store" \
  "$LOCAL_DATA_DIR/" \
  "root@${SERVER_IP}:${REMOTE_DATA_DIR}/"

echo
echo "Upload complete."
echo "You can now open TissuePlex in your browser."
