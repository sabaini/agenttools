---
name: juju-debug
description: Debug Juju model, machine, unit, relation, and storage failures by preserving state, enabling DEBUG logging, collecting model snapshots, comparing failing and working controls, reducing to minimal reproducers, and preparing bug reports. Use for stuck units, relation issues, storage attachment problems, and charm lifecycle stalls.
---

# Juju debugging

Use this skill when the failure is primarily inside Juju, the provider, or charm lifecycle execution.

Use it for:
- units stuck in `allocating`, `agent initialising`, `maintenance`, `waiting`, or `error`
- charm hooks that never seem to run or never complete
- relation wiring/data issues
- storage attachment/setup problems
- machine provisioning and unit placement surprises
- cases where you need a minimal reproducer or bug report

If the failure is clearly wrapped in CI or Testflinger orchestration, also use the `juju-testflinger-debug` skill to reduce the outer layers first.

## Core principles

1. **Preserve the failure before changing it.** Keep the model, workspace, and raw logs when possible.
2. **Turn on DEBUG early.** Do this before retrying if you think you will need controller/unit internals.
3. **Build a nearby working control.** Comparing bad vs good is usually faster than inspecting the bad case alone.
4. **Reduce one variable at a time.** Topology, storage, relations, constraints, base, channel, and orchestration layer should be changed deliberately.
5. **Prefer repeatable scripts to ad hoc one-liners.** Use checked-in helpers for snapshots and comparisons.

## First-response checklist

1. Record versions:
   ```bash
   juju version
   juju controllers --format yaml
   juju show-controller --format yaml
   ```
2. Preserve the model if it still exists.
3. Enable DEBUG logging:
   ```bash
   juju model-config -m <model> logging-config="<root>=DEBUG;unit=DEBUG"
   ```
4. Collect a snapshot:
   ```bash
   scripts/collect-juju-model-snapshot.sh <model> artifacts/<model>
   ```
5. Decide what class of issue you are looking at:
   - provisioning / placement
   - storage
   - relation
   - hook / lifecycle
   - charm-specific logic after hooks start running

## Standard evidence to collect

Always try to gather these before the model disappears:
- `juju status -m <model>`
- `juju show-model -m <model>`
- `juju show-unit -m <model> <unit>`
- `juju show-status-log -m <model> <unit>`
- `juju debug-log -m <model> --replay --no-tail`
- remote unit log: `/var/log/juju/unit-*.log`
- remote machine evidence: `lsblk -f`, `/dev/disk/by-id`, relevant service logs

For storage issues, also collect:
- `juju storage -m <model>`
- `juju show-storage -m <model> <storage-id>`
- `juju storage-pools -m <model>`

The helper script will gather most of this automatically.

## Helper scripts

These helper scripts are bundled with this skill under `scripts/`.
See [REFERENCE.md](REFERENCE.md) for concrete example invocations and output patterns.

### Full model snapshot
```bash
scripts/collect-juju-model-snapshot.sh <model> artifacts/<model>
```

Useful overrides:
```bash
JUJU_SKIP_FULL_DEBUG=1
JUJU_DEBUG_FILTER='storage|attachment|attach|install|config-changed|relation|leader|remote state'
```

### Storage-oriented failing vs working comparison
```bash
scripts/compare-juju-storage.sh <failing-model> <working-model>
```

Useful overrides:
```bash
JUJU_COMPARE_UNIT=ceph-osd/0
JUJU_COMPARE_STORAGE_ID=osd-devices/0
JUJU_COMPARE_OUTDIR=artifacts/storage-compare
```

## Reduction ladder

Follow this order until you isolate the fault:

1. **Existing failing model**
   - Snapshot it before changing anything.
   - Identify whether the unit ever reaches hook execution.

2. **Same command, fresh model**
   - Re-run the same deploy/apply path with DEBUG enabled.
   - Confirm the failure is stable.

3. **Working control**
   - Create the closest successful case you can.
   - Same cloud, base, charm revision/channel, and constraints when possible.

4. **One-variable reduction**
   - Reduce units
   - Reduce applications
   - Remove optional relations
   - Remove optional storage directives
   - Drop outer orchestration if plain `juju deploy` reproduces

5. **Minimal reproducer**
   - Aim for the shortest command sequence that still fails.
   - Keep one nearby success case as the control.

## Pattern guide

## 1. Unit stuck before hooks really start

Look for:
- unit log stops around charm download / install setup
- `juju-status=allocating` or `agent initialising`
- no `install` hook execution

Check:
- `juju show-unit`
- unit log tail on the machine
- `juju debug-log` for uniter, remotestate, storage, and operation lines

High-signal questions:
- Did the unit receive remote state changes?
- Did the uniter schedule any hook operations?
- Is the block before install, during install, or after install?

## 2. Storage issue

Look for:
- unit blocked before install or config-changed
- global storage appears attached, but the unit does not progress
- guest has a disk, but Juju still waits

Check all of:
1. `juju storage`
2. `juju show-storage <storage-id>`
3. `juju show-unit <unit>`
4. `juju debug-log`
5. guest `lsblk -f`
6. guest `/dev/disk/by-id`

Pay attention to the difference between:
- model-level storage status being `attached`
- and the **unit attachment** having a real `location`

A high-signal failure shape is:
- model says attached
- guest sees the device
- `show-storage` lacks unit `location`
- uniter logs `Attached:false` and `waiting for remote state change`

## 3. Relation issue

Look for:
- units are idle but blocked/waiting on missing relation data
- one side claims relation exists but the other side never consumes or publishes the expected fields

Check:
- `juju status`
- `juju show-unit`
- `juju debug-log`
- charm logs around relation hooks

High-signal questions:
- Did both sides run their relation hooks?
- Is the expected relation data actually present?
- Is the issue leader-only or unit-specific?

## 4. Machine or provider issue

Look for:
- machines stuck pending/allocating
- missing addresses or repeated provisioning retries
- provider reports success, but guest state is incomplete

Check:
- `juju status`
- `juju show-machine`
- `juju debug-log`
- guest-visible resources on the machine once reachable

## 5. Post-install charm behavior

If install and initial hooks did run, shift focus away from Juju wiring and toward charm logic:
- charm config validation
- relation expectations
- leader/non-leader behavior
- service startup
- workload logs

## Comparison workflow

Whenever possible, compare:
- failing model
- working control model

Keep the delta small. Good control design usually changes only one thing:
- extra storage endpoint present vs absent
- one relation present vs absent
- one unit vs many units
- manual deploy vs Terraform/app wrapper

When the issue is storage-related, run:
```bash
scripts/compare-juju-storage.sh <failing-model> <working-model>
```

For non-storage issues, compare the generated snapshots directly:
- `summary.md`
- `debug-filtered.log`
- per-unit `show-unit`
- per-unit status logs

## Pitfalls

- **Do not run charm hooks manually outside Juju hook context.** Missing hook env and RPC services make the result misleading.
- **Do not trust `juju export-bundle` as the primary source of truth for storage intent.** It can include extra charm-declared/default storage.
- **Do not conclude from `juju status` alone.** Controller, uniter, and guest evidence often disagree in useful ways.
- **Do not over-rotate on one failing model.** A nearby control can reveal the actual difference much faster.

## Bug report checklist

A strong Juju bug report should contain:
- exact Juju/controller version
- cloud/provider details
- exact charm/base/channel/revision
- exact command sequence
- expected vs actual behavior
- one minimal failing reproducer
- one nearby working control
- the shortest high-signal log excerpts
- artifact paths or attached snapshot bundle

## What “done” looks like

A solid debugging outcome should leave behind:
- a preserved failing model snapshot
- a working control snapshot
- a concise explanation of the delta
- a minimal reproducer command sequence
- either a fix plan or a bug report draft
