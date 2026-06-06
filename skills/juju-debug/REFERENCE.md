# Juju debug reference

This reference complements `SKILL.md` with concrete commands, example layouts, and quick interpretation notes.

## Quick start

From the repository root, collect a full model snapshot:

```bash
.pi/skills/juju-debug/scripts/collect-juju-model-snapshot.sh <model> artifacts/<model>
```

Compare a failing model with a working control:

```bash
.pi/skills/juju-debug/scripts/compare-juju-storage.sh <failing-model> <working-model>
```

If you are already working from inside the skill directory, the shorter paths are:

```bash
scripts/collect-juju-model-snapshot.sh <model> artifacts/<model>
scripts/compare-juju-storage.sh <failing-model> <working-model>
```

## Snapshot collector examples

### Full snapshot

```bash
.pi/skills/juju-debug/scripts/collect-juju-model-snapshot.sh my-model artifacts/my-model
```

Expected result:
- writes a new artifact directory
- prints `Snapshot written to artifacts/my-model`
- captures model, storage, unit, debug, and remote inspection data

Typical output tree:

```text
artifacts/my-model/
├── controllers.yaml
├── debug-filtered.log
├── debug.log
├── metadata.txt
├── model-config.txt
├── show-controller.yaml
├── show-model.yaml
├── status.json
├── status.txt
├── status.yaml
├── storage.json
├── storage.txt
├── storage.yaml
├── storage/
│   ├── osd-devices-0.show-storage.json
│   └── osd-devices-0.show-storage.yaml
├── summary.md
├── units/
│   ├── ceph-osd-0.debug.log
│   ├── ceph-osd-0.show-unit.json
│   ├── ceph-osd-0.show-unit.yaml
│   └── ceph-osd-0.status-log.txt
└── remote/
    ├── ceph-osd-0.inspect.txt
    └── machine-0.inspect.txt
```

### Faster filtered snapshot

If the full debug log is too large, skip it and keep only the filtered one:

```bash
JUJU_SKIP_FULL_DEBUG=1 \
JUJU_DEBUG_FILTER='storage|attachment|attach|install|config-changed|remote state' \
.pi/skills/juju-debug/scripts/collect-juju-model-snapshot.sh my-model artifacts/my-model
```

Expected result:
- no `debug.log`
- yes `debug-filtered.log`
- faster collection on large models

## Storage comparison examples

### Default OSD comparison

```bash
.pi/skills/juju-debug/scripts/compare-juju-storage.sh failing-model working-model
```

Defaults:
- unit: `ceph-osd/0`
- storage id: `osd-devices/0`

Expected result:
- collects filtered snapshots under a temp directory or `JUJU_COMPARE_OUTDIR`
- prints a markdown comparison report
- highlights missing storage `location`, `Attached:false`, missing `initial storage attachments ready`, and missing install-hook progression when present

### Compare a different unit/storage id

```bash
JUJU_COMPARE_UNIT=ceph-osd/2 \
JUJU_COMPARE_STORAGE_ID=osd-devices/2 \
JUJU_COMPARE_OUTDIR=artifacts/compare-osd-2 \
.pi/skills/juju-debug/scripts/compare-juju-storage.sh failing-model working-model
```

Expected result:
- report written under `artifacts/compare-osd-2/comparison.md`
- filtered failing and working snapshots in sibling directories

## How to read `summary.md`

The snapshot collector generates a compact summary. Typical lines look like:

```text
- `ceph-osd/0` on machine `0`: workload=`waiting` (agent initialising), agent=`allocating` (no message), address=`10.117.139.10`
- `osd-devices/0` status=`attached` attachments: ceph-osd/0@0 location=<missing>
```

Interpretation:
- good for quick scanning
- not authoritative enough for root cause on its own
- use it to decide which raw files to inspect next

## High-signal patterns

### Pattern: storage looks attached globally but unit is stuck

Look for this combination:

```text
summary.md: location=<missing>
debug-filtered.log: Attached:false
debug-filtered.log: waiting for remote state change
remote/machine-0.inspect.txt: disk visible in lsblk or /dev/disk/by-id
```

Likely meaning:
- model-level storage state and unit-level attachment state disagree
- often worth comparing with a nearby working control immediately

### Pattern: unit never reaches install

Look for:

```text
debug-filtered.log: resuming charm install
debug-filtered.log: no ran "install" hook
units/<unit>.status-log.txt: stuck in allocating or waiting
```

Likely meaning:
- block is before or during uniter scheduling of initial operations
- storage and remote-state logs become especially important

### Pattern: relation problem after hooks run

Look for:

```text
debug-filtered.log: ran "install" hook
units/<unit>.status-log.txt: blocked/waiting with relation message
show-unit output: relation-info present but incomplete
```

Likely meaning:
- problem has moved past provisioning/storage and into relation wiring or charm logic

## Suggested review order

When a snapshot is collected, inspect files in this order:

1. `summary.md`
2. `status.txt`
3. `storage.yaml` and `storage/<id>.show-storage.yaml`
4. `units/<unit>.show-unit.yaml`
5. `units/<unit>.status-log.txt`
6. `debug-filtered.log`
7. `remote/<unit>.inspect.txt`
8. `remote/machine-<n>.inspect.txt`

## Example minimal workflow

```bash
juju model-config -m failing-model logging-config="<root>=DEBUG;unit=DEBUG"
.pi/skills/juju-debug/scripts/collect-juju-model-snapshot.sh failing-model artifacts/failing-model
juju model-config -m working-model logging-config="<root>=DEBUG;unit=DEBUG"
.pi/skills/juju-debug/scripts/collect-juju-model-snapshot.sh working-model artifacts/working-model
.pi/skills/juju-debug/scripts/compare-juju-storage.sh failing-model working-model artifacts/storage-compare.md
```

Expected result:
- one self-contained snapshot per model
- one comparison report
- enough evidence for a bug report or fix plan

## Bug-report-ready excerpts

Good snippets to lift from the artifacts:
- exact command sequence used to reproduce
- `juju version` and controller version lines
- one `show-storage` excerpt
- one `debug-filtered.log` excerpt showing the stuck state
- one working-control excerpt showing the expected path

## Notes

- Prefer a nearby working control over deeper speculation.
- Keep snapshots before destroying models.
- Avoid manual hook execution outside Juju hook context; it usually creates noise rather than evidence.
