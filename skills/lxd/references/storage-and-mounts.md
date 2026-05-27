# Storage and mounts

## Host directory bind mounts (read-only by default)

```bash
lxc config device add c-<name> host-src disk source=/srv/projects path=/mnt/projects readonly=true
```

Writable mount

```bash
lxc config device add c-<name> host-rw disk source=/srv/data path=/mnt/data
```

Same device pattern works for VMs.

## Managed storage volumes

VMs only, not supported by containers.

In scripts, CI, or remote runners, prefer detaching `lxc storage volume create` from the parent stdin with `</dev/null`. See also [Troubleshooting](troubleshooting.md).

Why this matters: `lxc storage volume create` can look hung while blocked on inherited stdin, and `lxc storage volume show <pool> <name>` may still show no volume because creation has not started yet.

```bash
lxc storage list
lxc storage volume create --type block default data1 size=8GiB </dev/null
lxc storage volume attach default data1 vm-<name>
```

## File transfer pattern (one-off artifacts)

```bash
lxc file push ./artifact.snap c-dev/mnt/
lxc file pull c-dev/etc/os-release ./os-release.c-dev
```

Use `lxc file push/pull` for point-in-time transfer; use disk devices/profiles for ongoing shared data.

