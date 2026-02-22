# LXD skill smoke test

Run from the `skills/lxd` directory:

```bash
./tests/smoke.sh
```

Options:

- `--require-vm`: fail if VM checks cannot run
- `--keep`: keep created resources for debugging
- `--prefix <name>`: custom resource prefix
- `--pool <name>`: storage pool to use for managed volume tests

The script creates disposable instances/profiles/networks/volumes and cleans them up on exit (unless `--keep` is used).
