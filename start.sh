#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data/files logs run
if [[ -f run/portal.pid ]] && kill -0 "$(cat run/portal.pid)" 2>/dev/null; then
  echo "portal already running: $(cat run/portal.pid)"
  exit 0
fi
nohup env PORT="${PORT:-8088}" node app.js >> logs/portal.log 2>&1 &
echo "$!" > run/portal.pid
echo "portal started: pid=$! port=${PORT:-8088}"
