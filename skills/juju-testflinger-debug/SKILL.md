---
name: juju-testflinger-debug
description: Debug Testflinger-backed Juju and charm integration failures by reducing from workflow wrapper to upstream command to manual Juju reproducer, enabling DEBUG logging, comparing failing and working models, collecting storage and unit evidence, and preparing a minimal bug report.
---

# Juju/Testflinger integration debugging

Use this skill when a CI, Testflinger, Juju, or charm integration test fails and you need to determine whether the fault is in the workflow wrapper, the remote environment, Juju/provider behavior, or the charm/test logic.

## Core principles

1. **Debug in the real environment first.** Prefer a reserved Testflinger machine over guessing from workflow logs.
2. **Preserve state before fixing anything.** Keep failing models, Terraform workspaces, and artifact directories.
3. **Reduce one layer at a time.** Move from workflow wrapper to upstream command to manual Juju deploy to minimal reproducer.
4. **Always build a working control.** Compare a failing model with a nearby success case.
5. **Prefer repeatable scripts over one-liners.** Long SSH/bash/python pipelines are fragile and hard to reuse.

## Recommended reduction ladder

Follow this order until you isolate the fault:

1. **Wrapper validation**
   - Inspect the `just` recipe, workflow, and Testflinger template.
   - Confirm rendered variables and submitted commands.

2. **Real remote execution**
   - Reserve a machine.
   - Run the upstream command directly on the reserved node.
   - Avoid sourcing helper scripts that expect Testflinger-only environment variables unless you are inside the actual Testflinger job.

3. **Preserve the failing state**
   - Keep Juju models when reproducing.
   - Keep Terraform workspaces when reproducing.
   - Enable failure-path artifact collection early.

4. **Turn on Juju DEBUG logging**
   ```bash
   juju model-config -m <model> logging-config="<root>=DEBUG;unit=DEBUG"
   ```

5. **Create a nearby working control**
   - Same charm, same base, same cloud/provider, minimal topology.
   - Change only one dimension at a time.

6. **Reduce to a minimal reproducer**
   - Drop Terraform if plain `juju deploy` reproduces.
   - Drop extra applications if a single application reproduces.
   - Drop extra relations/storage directives until only the trigger remains.

7. **Write the bug report while evidence is fresh**
   - exact commands
   - exact versions
   - expected vs actual
   - key log excerpts
   - working control comparison

## Standard evidence collection

Use the helper scripts bundled in the sibling `juju-debug` skill.

### Full model snapshot
```bash
../juju-debug/scripts/collect-juju-model-snapshot.sh <model> snapshots/<model>
```

This collects:
- `juju status` in text/yaml/json
- `juju storage` in text/yaml/json
- `juju show-storage` for discovered storage ids
- `juju show-unit` and `juju show-status-log` for discovered units
- `juju debug-log` or filtered debug log
- remote unit log tails
- `lsblk` and `/dev/disk/by-id` from unit machines
- a generated `summary.md`

### Focused failing-vs-working comparison
```bash
../juju-debug/scripts/compare-juju-storage.sh <failing-model> <working-model>
```

Useful environment overrides:
```bash
JUJU_COMPARE_UNIT=ceph-osd/0
JUJU_COMPARE_STORAGE_ID=osd-devices/0
JUJU_COMPARE_OUTDIR=artifacts/storage-compare
JUJU_DEBUG_FILTER='storage|attachment|attach|osd-devices|osd-journals|install|remote state'
```

This produces:
- filtered snapshots for both models
- a markdown comparison report
- high-signal diff bullets for bug reports

## Storage-specific checklist

When a unit is stuck before or around install, compare all of these:

1. `juju storage`
2. `juju show-storage <storage-id>`
3. `juju show-unit <unit>`
4. `juju debug-log -m <model> --replay --no-tail`
5. unit log on the machine
6. guest-visible devices via `lsblk` and `/dev/disk/by-id`

Pay close attention to the difference between:
- storage being globally reported as `attached`
- and the **unit attachment** having a real `location`

A common high-signal failure shape is:
- storage appears attached at the model level
- the disk exists in the guest
- but `show-storage` lacks a unit attachment `location`
- the uniter keeps logging `Attached:false` and `waiting for remote state change`

## Common pitfalls

- **Do not run charm hooks manually outside Juju hook context.** Missing hook env and agent RPC services make the result misleading.
- **Do not trust `juju export-bundle` as the primary source of truth for storage intent.** It can include charm-declared/default storage that was not part of the original request.
- **Do not stay at the workflow layer too long.** If you can reserve the same environment, do it.
- **Do not debug only the failing case.** A nearby working control often reveals the important delta faster than deeper inspection of the broken case.

## What “done” looks like

A strong debugging outcome should produce all of the following:
- a minimal reproducer command sequence
- a working control case
- a concise explanation of the difference between them
- saved artifacts with raw evidence
- a bug report draft or implementation fix plan
