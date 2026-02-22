# Storage and mounts

## Host directory bind mounts (read-only by default)

```bash
lxc config device add c-<name> host-src disk source=/srv/projects path=/mnt/projects readonly=true
```

Writable mount (only when explicitly requested):

```bash
lxc config device add c-<name> host-rw disk source=/srv/data path=/mnt/data
```

Same device pattern works for VMs.

## Managed storage volumes (preferred for persistent app data)

Pick a storage pool explicitly (do not assume `default` exists in all environments):

```bash
lxc storage list
lxc storage volume create <pool> app-data size=20GiB
lxc config device add c-<name> app-data disk pool=<pool> source=app-data path=/var/lib/app
```

## File transfer pattern (one-off artifacts)

```bash
lxc file push ./artifact.snap c-dev/mnt/
lxc file pull c-dev/etc/os-release ./os-release.c-dev
```

Use `lxc file push/pull` for point-in-time transfer; use disk devices/profiles for ongoing shared data.

## Safety notes

- Avoid mounting sensitive host paths (`/`, `/etc`, `/var/lib/lxd`, SSH key dirs).
- Prefer dedicated host directories with narrow permissions.
- If multiple instances need the same mount, define it once in a profile.
