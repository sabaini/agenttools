#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage:
  compare-juju-storage.sh <failing-model> <working-model> [output-file]

Environment:
  JUJU_COMPARE_UNIT        Unit to compare. Default: ceph-osd/0
  JUJU_COMPARE_STORAGE_ID  Storage id to compare. Default: osd-devices/0
  JUJU_COMPARE_OUTDIR      Directory for intermediate snapshots and report.
  JUJU_DEBUG_FILTER        Regex used for filtered debug logs.

Examples:
  compare-juju-storage.sh failing-model working-model
  JUJU_COMPARE_UNIT=ceph-osd/1 JUJU_COMPARE_STORAGE_ID=osd-devices/1 \
    compare-juju-storage.sh failing-model working-model artifacts/compare.md
EOF
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
    usage
    exit 0
fi

if [[ $# -lt 2 || $# -gt 3 ]]; then
    usage >&2
    exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
collector="$script_dir/collect-juju-model-snapshot.sh"

if [[ ! -x "$collector" ]]; then
    echo "error: helper script not executable: $collector" >&2
    exit 1
fi

failing_model="$1"
working_model="$2"
output_file="${3:-}"
compare_unit="${JUJU_COMPARE_UNIT:-ceph-osd/0}"
compare_storage_id="${JUJU_COMPARE_STORAGE_ID:-osd-devices/0}"
debug_filter="${JUJU_DEBUG_FILTER:-storage|volume|attachment|attach|osd-devices|osd-journals|install|config-changed|remote state|relation}"
outdir="${JUJU_COMPARE_OUTDIR:-$(mktemp -d -t juju-storage-compare.XXXXXX)}"
report_path="$outdir/comparison.md"

mkdir -p "$outdir"

echo "==> collecting failing model snapshot: $failing_model" >&2
JUJU_SKIP_FULL_DEBUG=1 JUJU_DEBUG_FILTER="$debug_filter" "$collector" "$failing_model" "$outdir/failing" >/dev/null

echo "==> collecting working model snapshot: $working_model" >&2
JUJU_SKIP_FULL_DEBUG=1 JUJU_DEBUG_FILTER="$debug_filter" "$collector" "$working_model" "$outdir/working" >/dev/null

python3 - "$outdir/failing" "$outdir/working" "$failing_model" "$working_model" "$compare_unit" "$compare_storage_id" >"$report_path" <<'PY'
import json
import re
import sys
from pathlib import Path

failing_dir = Path(sys.argv[1])
working_dir = Path(sys.argv[2])
failing_model = sys.argv[3]
working_model = sys.argv[4]
unit_name = sys.argv[5]
storage_id = sys.argv[6]


def safe_name(value: str) -> str:
    return value.replace("/", "-").replace(":", "-")


def load_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def load_text(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return path.read_text()
    except Exception:
        return ""


def get_unit_status(status_doc, target_unit: str):
    if not isinstance(status_doc, dict):
        return {}
    apps = status_doc.get("applications") or {}
    for app in apps.values():
        app = app or {}
        units = app.get("units") or {}
        if target_unit in units:
            unit = units[target_unit] or {}
            return {
                "machine": unit.get("machine") or "",
                "public_address": unit.get("public-address") or "",
                "workload": (unit.get("workload-status") or {}).get("current") or "",
                "workload_message": (unit.get("workload-status") or {}).get("message") or "",
                "agent": (unit.get("juju-status") or {}).get("current") or "",
                "agent_message": (unit.get("juju-status") or {}).get("message") or "",
            }
    return {}


def get_storage_detail(snapshot_dir: Path, target_storage_id: str):
    direct = snapshot_dir / "storage" / f"{safe_name(target_storage_id)}.show-storage.json"
    doc = load_json(direct)
    if isinstance(doc, dict):
        if target_storage_id in doc and isinstance(doc[target_storage_id], dict):
            return doc[target_storage_id]
        if len(doc) == 1:
            only_value = next(iter(doc.values()))
            if isinstance(only_value, dict):
                return only_value

    storage_doc = load_json(snapshot_dir / "storage.json")
    if isinstance(storage_doc, dict):
        storage = storage_doc.get("storage") or {}
        if isinstance(storage, dict) and target_storage_id in storage:
            detail = storage[target_storage_id]
            if isinstance(detail, dict):
                return detail
    return {}


def summarize_storage(detail, target_unit: str):
    detail = detail or {}
    attachments = ((detail.get("attachments") or {}).get("units") or {})
    attachment = attachments.get(target_unit) or {}
    return {
        "status": (detail.get("status") or {}).get("current") or "",
        "machine": attachment.get("machine") or "",
        "location": attachment.get("location") or "",
        "life": attachment.get("life") or "",
    }


def summarize_debug(text: str):
    lines = [line for line in text.splitlines() if line.strip()]
    key_patterns = [
        r"got storage change",
        r"storage-attached",
        r"initial storage attachments ready",
        r'ran "install" hook',
        r"Attached:true",
        r"Attached:false",
        r"waiting for remote state change",
    ]
    excerpt = []
    for line in lines:
        if any(re.search(pattern, line) for pattern in key_patterns):
            excerpt.append(line)
    excerpt = excerpt[-12:]
    return {
        "storage_change": any("got storage change" in line for line in lines),
        "storage_attached_hook": any("storage-attached" in line for line in lines),
        "initial_ready": any("initial storage attachments ready" in line for line in lines),
        "install_ran": any('ran "install" hook' in line for line in lines),
        "attached_true_count": sum("Attached:true" in line for line in lines),
        "attached_false_count": sum("Attached:false" in line for line in lines),
        "waiting_remote_count": sum("waiting for remote state change" in line for line in lines),
        "excerpt": excerpt,
    }


def render_model_section(title: str, model: str, unit_status: dict, storage_summary: dict, debug_summary: dict):
    lines = [f"## {title}: `{model}`", ""]
    lines.append(
        "- Unit state: "
        f"workload=`{unit_status.get('workload') or '<unknown>'}` ({unit_status.get('workload_message') or 'no message'}), "
        f"agent=`{unit_status.get('agent') or '<unknown>'}` ({unit_status.get('agent_message') or 'no message'}), "
        f"machine=`{unit_status.get('machine') or '<unknown>'}`, "
        f"address=`{unit_status.get('public_address') or '<unknown>'}`"
    )
    location = storage_summary.get("location") or "<missing>"
    lines.append(
        "- Storage state: "
        f"status=`{storage_summary.get('status') or '<unknown>'}`, "
        f"machine=`{storage_summary.get('machine') or '<unknown>'}`, "
        f"location=`{location}`, life=`{storage_summary.get('life') or '<unknown>'}`"
    )
    lines.append(
        "- Debug signals: "
        f"storage_change={debug_summary['storage_change']}, "
        f"storage_attached_hook={debug_summary['storage_attached_hook']}, "
        f"initial_ready={debug_summary['initial_ready']}, "
        f"install_ran={debug_summary['install_ran']}, "
        f"Attached:true={debug_summary['attached_true_count']}, "
        f"Attached:false={debug_summary['attached_false_count']}, "
        f"waiting_for_remote_state_change={debug_summary['waiting_remote_count']}"
    )
    lines.extend(["", "### Key log lines", "```text"])
    if debug_summary["excerpt"]:
        lines.extend(debug_summary["excerpt"])
    else:
        lines.append("<no matching log lines>")
    lines.extend(["```", ""])
    return lines


failing_status = get_unit_status(load_json(failing_dir / "status.json"), unit_name)
working_status = get_unit_status(load_json(working_dir / "status.json"), unit_name)

failing_storage = summarize_storage(get_storage_detail(failing_dir, storage_id), unit_name)
working_storage = summarize_storage(get_storage_detail(working_dir, storage_id), unit_name)

failing_debug = summarize_debug(load_text(failing_dir / "debug-filtered.log"))
working_debug = summarize_debug(load_text(working_dir / "debug-filtered.log"))

lines = [
    "# Juju storage comparison",
    "",
    f"- Compared unit: `{unit_name}`",
    f"- Compared storage id: `{storage_id}`",
    f"- Failing snapshot: `{failing_dir}`",
    f"- Working snapshot: `{working_dir}`",
    "",
]

lines.extend(render_model_section("Failing model", failing_model, failing_status, failing_storage, failing_debug))
lines.extend(render_model_section("Working model", working_model, working_status, working_storage, working_debug))

lines.extend(["## High-signal differences", ""])
differences = []

failing_location = failing_storage.get("location") or ""
working_location = working_storage.get("location") or ""
if not failing_location and working_location:
    differences.append(
        f"- `{storage_id}` is missing a unit attachment location in `{failing_model}`, while `{working_model}` has `{working_location}`."
    )
if failing_debug["attached_false_count"] and working_debug["attached_true_count"]:
    differences.append(
        f"- `{failing_model}` repeatedly reports `Attached:false`, while `{working_model}` reports `Attached:true` for the same storage path."
    )
if failing_debug["waiting_remote_count"] and not working_debug["waiting_remote_count"]:
    differences.append(
        f"- `{failing_model}` waits for a remote state change that never arrives; `{working_model}` does not."
    )
if not failing_debug["initial_ready"] and working_debug["initial_ready"]:
    differences.append(
        f"- `{working_model}` reaches `initial storage attachments ready`, while `{failing_model}` does not."
    )
if not failing_debug["install_ran"] and working_debug["install_ran"]:
    differences.append(
        f"- `{working_model}` runs the install hook for `{unit_name}`, while `{failing_model}` never reaches that point."
    )

if differences:
    lines.extend(differences)
else:
    lines.append("- No obvious diff signals were detected; inspect the raw snapshots.")

print("\n".join(lines))
PY

if [[ -n "$output_file" ]]; then
    mkdir -p "$(dirname "$output_file")"
    cp "$report_path" "$output_file"
fi

cat "$report_path"
echo "Artifacts written to $outdir" >&2
