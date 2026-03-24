#!/usr/bin/env bash
set -euo pipefail

LIVE=0
QUEUE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --live)
      LIVE=1
      shift
      ;;
    --queue)
      QUEUE="${2:-}"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./tests/smoke.sh [--live --queue <queue-name>]

Default mode performs only safe local checks.
Live mode reserves a real machine, validates SSH, and cancels the reservation.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

echo "[1/4] Checking VPN reachability"
ping -c 1 -W 1 10.172.192.1 >/dev/null

echo "[2/4] Checking client commands"
require_cmd cephtools
if command -v testflinger >/dev/null 2>&1; then
  TF_BIN=testflinger
else
  require_cmd testflinger-cli
  TF_BIN=testflinger-cli
fi

echo "[3/4] Checking documented help commands"
cephtools testflinger --help >/dev/null
cephtools testflinger reserve --help >/dev/null
"$TF_BIN" --help >/dev/null
"$TF_BIN" reserve --help >/dev/null
"$TF_BIN" status --help >/dev/null
"$TF_BIN" poll --help >/dev/null
"$TF_BIN" show --help >/dev/null
"$TF_BIN" list-queues --help >/dev/null

if [[ "$LIVE" -eq 0 ]]; then
  echo "[4/4] Safe local checks passed"
  exit 0
fi

[[ -n "$QUEUE" ]] || {
  echo "--queue is required with --live" >&2
  exit 2
}

require_cmd python3
LOG_FILE="$(mktemp)"
JOB_ID=""
SSH_CMD=""

cleanup() {
  if [[ -n "$JOB_ID" ]]; then
    echo "Cleaning up reservation $JOB_ID"
    "$TF_BIN" cancel "$JOB_ID" >/dev/null 2>&1 || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

echo "[4/4] Running live reservation against queue $QUEUE"
set +e
cephtools testflinger reserve "$QUEUE" 2>&1 | tee "$LOG_FILE"
status=${PIPESTATUS[0]}
set -e
[[ $status -eq 0 ]] || {
  echo "Reservation command failed" >&2
  exit "$status"
}

readarray -t parsed < <(python3 - "$LOG_FILE" <<'PY'
import pathlib
import re
import sys
text = pathlib.Path(sys.argv[1]).read_text()
job = re.search(r"job\s+([0-9a-fA-F-]{36})", text)
ssh = re.search(r"^Connect with:\s*(.+)$", text, re.MULTILINE)
if not job:
    raise SystemExit("Could not parse job id from reservation output")
print(job.group(1))
print(ssh.group(1) if ssh else "")
PY
)
JOB_ID="${parsed[0]}"
SSH_CMD="${parsed[1]}"

echo "Parsed job id: $JOB_ID"
[[ -n "$SSH_CMD" ]] || {
  echo "Could not parse SSH command from reservation output" >&2
  exit 1
}

echo "Validating SSH access"
bash -lc "$SSH_CMD 'hostname && sudo -n true && (lsb_release -ds || . /etc/os-release && echo \"\$PRETTY_NAME\")'"

echo "Live reservation validation passed"
