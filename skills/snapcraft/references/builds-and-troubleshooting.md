# Build mechanics and troubleshooting

## Core build model

Snapcraft's normal lifecycle is:

1. `pull`
2. `build`
3. `stage`
4. `prime`
5. `pack`

A full `snapcraft -v pack` runs the needed earlier steps first, then creates the `.snap`.

Useful step-by-step commands during diagnosis:

```bash
snapcraft -v pull <part>
snapcraft -v build <part>
snapcraft -v stage <part>
snapcraft -v prime <part>
snapcraft -v pack
```

Use step commands when you need to narrow a failure to one part or one lifecycle phase.

## Managed build environments

On Linux, Snapcraft commonly builds in a managed environment rather than directly on the host. In practice, expect LXD-based managed builds unless the project or invocation forces something else.

Important consequences:

- The build environment is intentionally closer to a clean, reproducible machine than your host shell.
- Host-only tools, paths, and environment variables may not exist inside the managed build.
- Project source is copied into the build environment, so repo checks in `override-build` still see your uncommitted changes.
- Switching provider/mode can leave confusing state behind; clean before retrying in a different mode.

Common invocations:

```bash
snapcraft -v pack
snapcraft -v pack --use-lxd
snapcraft -v pack --destructive-mode
snapcraft -v pack --platform amd64
```

Use `--destructive-mode` only when the user explicitly wants host builds or the environment requires it. Managed builds are usually the safer default.

## Use explicit `pack`

Do not rely on bare `snapcraft`. Newer Snapcraft already warns that invoking it without a subcommand is deprecated. Prefer:

```bash
snapcraft -v pack
```

If a directory is supplied, Snapcraft packs that directory's contents instead of running the project lifecycle in the usual way:

```bash
snapcraft -v pack prime/
```

Use the directory form only when you intentionally want to pack a prepared tree.

## High-value debug options

These options are often faster than guessing:

```bash
snapcraft -v pack --debug
snapcraft -v pack --shell
snapcraft -v pack --shell-after
```

How to use them:

- `--debug`: drop into a shell only if the build fails.
- `--shell`: open a shell instead of running the step; good for inspecting the build environment before work starts.
- `--shell-after`: run the step, then open a shell; good for inspecting generated files.

Inside the shell, inspect paths such as:

- `$CRAFT_PART_SRC`
- `$CRAFT_PART_BUILD`
- `$CRAFT_PART_INSTALL`
- `$CRAFT_STAGE`
- `$CRAFT_PRIME`

## `snapcraft clean` decision guide

Use `clean` aggressively when failures look stateful.

### Clean a specific part

```bash
snapcraft clean microceph
```

Use part cleaning when you changed:

- the part's source code
- `override-pull` / `override-build` / `override-stage` / `override-prime`
- `build-packages`
- `build-snaps`
- part-local organize/prime rules

### Clean everything / remove packing environment

```bash
snapcraft clean
```

Use a full clean when you changed:

- `base`
- build mode (`--use-lxd` vs `--destructive-mode`)
- architecture/platform assumptions
- shared dependencies across multiple parts
- anything that makes the provider environment suspect or stale

From `snapcraft help clean`: when no parts are specified, Snapcraft removes the packing environment.

## Distinguish failure classes quickly

### 1. Snapcraft/provider failure

Typical signs:

- provider startup issues
- LXD/permission problems
- metadata/schema validation errors
- fetch failures before your code compiles

Action:

- rerun with `-v` or `--debug`
- inspect provider selection
- `snapcraft clean`
- retry in managed mode explicitly with `--use-lxd` if needed

### 2. Project build failure inside Snapcraft

Typical signs:

- compiler errors in `override-build`
- missing symbols
- failed tests invoked by your overrides

MicroCeph example from prior work:

```text
ceph/cluster_recovery.go:473:16: undefined: staleMonHostKeys
ceph/cluster_recovery.go:539:18: undefined: client.SyncClusterRemotes
```

That is an app/source failure surfaced by Snapcraft, not a Snapcraft packaging bug.

### 3. Snap packages successfully, but runtime is broken

Typical signs:

- command not found inside installed snap
- shared library load failures
- missing config/data files
- confinement denials

Action:

- inspect `prime/`
- inspect the built snap with `unsquashfs -l <snap>`
- verify interfaces and logs
- only then blame confinement

## Inspect the payload

Before debugging runtime, verify the snap actually contains what you expect:

```bash
find prime -maxdepth 4 | sort
unsquashfs -l *.snap | less
```

If something is missing at runtime, ask:

1. Was it present in `stage`?
2. Was it filtered out by `prime`?
3. Is the app command/path pointing to the right location?

## MicroCeph-specific lessons

MicroCeph's `/home/ubuntu/src/microceph/snap/snapcraft.yaml` is a strong example of why packaging and runtime must be separated.

### Dirty worktree guard

The `microceph` part has an `override-build` check that fails when the git tree is dirty:

```bash
git -C $CRAFT_PROJECT_DIR status -uno --porcelain
```

and prints:

```text
STOP the build: dirty worktree detected
```

Treat this as a reproducibility policy, not an arbitrary nuisance. If you must bypass it for local experiments, say so clearly and do not confuse the result with a clean release build.

### Repacking old snaps is not equivalent to a real build

An emergency workflow like this can be useful only for narrow diagnostics:

```bash
unsquashfs -d /tmp/root old.snap
cp ./new-binary /tmp/root/bin/
mksquashfs /tmp/root new.snap -noappend -comp xz
```

Do not treat the result as equivalent to a proper Snapcraft build. It can miss version metadata, hooks, wrapper behavior, library alignment, or other packaging assumptions.

## Practical recovery loop

Use this order:

```bash
cd /path/to/project
snapcraft -v pack
snapcraft -v pack --debug
snapcraft clean <part>
snapcraft -v build <part>
snapcraft -v stage <part>
snapcraft -v prime <part>
snapcraft -v pack
```

If provider state still looks wrong:

```bash
snapcraft clean
snapcraft -v pack --use-lxd
```
