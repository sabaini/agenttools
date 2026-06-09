# Long authenticated reservations

Use this reference when Peter asks for a longer Testflinger reservation,
especially on the `ceph-qa-1` queue.

## Credentials

Source Peter's local credential file before running reservation commands:

```bash
# shellcheck disable=SC1090
. ~/data/creds/api-token.sh
```

This places `TESTFLINGER_*` credentials into the environment. Do not print,
log, store, or copy their values.

With these credentials in the environment, both the `testflinger` binary and
the `cephtools testflinger` wrapper can request longer reservations from
`ceph-qa-1`.

## Maximum duration

The authenticated maximum reservation duration for `ceph-qa-1` is currently:

```text
60400 seconds
```

Use a smaller duration when the task does not need the full window. Cancel early
when finished.

## Cephtools wrapper

Preferred path:

```bash
# shellcheck disable=SC1090
. ~/data/creds/api-token.sh

cephtools testflinger reserve ceph-qa-1 \
  --reserve-for 60400
```

## Raw Testflinger CLI

Use this only when the wrapper is unavailable or when debugging wrapper
behavior:

```bash
# shellcheck disable=SC1090
. ~/data/creds/api-token.sh

testflinger reserve --queue ceph-qa-1 \
  --reserve-for 60400
```

Check `testflinger reserve --help` if the local CLI uses a different duration
flag name.

## Reporting

After the reservation succeeds, capture and report:

- queue name
- job id
- requested duration
- expiration timestamp
- SSH command
- cancel command

If the work completes early, run the printed cancel command, usually:

```bash
testflinger cancel <job-id>
```
