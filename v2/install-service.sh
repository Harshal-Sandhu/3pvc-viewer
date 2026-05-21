#!/usr/bin/env bash
# Install influxdb-ui v2 as a systemd service so it runs on boot and survives logout.
# Run as the user that owns the checkout (e.g. gor) on the server. Needs sudo.
#
# Usage:
#   cd ~/3pvc-viewer/v2
#   bash install-service.sh
set -euo pipefail

NODE=$(command -v node)
if [[ -z "$NODE" ]]; then
    echo "node not in PATH. Activate nvm first (e.g. 'nvm use 20') or 'export PATH=...'." >&2
    exit 1
fi
WORKDIR="$(pwd)"
SVC_USER="$(whoami)"
UNIT=/etc/systemd/system/influxdb-ui-v2.service

echo "node:     $NODE"
echo "workdir:  $WORKDIR"
echo "user:     $SVC_USER"

sudo tee "$UNIT" > /dev/null <<EOF
[Unit]
Description=influxdb-ui v2
After=network.target

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$WORKDIR
ExecStart=$NODE server.js
Restart=always
RestartSec=5
StandardOutput=append:$WORKDIR/server.log
StandardError=append:$WORKDIR/server.log

[Install]
WantedBy=multi-user.target
EOF

pkill -f "node server.js" 2>/dev/null || true
sleep 1
sudo systemctl daemon-reload
sudo systemctl enable --now influxdb-ui-v2
sudo systemctl status influxdb-ui-v2 --no-pager
