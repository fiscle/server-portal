#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -f run/portal.pid ]]; then
  pid="$(cat run/portal.pid)"
  kill "$pid" 2>/dev/null || true
  rm -f run/portal.pid
  echo "portal stopped"
else
  echo "portal is not running"
fi
