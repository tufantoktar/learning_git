#!/usr/bin/env bash
set -euo pipefail

PLIST_PATH="${HOME}/Library/LaunchAgents/com.tefas.analysis.daily.plist"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This helper is for macOS launchd only."
  exit 1
fi

if [[ -f "${PLIST_PATH}" ]]; then
  launchctl unload "${PLIST_PATH}" 2>/dev/null || true
  rm -f "${PLIST_PATH}"
  echo "Removed launchd job: ${PLIST_PATH}"
else
  echo "No launchd job found at: ${PLIST_PATH}"
fi
