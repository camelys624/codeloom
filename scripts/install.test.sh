#!/usr/bin/env bash
# Modified for Codeloom: cover the pinned CLI-only installer.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Build a self-contained sandbox with a stub `curl` that records every URL and
# serves a release tarball whose `multica` reports the version in $1.
_setup_sandbox() {
  local tmp="$1" payload_version="$2"
  local stub_bin="$tmp/stub-bin"
  local install_bin="$tmp/install-bin"
  local payload_dir="$tmp/payload"
  mkdir -p "$stub_bin" "$install_bin" "$payload_dir"
  : >"$tmp/curl.log"

  _write_multica_stub "$payload_dir" "$payload_version"
  tar -czf "$tmp/multica.tar.gz" -C "$payload_dir" multica

  cat >"$stub_bin/curl" <<'STUB'
#!/usr/bin/env bash
out=""
for arg in "$@"; do
  case "$arg" in
    http*) printf '%s\n' "$arg" >>"$MULTICA_TEST_CURL_LOG" ;;
  esac
done
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$out" ]]; then
  echo "stub curl expected -o" >&2
  exit 2
fi
cp "$MULTICA_TEST_ARCHIVE" "$out"
STUB
  chmod +x "$stub_bin/curl"
}

_write_multica_stub() {
  local dir="$1" version="$2"
  mkdir -p "$dir"
  printf '#!/usr/bin/env bash\necho "multica %s (commit: test)"\n' "$version" >"$dir/multica"
  chmod +x "$dir/multica"
}

# Runs install.sh with the sandbox stubs. PATH puts the optional
# $tmp/before-bin ahead of the install directory and $tmp/after-bin behind it,
# so a test can place an existing `multica` on either side. Remaining arguments
# are passed to install.sh.
_run_installer() {
  local tmp="$1"
  shift
  PATH="$tmp/stub-bin:$tmp/before-bin:$tmp/install-bin:$tmp/after-bin:/usr/bin:/bin" \
    MULTICA_BIN_DIR="$tmp/install-bin" \
    MULTICA_TEST_ARCHIVE="$tmp/multica.tar.gz" \
    MULTICA_TEST_CURL_LOG="$tmp/curl.log" \
    bash "$ROOT_DIR/scripts/install.sh" "$@" >"$tmp/install.out" 2>"$tmp/install.err"
}

_dump() {
  local tmp="$1"
  cat "$tmp/install.out" >&2 || true
  cat "$tmp/install.err" >&2 || true
}

_require_download() {
  local tmp="$1" tag="$2"
  local expected="https://github.com/multica-ai/multica/releases/download/$tag/multica-cli-${tag#v}-"
  if ! grep -qF "$expected" "$tmp/curl.log"; then
    echo "expected a download from $expected*, got:" >&2
    cat "$tmp/curl.log" >&2 || true
    return 1
  fi
  if grep -q "releases/latest" "$tmp/curl.log"; then
    echo "the pinned installer must not look up the latest release" >&2
    return 1
  fi
}

test_fresh_install_downloads_pinned_release() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _setup_sandbox "$tmp" "0.5.0"
  if ! _run_installer "$tmp"; then
    echo "install.sh exited non-zero" >&2
    _dump "$tmp"
    return 1
  fi
  if [[ ! -x "$tmp/install-bin/multica" ]]; then
    echo "expected binary at $tmp/install-bin/multica" >&2
    _dump "$tmp"
    return 1
  fi
  _require_download "$tmp" "v0.5.0"
  if ! grep -q "multica setup self-host --server-url <backend-url> --app-url <web-url>" "$tmp/install.out"; then
    echo "expected Codeloom self-host setup command in installer output" >&2
    _dump "$tmp"
    return 1
  fi
  if ! grep -q "multica daemon restart --no-auto-update" "$tmp/install.out"; then
    echo "expected the daemon to be restarted without auto-update" >&2
    _dump "$tmp"
    return 1
  fi
}

test_pinned_version_already_installed_is_kept() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _setup_sandbox "$tmp" "0.5.0"
  _write_multica_stub "$tmp/after-bin" "v0.5.0"
  if ! _run_installer "$tmp"; then
    echo "install.sh exited non-zero" >&2
    _dump "$tmp"
    return 1
  fi
  if [[ -s "$tmp/curl.log" ]]; then
    echo "did not expect a download when the pinned version is installed" >&2
    cat "$tmp/curl.log" >&2
    return 1
  fi
  if ! grep -q "already v0.5.0" "$tmp/install.out"; then
    echo "expected an already-installed message" >&2
    _dump "$tmp"
    return 1
  fi
}

test_newer_version_is_replaced_with_pinned_release() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _setup_sandbox "$tmp" "0.5.0"
  _write_multica_stub "$tmp/after-bin" "0.5.2"
  if ! _run_installer "$tmp"; then
    echo "install.sh exited non-zero" >&2
    _dump "$tmp"
    return 1
  fi
  _require_download "$tmp" "v0.5.0"
  if ! grep -q "Multica CLI 0.5.2 installed, Codeloom uses v0.5.0" "$tmp/install.out"; then
    echo "expected the version switch to be reported" >&2
    _dump "$tmp"
    return 1
  fi
}

test_shadowing_cli_fails_instead_of_reporting_success() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _setup_sandbox "$tmp" "0.5.0"
  # E.g. a Homebrew-managed multica that stays first on PATH.
  _write_multica_stub "$tmp/before-bin" "0.5.2"
  if _run_installer "$tmp"; then
    echo "installer must fail while another multica shadows the pinned binary" >&2
    _dump "$tmp"
    return 1
  fi
  if ! grep -q "'multica' on PATH is v0.5.2 at $tmp/before-bin/multica" "$tmp/install.err"; then
    echo "expected the shadowing binary to be named" >&2
    _dump "$tmp"
    return 1
  fi
  if grep -q "is ready" "$tmp/install.out"; then
    echo "installer claimed success despite the shadowing binary" >&2
    _dump "$tmp"
    return 1
  fi
}

test_cli_version_override() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _setup_sandbox "$tmp" "0.5.1"
  if ! MULTICA_CLI_VERSION="0.5.1" _run_installer "$tmp"; then
    echo "install.sh exited non-zero" >&2
    _dump "$tmp"
    return 1
  fi
  _require_download "$tmp" "v0.5.1"
}

test_remote_ssh_install_prints_token_login_hint() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _setup_sandbox "$tmp" "0.5.0"
  if ! SSH_CONNECTION="192.0.2.10 54321 198.51.100.20 22" _run_installer "$tmp"; then
    echo "install.sh exited non-zero" >&2
    _dump "$tmp"
    return 1
  fi

  local expected
  for expected in \
    "Looks like a remote/SSH session" \
    "Settings > API Tokens" \
    "multica config set app_url <web-url>" \
    "multica login --server-url <backend-url> --token" \
    "multica daemon start --no-auto-update"; do
    if ! grep -qF "$expected" "$tmp/install.out"; then
      echo "expected '$expected' in installer output" >&2
      _dump "$tmp"
      return 1
    fi
  done
  if grep -qF "https://multica.ai" "$tmp/install.out"; then
    echo "did not expect Multica Cloud URLs in the Codeloom installer output" >&2
    _dump "$tmp"
    return 1
  fi
}

test_local_install_does_not_print_token_login_hint() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _setup_sandbox "$tmp" "0.5.0"
  if ! (
    unset SSH_CONNECTION SSH_CLIENT SSH_TTY
    _run_installer "$tmp"
  ); then
    echo "install.sh exited non-zero" >&2
    _dump "$tmp"
    return 1
  fi

  if grep -q "Looks like a remote/SSH session" "$tmp/install.out"; then
    echo "did not expect remote/SSH token-login hint in local installer output" >&2
    _dump "$tmp"
    return 1
  fi
}

test_server_modes_point_to_codeloom_deployment() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _setup_sandbox "$tmp" "0.5.0"
  # Any docker or git call would mean the installer still provisions a server.
  printf '#!/usr/bin/env bash\necho "docker $*" >>"%s/server.log"\n' "$tmp" >"$tmp/stub-bin/docker"
  printf '#!/usr/bin/env bash\necho "git $*" >>"%s/server.log"\n' "$tmp" >"$tmp/stub-bin/git"
  chmod +x "$tmp/stub-bin/docker" "$tmp/stub-bin/git"

  local mode
  for mode in --with-server --local --stop; do
    if _run_installer "$tmp" "$mode"; then
      echo "install.sh $mode must fail" >&2
      _dump "$tmp"
      return 1
    fi
    if ! grep -q "SELF_HOSTING.md#codeloom-internal-deployment" "$tmp/install.err"; then
      echo "expected install.sh $mode to point to the Codeloom deployment docs" >&2
      _dump "$tmp"
      return 1
    fi
  done
  if [[ -e "$tmp/server.log" || -s "$tmp/curl.log" || -e "$tmp/install-bin/multica" ]]; then
    echo "server modes must not touch docker, git, or the CLI" >&2
    cat "$tmp/server.log" "$tmp/curl.log" >&2 2>/dev/null || true
    return 1
  fi
}

test_fresh_install_downloads_pinned_release
test_pinned_version_already_installed_is_kept
test_newer_version_is_replaced_with_pinned_release
test_shadowing_cli_fails_instead_of_reporting_success
test_cli_version_override
test_remote_ssh_install_prints_token_login_hint
test_local_install_does_not_print_token_login_hint
test_server_modes_point_to_codeloom_deployment
echo "install.sh tests passed"
