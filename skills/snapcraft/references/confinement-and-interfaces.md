# Confinement, plugs, slots, and runtime debugging

## Confinement modes

Use the least permissive mode that works.

### `strict`

Default for real production packaging.

- App runs inside the sandbox.
- Access is mediated by declared interfaces.
- Most confinement bugs show up here.

### `devmode`

Use only for diagnosis and short-lived local iteration.

- Snap still records denials, but enforcement is relaxed.
- Good for learning what the app wants before finalizing interfaces.
- Do not treat a devmode-only success as a finished packaging solution.

### `classic`

Use only when strict confinement genuinely cannot support the workload.

- Much broader host access.
- Higher review burden and weaker isolation.
- Usually not the right answer for a service snap unless there is a strong reason.

## Plugs and slots

Think of interfaces as a contract.

- **Plug**: access the snap wants
- **Slot**: access another snap or the system exposes

A connection joins them.

Useful inspection commands:

```bash
snap connections <snap-name>
snap interfaces
snap info <snap-name>
```

If behavior differs between machines, check whether an interface auto-connected in one environment but not another.

## App-level interface mapping matters

Declaring a top-level plug or slot is not enough; the relevant app/service must also reference the right plugs/slots.

Example pattern:

```yaml
apps:
  my-daemon:
    command: bin/my-daemon
    daemon: simple
    plugs:
      - network
      - network-bind
      - hardware-observe
```

If the app stanza omits the plug, the permission usually will not apply where you expect it.

## MicroCeph examples

`/home/ubuntu/src/microceph/snap/snapcraft.yaml` shows several useful patterns.

### Confinement

```yaml
confinement: strict
```

### Custom plug

```yaml
plugs:
  load-rbd:
    interface: kernel-module-load
```

### Content slots

MicroCeph exports content slots such as:

- `ceph-logs`
- `ceph-conf`

These are used to share data/config safely with other snaps.

### App plugs

MicroCeph apps use interfaces such as:

- `block-devices`
- `dm-crypt`
- `hardware-observe`
- `mount-observe`
- `network`
- `network-bind`
- `process-control`

This is a good reminder that device-heavy snaps often need many narrowly targeted interfaces rather than one broad permission.

## Debug runtime failures systematically

Do not assume every runtime failure is AppArmor.

### First verify packaging

Check that the binary, helper, library, or config file is actually inside the snap:

```bash
unsquashfs -l ./my.snap | less
find prime -maxdepth 5 | sort
```

If the file is absent, fix packaging first.

### Then inspect logs and denials

Useful commands:

```bash
snap logs <snap-name> -n 200
sudo journalctl -k | grep -E 'DENIED|apparmor|audit'
sudo journalctl --since '-10 min' | grep 'apparmor="DENIED"'
```

If available, `snappy-debug` is very helpful:

```bash
sudo snappy-debug.security scanlog
```

Use its suggestions as hints, not as the final authority.

### Debug inside the snap environment

Open a shell with the snap's runtime environment:

```bash
snap run --shell <snap-name>.<app-name>
```

Then inspect:

```bash
env | sort
ls -la "$SNAP"
ls -la "$SNAP_DATA"
ls -la "$SNAP_COMMON"
ldd "$SNAP"/bin/<binary>
```

This is often the fastest way to separate:

- wrong paths
- missing libraries
- environment issues
- confinement issues

## Common failure patterns

### Missing interface

Symptom:

- access denied to devices, mounts, sockets, or system data

Fix:

- add the correct plug to the app
- rebuild
- reinstall
- connect the interface if it does not auto-connect

### Wrong interface attached to the wrong app

Symptom:

- one command works, another command from the same snap fails

Fix:

- move or duplicate the plug declaration to the correct app stanza

### Content interface mismatch

Symptom:

- expected files are not visible even though both snaps are installed

Fix:

- verify plug/slot names, content labels, target/source paths, and connection state

### Layout problem, not confinement problem

Symptom:

- software expects `/etc/...` or `/var/lib/...` and fails even though the files exist under `$SNAP*`

Fix:

- use `layout` or adjust the software paths explicitly

### File staged but not primed

Symptom:

- helper exists during build but disappears in the installed snap

Fix:

- update the `prime` list

## Local install/debug loop

For local testing:

```bash
sudo snap install --dangerous ./my.snap
snap connections <snap-name>
snap logs <snap-name> -n 200
```

If a needed interface does not auto-connect:

```bash
sudo snap connect <snap-name>:<plug> <slot-provider>:<slot>
```

For system slots, the right-hand side may be omitted depending on the interface.

## Practical denial workflow

1. Reproduce the failure under `strict` confinement.
2. Capture logs and denials.
3. Decide whether the problem is missing payload, wrong path/layout, or actual sandbox denial.
4. Map the denial to the narrowest reasonable interface.
5. Update `snapcraft.yaml`.
6. Rebuild with `snapcraft -v pack`.
7. Reinstall, reconnect if needed, and retest.

Use `devmode` only if you need a temporary signal that the problem is confinement-related.
