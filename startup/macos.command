#!/usr/bin/env bash
# macOS double-click launcher. Finder opens this file in Terminal.
here="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/env bash "$here/linux.sh" "$@"
