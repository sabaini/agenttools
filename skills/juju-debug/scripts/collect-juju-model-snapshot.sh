#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage:
  collect-juju-model-snapshot.sh <model> [output-dir]

Environment:
  JUJU_DEBUG_FILTER     Regex used for filtered debug logs.
                        Default: storage|volume|attachment|attach|osd-devices|osd-journals|install|config-changed|remote state|relation
  JUJU_SKIP_FULL_DEBUG  When set to 1, skip the full debug log and only collect the filtered one.

Examples:
  collect-juju-model-snapshot.sh my-model
  collect-juju-model-snapshot.sh my-model artifacts/my-model
  JUJU_SKIP_FULL_DEBUG=1 collect-juju-model-snapshot.sh my-model artifacts/my-model
EOF
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: missing required command: $1" >&2
        exit 1
    }
}

run_capture() {
    local relpath="$1"
    shift

    local stdout_path="$outdir/$relpath"
    local stderr_path="${stdout_path}.stderr"
    local failed_path="${stdout_path}.failed"
    local rc=0

    mkdir -p "$(dirname "$stdout_path")"
    echo "==> $relpath" >&2

    if "$@" >"$stdout_path" 2>"$stderr_path"; then
        rc=0
    else
        rc=$?
        {
            printf 'exit_code=%s\n' "$rc"
            printf 'command='
            printf '%q ' "$@"
            printf '\n'
        } >"$failed_path"
    fi

    if [[ ! -s "$stderr_path" ]]; then
        rm -f "$stderr_path"
    fi

    return 0
}

safe_name() {
    local value="$1"
    value="${value//\//-}"
    value="${value//:/-}"
    printf '%s' "$value"
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
    usage
    exit 0
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
    usage >&2
    exit 2
fi

require_cmd juju
require_cmd python3

model="$1"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
outdir="${2:-juju-snapshot-$(safe_name "$model")-$timestamp}"
debug_filter="${JUJU_DEBUG_FILTER:-storage|volume|attachment|attach|osd-devices|osd-journals|install|config-changed|remote state|relation}"
skip_full_debug="${JUJU_SKIP_FULL_DEBUG:-0}"

mkdir -p "$outdir" "$outdir/units" "$outdir/storage" "$outdir/remote"

cat >"$outdir/metadata.txt" <<EOF
model=$model
generated_utc=$timestamp
host=$(hostname -f 2>/dev/null || hostname)
cwd=$(pwd)
debug_filter=$debug_filter
skip_full_debug=$skip_full_debug
EOF

run_capture juju-version.txt juju version
run_capture controllers.yaml juju controllers --format yaml
run_capture show-controller.yaml juju show-controller --format yaml
run_capture show-model.yaml juju show-model -m "$model" --format yaml
run_capture model-config.txt juju model-config -m "$model"
run_capture status.txt juju status -m "$model"
run_capture status.yaml juju status -m "$model" --format yaml
run_capture status.json juju status -m "$model" --format json
run_capture storage.txt juju storage -m "$model"
run_capture storage.yaml juju storage -m "$model" --format yaml
run_capture storage.json juju storage -m "$model" --format json
run_capture storage-pools.yaml juju storage-pools -m "$model" --format yaml

if [[ "$skip_full_debug" == "1" ]]; then
    echo "==> debug-filtered.log" >&2
    if juju debug-log -m "$model" --replay --no-tail 2>"$outdir/debug-filtered.log.stderr" | grep -E "$debug_filter" >"$outdir/debug-filtered.log"; then
        :
    else
        rc=$?
        if [[ $rc -ne 1 ]]; then
            {
                printf 'exit_code=%s\n' "$rc"
                printf 'command=juju debug-log -m %q --replay --no-tail | grep -E %q\n' "$model" "$debug_filter"
            } >"$outdir/debug-filtered.log.failed"
        fi
    fi
    if [[ ! -s "$outdir/debug-filtered.log.stderr" ]]; then
        rm -f "$outdir/debug-filtered.log.stderr"
    fi
else
    run_capture debug.log juju debug-log -m "$model" --replay --no-tail
    if [[ -f "$outdir/debug.log" ]]; then
        grep -E "$debug_filter" "$outdir/debug.log" >"$outdir/debug-filtered.log" || true
    fi
fi

python3 - "$outdir/status.json" >"$outdir/units.tsv" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.exists():
    raise SystemExit(0)

try:
    data = json.loads(path.read_text())
except Exception:
    raise SystemExit(0)

apps = data.get("applications") or {}
for app_name in sorted(apps):
    app = apps.get(app_name) or {}
    units = app.get("units") or {}
    for unit_name in sorted(units):
        unit = units.get(unit_name) or {}
        machine = unit.get("machine") or ""
        print(f"{unit_name}\t{machine}")
PY

python3 - "$outdir/storage.json" >"$outdir/storage-ids.txt" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.exists():
    raise SystemExit(0)

try:
    data = json.loads(path.read_text())
except Exception:
    raise SystemExit(0)

ids = []
seen = set()
storage = data.get("storage") if isinstance(data, dict) else None

if isinstance(storage, dict):
    ids.extend(storage.keys())
elif isinstance(storage, list):
    for item in storage:
        if not isinstance(item, dict):
            continue
        for key in ("storage-id", "storage_id", "id", "name"):
            value = item.get(key)
            if isinstance(value, str):
                ids.append(value)
                break
        else:
            if len(item) == 1:
                only_key = next(iter(item.keys()))
                if isinstance(only_key, str):
                    ids.append(only_key)

for storage_id in ids:
    if storage_id not in seen:
        seen.add(storage_id)
        print(storage_id)
PY

while IFS= read -r storage_id; do
    [[ -n "$storage_id" ]] || continue
    storage_safe="$(safe_name "$storage_id")"
    run_capture "storage/${storage_safe}.show-storage.yaml" juju show-storage -m "$model" "$storage_id" --format yaml
    run_capture "storage/${storage_safe}.show-storage.json" juju show-storage -m "$model" "$storage_id" --format json
done <"$outdir/storage-ids.txt"

declare -A seen_machines=()
while IFS=$'\t' read -r unit machine; do
    [[ -n "$unit" ]] || continue
    unit_safe="$(safe_name "$unit")"

    run_capture "units/${unit_safe}.show-unit.yaml" juju show-unit -m "$model" "$unit" --format yaml
    run_capture "units/${unit_safe}.show-unit.json" juju show-unit -m "$model" "$unit" --format json
    run_capture "units/${unit_safe}.status-log.txt" juju show-status-log -m "$model" "$unit"

    if [[ -f "$outdir/debug-filtered.log" ]]; then
        grep -E "$unit|unit-${unit_safe}${machine:+|machine-$machine}" "$outdir/debug-filtered.log" >"$outdir/units/${unit_safe}.debug.log" || true
    fi

    remote_cmd="set -euo pipefail; \
        echo '### hostname'; hostname; \
        echo '### lsblk -f'; lsblk -f || true; \
        echo '### /dev/disk/by-id'; ls -l /dev/disk/by-id || true; \
        echo '### unit log'; sudo tail -n 200 /var/log/juju/unit-${unit_safe}.log || true"
    run_capture "remote/${unit_safe}.inspect.txt" juju ssh -m "$model" "$unit" "$remote_cmd"

    if [[ -n "$machine" && -z ${seen_machines[$machine]+x} ]]; then
        seen_machines[$machine]=1
        machine_cmd="set -euo pipefail; \
            echo '### hostname'; hostname; \
            echo '### lsblk -f'; lsblk -f || true; \
            echo '### /dev/disk/by-id'; ls -l /dev/disk/by-id || true; \
            echo '### juju machine log'; sudo tail -n 200 /var/log/juju/machine-${machine}.log || true"
        run_capture "remote/machine-${machine}.inspect.txt" juju ssh -m "$model" "$machine" "$machine_cmd"
    fi
done <"$outdir/units.tsv"

python3 - "$model" "$outdir" >"$outdir/summary.md" <<'PY'
import json
import sys
from pathlib import Path

model = sys.argv[1]
outdir = Path(sys.argv[2])
status_path = outdir / "status.json"
storage_path = outdir / "storage.json"


def load_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def iter_units(status_doc):
    if not isinstance(status_doc, dict):
        return []
    apps = status_doc.get("applications") or {}
    rows = []
    for app_name in sorted(apps):
        app = apps.get(app_name) or {}
        units = app.get("units") or {}
        for unit_name in sorted(units):
            unit = units.get(unit_name) or {}
            rows.append(
                {
                    "unit": unit_name,
                    "machine": unit.get("machine") or "",
                    "public_address": unit.get("public-address") or "",
                    "workload": (unit.get("workload-status") or {}).get("current") or "",
                    "workload_message": (unit.get("workload-status") or {}).get("message") or "",
                    "agent": (unit.get("juju-status") or {}).get("current") or "",
                    "agent_message": (unit.get("juju-status") or {}).get("message") or "",
                }
            )
    return rows


def iter_storage(storage_doc):
    if not isinstance(storage_doc, dict):
        return []
    storage = storage_doc.get("storage") or {}
    rows = []
    if isinstance(storage, dict):
        iterable = storage.items()
    else:
        iterable = []
    for storage_id, detail in iterable:
        detail = detail or {}
        attachments = ((detail.get("attachments") or {}).get("units") or {})
        if attachments:
            attachment_parts = []
            for unit_name in sorted(attachments):
                attachment = attachments.get(unit_name) or {}
                machine = attachment.get("machine") or ""
                location = attachment.get("location") or "<missing>"
                attachment_parts.append(f"{unit_name}@{machine} location={location}")
            attachment_text = "; ".join(attachment_parts)
        else:
            attachment_text = "<none>"
        rows.append(
            {
                "storage_id": storage_id,
                "status": (detail.get("status") or {}).get("current") or "",
                "attachments": attachment_text,
            }
        )
    return rows


status_doc = load_json(status_path)
storage_doc = load_json(storage_path)
unit_rows = iter_units(status_doc)
storage_rows = iter_storage(storage_doc)

lines = [
    f"# Juju model snapshot: {model}",
    "",
    f"Artifacts: `{outdir}`",
    "",
    "## Units",
]

if unit_rows:
    for row in unit_rows:
        lines.append(
            "- "
            f"`{row['unit']}` on machine `{row['machine'] or '<unknown>'}`: "
            f"workload=`{row['workload'] or '<unknown>'}` ({row['workload_message'] or 'no message'}), "
            f"agent=`{row['agent'] or '<unknown>'}` ({row['agent_message'] or 'no message'}), "
            f"address=`{row['public_address'] or '<unknown>'}`"
        )
else:
    lines.append("- No unit data available.")

lines.extend(["", "## Storage attachments"])
if storage_rows:
    for row in storage_rows:
        lines.append(
            f"- `{row['storage_id']}` status=`{row['status'] or '<unknown>'}` attachments: {row['attachments']}"
        )
else:
    lines.append("- No storage data available.")

lines.extend(
    [
        "",
        "## Key files",
        "- `status.txt`, `status.yaml`, `status.json`",
        "- `storage.txt`, `storage.yaml`, `storage.json`",
        "- `debug.log` and/or `debug-filtered.log`",
        "- `units/` for per-unit `show-unit`, status-log, and filtered debug excerpts",
        "- `remote/` for remote unit and machine inspection output",
    ]
)

print("\n".join(lines))
PY

echo "Snapshot written to $outdir" >&2
