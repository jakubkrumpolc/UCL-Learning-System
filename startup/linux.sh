#!/usr/bin/env bash
# Serve the study site at http://127.0.0.1:8000 and open it.
set -euo pipefail

hold_on_error() {
  status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && -t 0 ]]; then
    echo
    read -r -p "Press Return to close this window. " _ || true
  fi
  exit "$status"
}
trap hold_on_error EXIT

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."

pick_python() {
  local candidate
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 \
      && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 7) else 1)' \
        >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! py="$(pick_python)"; then
  echo "Python 3.7 or newer was not found." >&2
  case "$(uname -s)" in
    Darwin)
      echo "Install it from https://www.python.org/downloads/ or with: brew install python" >&2
      ;;
    *)
      echo "Install Python 3, then run this file again." >&2
      ;;
  esac
  exit 1
fi

# Drop the exit trap before replacing this process. An EXIT trap that
# runs on exec would stop the server from starting.
trap - EXIT
set +e
exec "$py" "$here/serve.py" "$@"
status=$?
set -e
trap hold_on_error EXIT
exit "$status"
