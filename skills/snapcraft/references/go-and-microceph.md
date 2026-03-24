# Writing `snapcraft.yaml` for Go snaps

## Choose the simplest build style that fits

For Go snaps, start with one of these patterns:

1. `plugin: go` for straightforward builds
2. `plugin: nil` plus manual `go build` for custom pipelines

Prefer `plugin: nil` when you need tight control over:

- multiple binaries
- CGO flags
- custom tags
- injected version strings
- interaction with staged libraries from other parts

MicroCeph is a good example of the second pattern.

## Minimal Go part with the Go plugin

Use this when the build is simple:

```yaml
parts:
  my-go-app:
    plugin: go
    source: .
    build-snaps:
      - go
```

This is the right default when one Go binary and ordinary module handling are enough.

## Manual Go build pattern

Use this when you need custom commands:

```yaml
parts:
  my-go-app:
    plugin: nil
    source: .
    build-snaps:
      - go
    override-build: |
      set -eux
      go build -trimpath -o "$CRAFT_PART_INSTALL/bin/my-app" ./cmd/my-app
    prime:
      - bin/my-app
```

This gives full control and makes the final payload explicit.

## Build vs stage vs prime

These three concepts cause many packaging mistakes.

### Build

`build` is where compilation happens.

Inputs available here usually include:

- source tree
- `build-packages`
- `build-snaps`
- outputs from earlier parts exposed via shared craft paths

Typical outputs go to:

- `$CRAFT_PART_INSTALL`

### Stage

`stage` is the shared assembly area used by later parts.

Use it for:

- shared libraries needed by another part's build
- runtime tools needed by the final snap
- content from `stage-packages`

Think of `stage` as: "everything candidates for the final snap and for downstream parts."

### Prime

`prime` is the filtered final filesystem that gets packed into the snap.

If a file exists in `stage` but not `prime`, it will not exist in the installed snap.

A common mistake is to add a package to `stage-packages` and forget that `prime` filters most of it away.

## MicroCeph example

MicroCeph uses several parts that show the split well.

### `ceph` part

The `ceph` part:

- pulls in large `stage-packages`
- reorganizes `usr/bin`, `usr/lib`, and `usr/share`
- primes only the subset actually needed in the snap

That means adding a Debian package is not enough by itself. If a runtime tool or library is still missing, inspect the `prime` list.

### `microceph` part

The `microceph` part in `/home/ubuntu/src/microceph/snap/snapcraft.yaml` uses:

```yaml
build-snaps:
  - go
plugin: nil
```

and then manually builds two binaries:

- `bin/microceph`
- `bin/microcephd`

It also:

- sets `CGO_CFLAGS` and `CGO_LDFLAGS`
- injects version metadata with `-ldflags`
- uses `-tags=libsqlite3` for `microcephd`
- strips the binaries after build

This is a good pattern when the project must link against libraries staged from other parts such as dqlite or Ceph-related dependencies.

## MicroCeph build lessons

### 1. Dirty worktree policy is part of the build

MicroCeph intentionally fails the build if the tree is dirty. If you are iterating locally, decide explicitly whether to:

- commit work-in-progress to satisfy the policy, or
- patch/disable the guard temporarily for a local-only experiment

Do not do this silently.

### 2. Version metadata matters

MicroCeph injects a version string through `-ldflags`.

If you bypass Snapcraft and build binaries manually, preserve equivalent version metadata when possible. Missing metadata can cause confusing runtime behavior and make diagnostics harder.

### 3. Stage packages are not enough; `prime` decides the final payload

In MicroCeph, storage tools may exist in `stage-packages` but still be absent at runtime if `prime` includes only `bin/findmnt` and omits sibling tools or their libraries.

When debugging missing runtime tools, check both:

- the package list
- the `prime` filter list

## Practical patterns for Go snaps

### Multi-binary app

```yaml
parts:
  app:
    plugin: nil
    source: .
    build-snaps: [go]
    override-build: |
      set -eux
      go build -o "$CRAFT_PART_INSTALL/bin/cli" ./cmd/cli
      go build -o "$CRAFT_PART_INSTALL/bin/daemon" ./cmd/daemon
    prime:
      - bin/cli
      - bin/daemon
```

### CGO against staged libraries

```yaml
parts:
  app:
    after: [support-lib]
    plugin: nil
    source: .
    build-snaps: [go]
    override-build: |
      set -eux
      export CGO_CFLAGS="-I${CRAFT_STAGE}/include"
      export CGO_LDFLAGS="-L${CRAFT_STAGE}/lib"
      go build -o "$CRAFT_PART_INSTALL/bin/app" ./cmd/app
```

## Writing checklist for a Go snap

Before building, verify:

- `apps.<name>.command` points to the installed binary path
- each required binary lands in `$CRAFT_PART_INSTALL/bin`
- required tools/libs are not filtered out of `prime`
- versioning is deterministic enough for local and CI builds
- any repo cleanliness guard matches team policy
- any `layout`, environment, or content interface assumptions are explicit

## Debug checklist when a Go snap fails

1. Run `snapcraft -v pack`.
2. If build fails, rerun with `--debug`.
3. Inspect `$CRAFT_PART_INSTALL/bin` for produced binaries.
4. Inspect `prime/` to confirm the final payload.
5. If the snap installs but fails to run, separate missing-file issues from confinement denials.
