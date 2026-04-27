#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE="${SCRIPT_DIR}/com.tefas.analysis.daily.plist.example"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/com.tefas.analysis.daily.plist"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This helper is for macOS launchd only."
  exit 1
fi

mkdir -p "${LAUNCH_AGENTS_DIR}" "${PROJECT_DIR}/logs"

PROJECT_DIR_ESCAPED="${PROJECT_DIR//&/\\&}"
sed "s|__PROJECT_DIR__|${PROJECT_DIR_ESCAPED}|g" "${TEMPLATE}" > "${PLIST_PATH}"

launchctl unload "${PLIST_PATH}" 2>/dev/null || true
launchctl load "${PLIST_PATH}"

echo "Installed launchd job: ${PLIST_PATH}"
echo "Daily run script: ${PROJECT_DIR}/scripts/run_daily_tefas.sh"
echo "View logs with:"
echo "  tail -f ${PROJECT_DIR}/logs/daily_run.log"
echo "  tail -f ${PROJECT_DIR}/logs/launchd_stdout.log"
echo "  tail -f ${PROJECT_DIR}/logs/launchd_stderr.log"
