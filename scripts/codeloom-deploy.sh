#!/usr/bin/env bash
# Codeloom addition: production deploy steps for .github/workflows/deploy.yml.
#
# Follows docs/codeloom-deployment.md: commit-tagged images, releases under
# $CODELOOM_ROOT/releases/<commit> with a `current` link, one Compose project,
# and database migrations run inside the Compose network by the backend image,
# so they use the same DATABASE_URL (postgres:5432, POSTGRES_DB from the env
# file) as the application.
#
# The `current` link names the running release; its commit is passed to Compose
# as CODELOOM_IMAGE_TAG for docker-compose.codeloom-release.yml.
#
# Usage: codeloom-deploy.sh <preflight|build|stage|backup|switch|migrate|start> [commit]
set -euo pipefail

PROJECT="${CODELOOM_PROJECT:-codeloom}"
ROOT="${CODELOOM_ROOT:-/opt/codeloom}"
# The docs keep the env file in /etc/codeloom; earlier LAN-style installs keep
# it in the checkout root.
if [ -n "${CODELOOM_ENV_FILE:-}" ]; then
  ENV_FILE="$CODELOOM_ENV_FILE"
elif [ -e /etc/codeloom/.env.codeloom ]; then
  ENV_FILE=/etc/codeloom/.env.codeloom
else
  ENV_FILE="$ROOT/.env.codeloom"
fi
# Optional site overlay (docs §5); skipped when the file does not exist.
OVERLAY="${CODELOOM_OVERLAY:-/etc/codeloom/compose.production.yml}"
BACKUP_DIR="${CODELOOM_BACKUP_DIR:-$HOME/codeloom-backups}"
# The docs create $ROOT with sudo; tests point it at a writable directory.
SUDO="${CODELOOM_SUDO-sudo}"
SOURCE_DIR="${CODELOOM_SOURCE_DIR:-$PWD}"

fail() { printf 'codeloom-deploy: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

require_commit() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || fail "expected a full 40-character commit, got '${1:-}'"
}

current_release() {
  [ -e "$ROOT/current" ] && basename "$(readlink -f "$ROOT/current")"
}

# Same Compose files as the `codeloom` shell function in the deployment docs,
# plus the release overlay. `env -i` keeps stray shell variables from
# overriding the env file.
compose() (
  local tag
  tag=$(current_release) || fail "no current release at $ROOT/current"
  local files=(-f docker-compose.selfhost.yml -f docker-compose.selfhost.build.yml
    -f docker-compose.codeloom.yml -f docker-compose.codeloom-release.yml)
  [ -e "$OVERLAY" ] && files+=(-f "$OVERLAY")
  cd "$ROOT/current" || exit 1
  env -i PATH="$PATH" HOME="$HOME" CODELOOM_IMAGE_TAG="$tag" docker compose \
    --project-name "$PROJECT" --env-file "$ENV_FILE" "${files[@]}" "$@"
)

# Containers of the running deployment, whatever layout started it.
project_container() {
  docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1"
}

# A project name that differs from the existing deployment would start a new,
# empty database next to the real one. Refuse instead of guessing.
check_database_volume() {
  local volume="${PROJECT}_pgdata" others
  docker volume inspect "$volume" >/dev/null 2>&1 && return
  others=$(docker volume ls -q --filter label=com.docker.compose.volume=pgdata | grep -vx "$volume" || true)
  [ -z "$others" ] && return
  fail "volume $volume does not exist, but other PostgreSQL volumes do: $(echo "$others" | tr '\n' ' ')
  Deploying would create a new, empty database. Set the CODELOOM_PROJECT repository variable
  to the existing Compose project, or migrate its data first (docs/codeloom-deployment.md §9)."
}

cmd_preflight() {
  docker info >/dev/null 2>&1 || fail "cannot reach Docker; the runner user needs Docker access"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is missing"
  [ -r "$ENV_FILE" ] || fail "$ENV_FILE must exist and be readable by the runner user (see docs/codeloom-deployment.md §4)"
  grep -q '^POSTGRES_DB=' "$ENV_FILE" || fail "$ENV_FILE has no POSTGRES_DB line"
  if grep -q '^CODELOOM_IMAGE_TAG=' "$ENV_FILE" && [ ! -w "$ENV_FILE" ]; then
    fail "$ENV_FILE has CODELOOM_IMAGE_TAG but is not writable by the runner user"
  fi
  check_database_volume
  local overlay="none"
  [ -e "$OVERLAY" ] && overlay="$OVERLAY"
  info "Deploy target: project=$PROJECT db=$(sed -n 's/^POSTGRES_DB=//p' "$ENV_FILE" | tail -n 1)"
  info "  env=$ENV_FILE overlay=$overlay current=$(current_release || echo none)"
}

cmd_build() {
  local commit="$1"
  require_commit "$commit"
  # Release tags are immutable: never rebuild over an existing commit tag.
  local backend_exists=0 frontend_exists=0
  docker image inspect "codeloom-backend:$commit" >/dev/null 2>&1 && backend_exists=1
  docker image inspect "codeloom-web:$commit" >/dev/null 2>&1 && frontend_exists=1
  if [ "$backend_exists" -eq 1 ] && [ "$frontend_exists" -eq 1 ]; then
    info "Images for $commit already exist; skipping build"
    return
  fi
  [ "$backend_exists" -eq 0 ] && [ "$frontend_exists" -eq 0 ] || fail "only one image exists for $commit; refusing to overwrite an immutable tag"
  docker build \
    --build-arg VERSION=v0.5.0-codeloom \
    --build-arg COMMIT="$commit" \
    --build-arg DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -f "$SOURCE_DIR/Dockerfile" -t "codeloom-backend:$commit" "$SOURCE_DIR"
  docker build \
    --build-arg NEXT_PUBLIC_APP_VERSION="v0.5.0-codeloom.$commit" \
    -f "$SOURCE_DIR/Dockerfile.web" -t "codeloom-web:$commit" "$SOURCE_DIR"
}

cmd_stage() {
  local commit="$1" release="$ROOT/releases/$1"
  require_commit "$commit"
  if [ -d "$release" ]; then
    [ -f "$release/.codeloom-staged" ] || fail "release $release is incomplete; inspect it before retrying"
    info "Release $release already staged"
    return
  fi
  # Stage into a temporary directory, so a failed archive never looks like a
  # complete release on the next deploy. Keep temp directories on this filesystem.
  local pending="$ROOT/releases/.$commit.$$"
  $SUDO install -d -m 0755 "$pending"
  if ! git -C "$SOURCE_DIR" archive --format=tar "$commit" | $SUDO tar -xf - -C "$pending"; then
    $SUDO rm -rf -- "$pending"
    fail "failed to stage $commit"
  fi
  if ! printf '%s\n' "$commit" | $SUDO tee "$pending/.codeloom-staged" >/dev/null; then
    $SUDO rm -rf -- "$pending"
    fail "failed to mark release $commit as staged"
  fi
  $SUDO mv -- "$pending" "$release"
  info "Staged $release"
}

# Stops writes and dumps the database before the schema can change. Works from
# Compose labels, so it also covers a deployment started outside $ROOT/current.
cmd_backup() {
  local postgres
  postgres=$(project_container postgres)
  if [ -z "$postgres" ]; then
    # A stopped database is not a first deployment. Do not skip the backup and
    # then migrate the existing volume without a recovery point.
    if docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1; then
      fail "PostgreSQL is not running; refusing to migrate existing $PROJECT database without a backup"
    fi
    info "No existing $PROJECT PostgreSQL volume; skipping pre-deploy backup"
    return
  fi
  local target
  target="$BACKUP_DIR/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$(current_release || echo unversioned)"
  (umask 077 && mkdir -p "$target")
  APP_CONTAINERS=$({ project_container frontend; project_container backend; } | tr '\n' ' ')
  info "Stopping frontend/backend and backing up the database to $target"
  # Install the recovery trap before stopping either container: docker stop
  # can fail after it has already stopped the first one.
  trap restart_app_containers ERR
  # shellcheck disable=SC2086 # one container id per word
  [ -z "${APP_CONTAINERS// /}" ] || docker stop $APP_CONTAINERS >/dev/null
  (umask 077 && docker exec "$postgres" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$target/postgres.dump")
  docker exec -i "$postgres" pg_restore --list <"$target/postgres.dump" >/dev/null
  trap - ERR
  info "Backup written. Previous release: $(current_release || echo "none (containers started from $ROOT)")"
}

restart_app_containers() {
  # shellcheck disable=SC2086 # one container id per word
  [ -z "${APP_CONTAINERS// /}" ] || docker start $APP_CONTAINERS >/dev/null || true
}

cmd_switch() {
  local commit="$1"
  require_commit "$commit"
  [ -f "$ROOT/releases/$commit/.codeloom-staged" ] || fail "release $commit is not completely staged"
  info "Switching from $(current_release || echo none) to $commit"
  $SUDO ln -sfn "$ROOT/releases/$commit" "$ROOT/current"
  # Keep a manual `codeloom` shell function (docs §5) on the same release.
  if grep -q '^CODELOOM_IMAGE_TAG=' "$ENV_FILE"; then
    sed -i "s/^CODELOOM_IMAGE_TAG=.*/CODELOOM_IMAGE_TAG=$commit/" "$ENV_FILE"
  fi
  compose config --quiet
}

# Runs the backend image's migrate binary on the Compose network, with the
# backend service's own DATABASE_URL, before any new backend starts.
cmd_migrate() {
  # Application images are local and never pulled; PostgreSQL may be pulled
  # once on the first deploy.
  compose up -d --no-build --pull missing --wait postgres
  compose run --rm --no-deps -T --entrypoint ./migrate backend up
}

cmd_start() {
  compose up -d --no-build --pull never --wait
  # Probe the port Compose actually published; LAN installs bind a LAN address.
  local url="${CODELOOM_HEALTH_URL:-}" published
  if [ -z "$url" ]; then
    published=$(compose port backend 8080 | tail -n 1)
    [ -n "$published" ] || fail "Compose did not publish a backend port"
    url="http://${published/#0.0.0.0/127.0.0.1}/healthz"
  fi
  for _ in $(seq 1 30); do
    if curl --fail --silent --show-error "$url" >/dev/null; then
      info "Healthy: $url"
      return
    fi
    sleep 2
  done
  compose ps
  compose logs --tail=100 backend
  fail "backend did not become healthy at $url"
}

case "${1:-}" in
  preflight) cmd_preflight ;;
  build) cmd_build "${2:-}" ;;
  stage) cmd_stage "${2:-}" ;;
  backup) cmd_backup ;;
  switch) cmd_switch "${2:-}" ;;
  migrate) cmd_migrate ;;
  start) cmd_start ;;
  *) fail "usage: codeloom-deploy.sh <preflight|build|stage|backup|switch|migrate|start> [commit]" ;;
esac
