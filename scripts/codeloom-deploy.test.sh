#!/usr/bin/env bash
# Offline regression checks for the deploy script's failure paths.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
script="$repo/scripts/codeloom-deploy.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/root/releases" "$tmp/source"
printf 'POSTGRES_DB=multica\n' >"$tmp/env"
cat >"$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
case "$1" in
  ps)
    case "$*" in
      *service=postgres*) if [ "${POSTGRES_RUNNING:-yes}" = yes ]; then echo postgres-id; fi ;;
      *service=frontend*) echo frontend-id ;;
      *service=backend*) echo backend-id ;;
    esac ;;
  volume)
    [ "${VOLUME_EXISTS:-no}" = yes ] ;;
  image)
    case "$*" in
      *codeloom-backend*) [ "${BACKEND_IMAGE_EXISTS:-no}" = yes ] ;;
      *codeloom-web*) [ "${FRONTEND_IMAGE_EXISTS:-no}" = yes ] ;;
    esac ;;
  stop)
    [ "${STOP_FAIL:-no}" != yes ] ;;
  exec)
    if [ "${DUMP_FAIL:-no}" = yes ]; then exit 1; fi
    if [ "${3:-}" = pg_restore ]; then exit 0; fi
    printf 'archive\n' ;;
esac
EOF
chmod +x "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log"
export CODELOOM_ROOT="$tmp/root" CODELOOM_ENV_FILE="$tmp/env"
export CODELOOM_BACKUP_DIR="$tmp/backups" CODELOOM_SUDO="" CODELOOM_SOURCE_DIR="$tmp/source"

expect_fail() {
  if bash "$script" "$@" >"$tmp/output" 2>&1; then
    printf 'Unexpected success: %s\n' "$*" >&2
    exit 1
  fi
}
assert_logged() {
  if ! grep -q -- "$1" "$DOCKER_LOG"; then
    printf 'Missing Docker call: %s\n' "$1" >&2
    exit 1
  fi
}

# An existing database must not be migrated without a pre-deploy backup.
: >"$DOCKER_LOG"
export POSTGRES_RUNNING=no VOLUME_EXISTS=yes
expect_fail backup
assert_logged 'volume inspect codeloom_pgdata'
! grep -q 'stop ' "$DOCKER_LOG"

# A fresh install can skip backup.
export VOLUME_EXISTS=no
bash "$script" backup >"$tmp/output"

# If stopping one of the app containers fails, the trap restarts both.
export POSTGRES_RUNNING=yes STOP_FAIL=yes
: >"$DOCKER_LOG"
expect_fail backup
assert_logged 'stop frontend-id backend-id'
assert_logged 'start frontend-id backend-id'

# An unsuccessful dump must also restart the old application.
export STOP_FAIL=no DUMP_FAIL=yes
: >"$DOCKER_LOG"
expect_fail backup
assert_logged 'start frontend-id backend-id'

# Incomplete archives must never leave a release that a retry would accept.
commit=0123456789abcdef0123456789abcdef01234567
expect_fail stage "$commit"
[ ! -e "$CODELOOM_ROOT/releases/$commit" ]
if find "$CODELOOM_ROOT/releases" -mindepth 1 -print -quit | grep -q .; then
  echo 'Temporary release directory was not cleaned up' >&2
  exit 1
fi
# An old partially staged directory must not be reused.
mkdir -p "$CODELOOM_ROOT/releases/$commit"
expect_fail stage "$commit"
expect_fail switch "$commit"

# Refuse to rebuild over one of an existing pair of immutable image tags.
export BACKEND_IMAGE_EXISTS=yes FRONTEND_IMAGE_EXISTS=no
: >"$DOCKER_LOG"
expect_fail build "$commit"
! grep -q '^build ' "$DOCKER_LOG"

# A valid archive is staged atomically and can be retried.
rm -rf "$CODELOOM_ROOT/releases/$commit"
git -C "$CODELOOM_SOURCE_DIR" init -q
git -C "$CODELOOM_SOURCE_DIR" -c user.name=Test -c user.email=test@example.com \
  commit -q --allow-empty -m 'test release'
valid_commit=$(git -C "$CODELOOM_SOURCE_DIR" rev-parse HEAD)
bash "$script" stage "$valid_commit" >"$tmp/output"
[ "$(<"$CODELOOM_ROOT/releases/$valid_commit/.codeloom-staged")" = "$valid_commit" ]
bash "$script" stage "$valid_commit" >"$tmp/output"

printf 'Deploy failure-path checks passed\n'
