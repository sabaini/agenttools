#!/usr/bin/env bash
set -euo pipefail

KEEP=0
REQUIRE_VM=0
PREFIX="lxd-skill-${RANDOM}"
IMAGE="ubuntu:24.04"
POOL=""

HOST_DIR=""
VM_OK=1
VM_REASON=""

declare -a INSTANCES=()
declare -a PROFILES=()
declare -a NETWORKS=()
declare -a VOLUMES=()

usage() {
  cat <<'EOF'
Usage: ./tests/smoke.sh [options]

Runs a disposable smoke test for LXD patterns documented by this skill.

Options:
  --keep            Keep created resources for debugging.
  --require-vm      Fail if VM tests cannot run on this host.
  --prefix <name>   Resource name prefix (default: lxd-skill-<random>).
  --pool <name>     Storage pool for managed volume tests.
  -h, --help        Show help.
EOF
}

log() {
  printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

add_instance() {
  INSTANCES+=("$1")
}

add_profile() {
  PROFILES+=("$1")
}

add_network() {
  NETWORKS+=("$1")
}

add_volume() {
  VOLUMES+=("$1") # <pool>/<name>
}

cleanup() {
  local rc=$?

  if [[ "$KEEP" -eq 1 ]]; then
    warn "--keep enabled, leaving resources in place (prefix=$PREFIX)"
    return "$rc"
  fi

  set +e

  for ((i=${#INSTANCES[@]}-1; i>=0; i--)); do
    lxc delete "${INSTANCES[$i]}" --force >/dev/null 2>&1 || true
  done

  for ((i=${#PROFILES[@]}-1; i>=0; i--)); do
    lxc profile delete "${PROFILES[$i]}" >/dev/null 2>&1 || true
  done

  for ((i=${#NETWORKS[@]}-1; i>=0; i--)); do
    lxc network delete "${NETWORKS[$i]}" >/dev/null 2>&1 || true
  done

  for ((i=${#VOLUMES[@]}-1; i>=0; i--)); do
    local pool="${VOLUMES[$i]%%/*}"
    local vol="${VOLUMES[$i]#*/}"
    lxc storage volume delete "$pool" "$vol" >/dev/null 2>&1 || true
  done

  [[ -n "$HOST_DIR" ]] && rm -rf "$HOST_DIR"

  return "$rc"
}
trap cleanup EXIT

wait_exec() {
  local instance="$1"
  local attempts="${2:-60}"
  local sleep_secs="${3:-2}"

  for _ in $(seq 1 "$attempts"); do
    if lxc exec "$instance" -- true >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_secs"
  done

  return 1
}

wait_cloud_init_container() {
  local instance="$1"
  lxc exec "$instance" -- cloud-init status --wait >/dev/null
}

wait_cloud_init_vm() {
  local instance="$1"
  if ! wait_exec "$instance" 120 2; then
    return 1
  fi
  lxc exec "$instance" -- cloud-init status --wait >/dev/null
}

ensure_tools() {
  command -v lxc >/dev/null 2>&1 || die "lxc is required"
  command -v jq >/dev/null 2>&1 || die "jq is required"
}

pick_image() {
  if lxc image info "$IMAGE" >/dev/null 2>&1; then
    return
  fi

  for candidate in ubuntu:noble ubuntu:lts; do
    if lxc image info "$candidate" >/dev/null 2>&1; then
      warn "Default image ubuntu:24.04 unavailable, using fallback: $candidate"
      IMAGE="$candidate"
      return
    fi
  done

  die "No suitable Ubuntu image alias found (tried ubuntu:24.04, ubuntu:noble, ubuntu:lts)"
}

pick_pool() {
  if [[ -n "$POOL" ]]; then
    lxc storage show "$POOL" >/dev/null 2>&1 || die "Storage pool '$POOL' not found"
    return
  fi

  POOL="$(lxc storage list --format=json | jq -r '.[] | select((.status // .state // "") | ascii_downcase == "created") | .name' | head -n1)"
  [[ -n "$POOL" ]] || die "No created LXD storage pool found"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keep)
        KEEP=1
        shift
        ;;
      --require-vm)
        REQUIRE_VM=1
        shift
        ;;
      --prefix)
        PREFIX="${2:?missing value for --prefix}"
        shift 2
        ;;
      --pool)
        POOL="${2:?missing value for --pool}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown option: $1"
        ;;
    esac
  done
}

main() {
  parse_args "$@"
  ensure_tools

  log "Preflight"
  lxc info >/dev/null
  lxc remote list --format=table >/dev/null
  pick_image
  pick_pool
  log "Using image=$IMAGE pool=$POOL prefix=$PREFIX"

  HOST_DIR="$(mktemp -d /tmp/lxd-skill-smoke.XXXXXX)"
  mkdir -p "$HOST_DIR/projects" "$HOST_DIR/data"
  chmod 0777 "$HOST_DIR/projects" "$HOST_DIR/data"
  echo "artifact-$PREFIX" > "$HOST_DIR/artifact.snap"

  local c_init="${PREFIX}-c-init"
  local c_quick="${PREFIX}-c-quick"
  local c_dev="${PREFIX}-c-dev"
  local c_net="${PREFIX}-c-net"
  local c_adv="${PREFIX}-c-adv"

  local vm_init="${PREFIX}-vm-init"
  local vm_quick="${PREFIX}-vm-quick"
  local vm_net="${PREFIX}-vm-net"

  local compute_profile="${PREFIX}-compute-small"
  local mount_profile="${PREFIX}-mount-projects"
  local net_profile="${PREFIX}-net-br"

  # Linux network interface names are limited to 15 chars.
  local network="br${RANDOM}"
  local volume="${PREFIX}-app-data"

  local octet=$((RANDOM % 200 + 20))
  local subnet_prefix="10.250.${octet}"
  local subnet="${subnet_prefix}.1/24"

  log "Container init -> config -> start"
  lxc init "$IMAGE" "$c_init" --profile default
  add_instance "$c_init"
  lxc config set "$c_init" limits.cpu 2
  lxc config set "$c_init" limits.memory 4GiB
  lxc start "$c_init"
  wait_exec "$c_init" 60 2
  wait_cloud_init_container "$c_init"
  lxc exec "$c_init" -- sh -c 'echo ok >/tmp/smoke-check && test -f /tmp/smoke-check'

  log "VM init -> config -> start"
  if lxc init "$IMAGE" "$vm_init" --vm --profile default; then
    add_instance "$vm_init"
    if lxc config set "$vm_init" limits.cpu 2 && \
       lxc config set "$vm_init" limits.memory 4GiB && \
       lxc config device override "$vm_init" root size=12GiB && \
       lxc start "$vm_init"; then
      if wait_cloud_init_vm "$vm_init"; then
        lxc exec "$vm_init" -- sh -c 'echo ok >/tmp/smoke-vm-check && test -f /tmp/smoke-vm-check'
      else
        VM_OK=0
        VM_REASON="vm-agent-or-cloud-init-timeout"
      fi
    else
      VM_OK=0
      VM_REASON="vm-config-or-start-failed"
    fi
  else
    VM_OK=0
    VM_REASON="vm-init-failed"
  fi

  if [[ "$VM_OK" -eq 0 ]]; then
    if [[ "$REQUIRE_VM" -eq 1 ]]; then
      die "VM smoke tests failed and --require-vm was set ($VM_REASON)"
    fi
    warn "Skipping VM-only checks ($VM_REASON)"
  fi

  log "Quick launch pattern"
  lxc launch "$IMAGE" "$c_quick" --profile default
  add_instance "$c_quick"
  wait_exec "$c_quick" 60 2
  wait_cloud_init_container "$c_quick"

  if [[ "$VM_OK" -eq 1 ]]; then
    lxc launch "$IMAGE" "$vm_quick" --vm --profile default
    add_instance "$vm_quick"
    wait_cloud_init_vm "$vm_quick"
  fi

  log "Host mounts + managed volume + file push/pull"
  lxc config device add "$c_init" host-src disk source="$HOST_DIR/projects" path=/mnt/projects readonly=true
  lxc config device add "$c_init" host-rw disk source="$HOST_DIR/data" path=/mnt/data

  lxc storage volume create "$POOL" "$volume" size=1GiB
  add_volume "$POOL/$volume"
  lxc config device add "$c_init" app-data disk pool="$POOL" source="$volume" path=/var/lib/app

  lxc file push "$HOST_DIR/artifact.snap" "$c_init"/mnt/
  lxc file pull "$c_init"/etc/os-release "$HOST_DIR/os-release.pull"
  [[ -s "$HOST_DIR/os-release.pull" ]] || die "lxc file pull produced empty file"

  # RO mount should reject writes.
  if lxc exec "$c_init" -- sh -c 'touch /mnt/projects/should-not-write' >/dev/null 2>&1; then
    die "readonly mount is unexpectedly writable"
  fi

  # RW mount should allow writes.
  lxc exec "$c_init" -- sh -c 'touch /mnt/data/write-ok'
  [[ -f "$HOST_DIR/data/write-ok" ]] || die "rw mount write did not appear on host"

  log "Profiles"
  lxc profile show "$compute_profile" >/dev/null 2>&1 || lxc profile create "$compute_profile"
  add_profile "$compute_profile"
  lxc profile set "$compute_profile" limits.cpu 2
  lxc profile set "$compute_profile" limits.memory 4GiB

  lxc profile show "$mount_profile" >/dev/null 2>&1 || lxc profile create "$mount_profile"
  add_profile "$mount_profile"
  if ! lxc profile device list "$mount_profile" | grep -qx projects; then
    lxc profile device add "$mount_profile" projects disk source="$HOST_DIR/projects" path=/mnt/projects readonly=true
  fi

  log "Launch with composed profiles + profile assign"
  lxc launch "$IMAGE" "$c_dev" --profile default --profile "$compute_profile" --profile "$mount_profile"
  add_instance "$c_dev"
  wait_exec "$c_dev" 60 2
  wait_cloud_init_container "$c_dev"
  lxc profile assign "$c_dev" default,"$compute_profile","$mount_profile"

  log "Managed bridge network + network profile"
  lxc network show "$network" >/dev/null 2>&1 || \
    lxc network create "$network" ipv4.address="$subnet" ipv4.nat=true ipv6.address=none
  add_network "$network"

  lxc profile show "$net_profile" >/dev/null 2>&1 || lxc profile create "$net_profile"
  add_profile "$net_profile"
  if ! lxc profile device list "$net_profile" | grep -qx eth0; then
    lxc profile device add "$net_profile" eth0 nic network="$network" name=eth0
  fi

  lxc launch "$IMAGE" "$c_net" --profile default --profile "$net_profile"
  add_instance "$c_net"
  wait_exec "$c_net" 60 2
  wait_cloud_init_container "$c_net"

  lxc config device override "$c_net" eth0 ipv4.address="${subnet_prefix}.10"
  local assigned_ip
  assigned_ip="$(lxc config device get "$c_net" eth0 ipv4.address)"
  [[ "$assigned_ip" == "${subnet_prefix}.10" ]] || die "static IP override did not stick"

  local parsed_subnet
  parsed_subnet="$(lxc network list --format=json | jq -r --arg network "$network" '.[] | select(.name==$network) | .config["ipv4.address"]')"
  [[ "$parsed_subnet" == "$subnet" ]] || die "JSON network parse mismatch: got '$parsed_subnet', expected '$subnet'"

  if [[ "$VM_OK" -eq 1 ]]; then
    log "VM network/mount parity checks"
    lxc launch "$IMAGE" "$vm_net" --vm --profile default --profile "$net_profile"
    add_instance "$vm_net"
    lxc config device add "$vm_net" host-src disk source="$HOST_DIR/projects" path=/mnt/projects readonly=true
    lxc config device override "$vm_net" eth0 ipv4.address="${subnet_prefix}.11"
    wait_cloud_init_vm "$vm_net"
  fi

  log "Advanced privileged container pattern"
  lxc init "$IMAGE" "$c_adv" --profile default
  add_instance "$c_adv"
  lxc config set "$c_adv" security.privileged true
  lxc config set "$c_adv" security.nesting true
  printf 'lxc.cgroup2.devices.allow = b 7:* rwm\nlxc.cgroup2.devices.allow = c 10:237 rwm' | lxc config set "$c_adv" raw.lxc -
  lxc start "$c_adv"
  wait_exec "$c_adv" 60 2
  lxc exec "$c_adv" -- sh -c 'echo ok >/tmp/advanced-check && test -f /tmp/advanced-check'

  log "SUCCESS: all smoke checks passed"
  printf 'Summary: image=%s pool=%s prefix=%s vm_ok=%s\n' "$IMAGE" "$POOL" "$PREFIX" "$VM_OK"
}

main "$@"
