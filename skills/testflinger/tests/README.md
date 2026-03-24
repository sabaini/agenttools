# Testflinger skill smoke test

Run from the `skills/testflinger` directory:

```bash
./tests/smoke.sh
```

This performs safe local checks only:

- VPN reachability to `10.172.192.1`
- presence of `cephtools`
- presence of `testflinger`/`testflinger-cli`
- CLI help for the documented commands

To run a live end-to-end validation that actually reserves hardware, use:

```bash
./tests/smoke.sh --live --queue <queue-name>
```

The live mode waits for reservation details, attempts a simple SSH validation, and cancels the reservation on exit.
