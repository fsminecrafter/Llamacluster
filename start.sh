#!/usr/bin/env bash
# Start LlamaCluster.
#   ./start.sh                controller + new web UI (builds it on first run)
#   ./start.sh --worker       controller + a worker on this computer, registered automatically
#   ./start.sh --classic      keep the old single-file UI at /
#   ./start.sh --rebuild      rebuild the web UI first
# Any other option (--port, --token, --local-only, ...) goes to controller.py. See ./start.sh --help.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "Python 3 is required (https://www.python.org/downloads/)." >&2; exit 1; }
exec "$PY" launcher.py "$@"
