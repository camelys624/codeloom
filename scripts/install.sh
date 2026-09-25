#!/usr/bin/env bash
# Modified for Codeloom: install only the Multica CLI release that matches the Codeloom server.
#
# Multica CLI installer for Codeloom. Codeloom does not modify the CLI, so this
# installs the upstream Multica CLI pinned to the release Codeloom is built on.
# The Codeloom server is source-built; see SELF_HOSTING.md#codeloom-internal-deployment.
#
# Install the CLI, or switch an existing one to the pinned version:
#   curl -fsSL https://raw.githubusercontent.com/camelys624/codeloom/main/scripts/install.sh | bash
#
# After installation, run `multica setup self-host` to connect to your Codeloom server.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# Keep in step with the upstream release Codeloom is based on.
DEFAULT_CLI_VERSION="v0.5.0"
CLI_VERSION="${MULTICA_CLI_VERSION:-$DEFAULT_CLI_VERSION}"
CLI_VERSION="v${CLI_VERSION#v}"
CLI_RELEASES_URL="https://github.com/multica-ai/multica/releases"
SELFHOST_DOCS_URL="https://github.com/camelys624/codeloom/blob/main/SELF_HOSTING.md#codeloom-internal-deployment"

# Colors (disabled when not a terminal)
if [ -t 1 ] || [ -t 2 ]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' CYAN='' RESET=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "${BOLD}${CYAN}==> %s${RESET}\n" "$*"; }
ok()    { printf "${BOLD}${GREEN}✓ %s${RESET}\n" "$*"; }
warn()  { printf "${BOLD}${YELLOW}⚠ %s${RESET}\n" "$*" >&2; }
fail()  { printf "${BOLD}${RED}✗ %s${RESET}\n" "$*" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

running_in_ssh_session() {
  [ -n "${SSH_CONNECTION:-}" ] || [ -n "${SSH_CLIENT:-}" ] || [ -n "${SSH_TTY:-}" ]
}

print_remote_server_token_hint() {
  if ! running_in_ssh_session; then
    return
  fi

  printf "  ${BOLD}Looks like a remote/SSH session.${RESET} Browser login may not be able to call back to this machine's localhost.\n"
  printf "  Token login is usually simpler here:\n"
  printf "     1. In the Codeloom web UI, create a token under ${BOLD}Settings > API Tokens${RESET} (设置 > API Token).\n"
  printf "     2. On this machine, run (the token is prompted, keeping it out of shell history):\n"
  printf "        ${CYAN}multica config set app_url <web-url>${RESET}\n"
  printf "        ${CYAN}multica login --server-url <backend-url> --token${RESET}\n"
  printf "        ${CYAN}multica daemon start --no-auto-update${RESET}\n"
  printf "\n"
}

detect_os() {
  case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    MINGW*|MSYS*|CYGWIN*)
            fail "This script does not support Windows. Use the PowerShell installer instead:
  irm https://raw.githubusercontent.com/camelys624/codeloom/main/scripts/install.ps1 | iex" ;;
    *)      fail "Unsupported operating system: $(uname -s). Multica supports macOS, Linux, and Windows." ;;
  esac

  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    arm64)   ARCH="arm64" ;;
    *)       fail "Unsupported architecture: $ARCH" ;;
  esac
}

# `multica version` outputs "multica 0.5.0 (commit: ..., built: ...)" — print just
# the version, without a leading 'v'.
installed_cli_version() {
  local version
  version=$(multica version 2>/dev/null | awk 'NR==1{print $2}' || true)
  printf '%s' "${version#v}"
}

# ---------------------------------------------------------------------------
# CLI Installation
# ---------------------------------------------------------------------------
install_cli_binary() {
  info "Installing Multica CLI $CLI_VERSION from GitHub Releases..."

  local version="${CLI_VERSION#v}"
  local url="$CLI_RELEASES_URL/download/${CLI_VERSION}/multica-cli-${version}-${OS}-${ARCH}.tar.gz"
  local tmp_dir
  tmp_dir=$(mktemp -d)

  info "Downloading $url ..."
  if ! curl -fsSL "$url" -o "$tmp_dir/multica.tar.gz"; then
    rm -rf "$tmp_dir"
    fail "Failed to download CLI binary."
  fi

  tar -xzf "$tmp_dir/multica.tar.gz" -C "$tmp_dir" multica

  # Try /usr/local/bin first, fall back to ~/.local/bin. Tests and scripted
  # installs can override the first choice with MULTICA_BIN_DIR.
  local bin_dir="${MULTICA_BIN_DIR:-/usr/local/bin}"
  if [ -w "$bin_dir" ]; then
    mv "$tmp_dir/multica" "$bin_dir/multica"
  elif command_exists sudo; then
    sudo mv "$tmp_dir/multica" "$bin_dir/multica"
  else
    bin_dir="$HOME/.local/bin"
    mkdir -p "$bin_dir"
    mv "$tmp_dir/multica" "$bin_dir/multica"
    chmod +x "$bin_dir/multica"
    # Add to PATH if not already there
    if ! echo "$PATH" | tr ':' '\n' | grep -q "^$bin_dir$"; then
      export PATH="$bin_dir:$PATH"
      add_to_path "$bin_dir"
    fi
  fi

  rm -rf "$tmp_dir"
  ok "Multica CLI installed to $bin_dir/multica"
}

add_to_path() {
  local dir="$1"
  local line="export PATH=\"$dir:\$PATH\""
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ] && ! grep -qF "$dir" "$rc"; then
      printf '\n# Added by Multica installer\n%s\n' "$line" >> "$rc"
    fi
  done
}

install_cli() {
  if command_exists multica; then
    local current_ver
    current_ver=$(installed_cli_version)
    if [ "$current_ver" = "${CLI_VERSION#v}" ]; then
      ok "Multica CLI is already $CLI_VERSION"
      return 0
    fi
    info "Multica CLI ${current_ver:-unknown} installed, Codeloom uses $CLI_VERSION — replacing..."
  fi

  install_cli_binary
  hash -r

  # Another multica earlier on PATH (e.g. from Homebrew, which cannot pin a
  # version) would keep shadowing the binary just installed.
  local new_ver
  new_ver=$(installed_cli_version)
  if [ "$new_ver" != "${CLI_VERSION#v}" ]; then
    fail "Installed $CLI_VERSION, but 'multica' on PATH is ${new_ver:+v$new_ver at }$(command -v multica || echo 'not found').
  Remove the other copy (for Homebrew: brew uninstall multica) or restart your shell, then re-run this script."
  fi
}

# ---------------------------------------------------------------------------
# Main: install / switch the CLI
# ---------------------------------------------------------------------------
run_default() {
  printf "\n"
  printf "${BOLD}  Multica CLI for Codeloom — Installer${RESET}\n"
  printf "\n"

  detect_os
  install_cli

  printf "\n"
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  printf "${BOLD}${GREEN}  ✓ Multica CLI %s is ready!${RESET}\n" "$CLI_VERSION"
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  printf "\n"
  printf "  ${BOLD}Next: connect to your Codeloom server${RESET}\n"
  printf "\n"
  printf "     ${CYAN}multica setup self-host --server-url <backend-url> --app-url <web-url>${RESET}\n"
  printf "     ${CYAN}multica daemon restart --no-auto-update${RESET}   # keep the daemon on %s\n" "$CLI_VERSION"
  printf "\n"
  print_remote_server_token_hint
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --with-server|--local|--stop)
        fail "$1 is not supported: the upstream self-host server it manages does not include Codeloom's changes.
  Deploy Codeloom from source instead: $SELFHOST_DOCS_URL"
        ;;
      --help|-h)
        echo "Usage: install.sh"
        echo ""
        echo "  Install the Multica CLI $CLI_VERSION used with Codeloom, replacing"
        echo "  any other installed version."
        echo ""
        echo "Environment variables:"
        echo "  MULTICA_CLI_VERSION   CLI release to install (default: $DEFAULT_CLI_VERSION)"
        echo "  MULTICA_BIN_DIR       Target directory for the CLI binary"
        echo "                        (default: /usr/local/bin, then \$HOME/.local/bin)"
        echo ""
        echo "To deploy the Codeloom server, see $SELFHOST_DOCS_URL"
        exit 0
        ;;
      *) warn "Unknown option: $1" ;;
    esac
    shift
  done

  run_default
}

main "$@"
