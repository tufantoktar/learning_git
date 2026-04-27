#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/daily_run.log"

mkdir -p "${LOG_DIR}"
cd "${PROJECT_DIR}"

if [[ -f ".venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source ".venv/bin/activate"
fi

PYTHON_BIN="${PYTHON:-python}"

{
  echo "===== TEFAS daily run started at $(date -u '+%Y-%m-%dT%H:%M:%SZ') ====="
  "${PYTHON_BIN}" main.py --all-funds --report-language tr "$@"
  echo "===== TEFAS daily run finished at $(date -u '+%Y-%m-%dT%H:%M:%SZ') ====="
} >> "${LOG_FILE}" 2>&1
