#!/usr/bin/env bash
# Installs (or upgrades) the AgentFlow headless runner on Ubuntu 22.04+/Debian 12+
# as a systemd service. Run as root from the unpacked release directory:
#
#   tar -xzf agentflow-runner-<version>-linux.tar.gz
#   sudo ./agentflow-runner/install.sh
#
# Installs Node.js 24 (NodeSource), git, gh, jq, python3 + PyYAML and Claude
# Code (official apt repositories), creates the `agentflow-runner` system
# user, copies the runner to /opt/agentflow-runner and installs
# agentflow-runner.service. Existing configuration is never overwritten.
# See docs/runner.md.
set -euo pipefail

INSTALL_DIR=/opt/agentflow-runner
CONFIG_DIR=/etc/agentflow-runner
ENV_FILE="$CONFIG_DIR/runner.env"
SERVICE_USER=agentflow-runner
SERVICE_HOME=/var/lib/agentflow-runner
SERVICE_FILE=/etc/systemd/system/agentflow-runner.service
NODE_MAJOR=24
MIN_NODE_MAJOR=22
CLAUDE_CODE_CHANNEL="${CLAUDE_CODE_CHANNEL:-stable}"
CLAUDE_CODE_KEY_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "run as root (sudo $0)"
command -v apt-get >/dev/null || fail "this installer supports Debian/Ubuntu (apt) only"
[[ -f "$SOURCE_DIR/runner.mjs" && -d "$SOURCE_DIR/agent-plugins" ]] \
  || fail "run install.sh from the unpacked release directory"

export DEBIAN_FRONTEND=noninteractive
keyrings=/etc/apt/keyrings

install_base_packages() {
  log "Installing base packages"
  apt-get update -q
  apt-get install -y -q --no-install-recommends \
    bash ca-certificates curl git gnupg jq less openssh-client procps \
    python3 python3-yaml ripgrep unzip
  install -d -m 0755 "$keyrings"
}

install_node() {
  local current=0
  if command -v node >/dev/null; then
    current="$(node -p 'process.versions.node.split(".")[0]')"
  fi
  if (( current >= MIN_NODE_MAJOR )); then
    log "Node.js $(node --version) already installed"
    return
  fi
  log "Installing Node.js ${NODE_MAJOR} (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -q nodejs
}

install_gh() {
  if command -v gh >/dev/null; then
    log "GitHub CLI already installed"
    return
  fi
  log "Installing GitHub CLI"
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o "$keyrings/githubcli-archive-keyring.gpg"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=$keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -q
  apt-get install -y -q gh
}

install_claude_code() {
  if command -v claude >/dev/null; then
    log "Claude Code already installed ($(claude --version))"
    return
  fi
  log "Installing Claude Code (${CLAUDE_CODE_CHANNEL} channel)"
  curl -fsSL https://downloads.claude.ai/keys/claude-code.asc -o "$keyrings/claude-code.asc"
  gpg --show-keys --with-colons "$keyrings/claude-code.asc" \
    | grep -q "^fpr:*${CLAUDE_CODE_KEY_FINGERPRINT}:" \
    || fail "unexpected Claude Code signing key fingerprint"
  echo "deb [signed-by=$keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/${CLAUDE_CODE_CHANNEL} ${CLAUDE_CODE_CHANNEL} main" \
    > /etc/apt/sources.list.d/claude-code.list
  apt-get update -q
  apt-get install -y -q claude-code
}

create_service_user() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Creating system user $SERVICE_USER"
    useradd --system --create-home --home-dir "$SERVICE_HOME" --shell /bin/bash "$SERVICE_USER"
  fi
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$SERVICE_HOME/workspace"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$SERVICE_HOME/data" "$SERVICE_HOME/.claude"
}

install_runner_files() {
  log "Installing the runner to $INSTALL_DIR"
  local staging="${INSTALL_DIR}.new"
  rm -rf "$staging"
  install -d -m 0755 "$staging"
  cp -R "$SOURCE_DIR/runner.mjs" "$SOURCE_DIR/healthcheck.mjs" "$SOURCE_DIR/agent-plugins" "$staging/"
  cp "$SOURCE_DIR"/*.map "$SOURCE_DIR"/*.LEGAL.txt "$staging/" 2>/dev/null || true
  install -m 0755 "$SOURCE_DIR/entrypoint.sh" "$staging/entrypoint.sh"
  find "$staging/agent-plugins" -name '*.sh' -exec chmod 0755 {} +
  chown -R root:root "$staging"
  rm -rf "$INSTALL_DIR"
  mv "$staging" "$INSTALL_DIR"
}

install_config() {
  install -d -m 0750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"
  if [[ -f "$ENV_FILE" ]]; then
    log "Keeping existing $ENV_FILE"
  else
    install -m 0640 -o root -g "$SERVICE_USER" "$SOURCE_DIR/runner.env.example" "$ENV_FILE"
    log "Wrote $ENV_FILE (edit it before starting the service)"
  fi
}

install_service() {
  install -m 0644 "$SOURCE_DIR/agentflow-runner.service" "$SERVICE_FILE"
  if [[ -d /run/systemd/system ]]; then
    systemctl daemon-reload
    systemctl enable agentflow-runner.service >/dev/null
    if systemctl is-active --quiet agentflow-runner.service; then
      log "Restarting the running service with the new version"
      systemctl restart agentflow-runner.service
    fi
  else
    log "systemd is not running here; start the runner manually (see docs/runner.md)"
  fi
}

install_base_packages
install_node
install_gh
install_claude_code
create_service_user
install_runner_files
install_config
install_service

cat <<EOF

AgentFlow runner installed.
  1. Edit $ENV_FILE: AGENTFLOW_API_URL, AGENTFLOW_API_KEY, a Claude credential and GH_TOKEN.
  2. sudo systemctl start agentflow-runner
  3. journalctl -u agentflow-runner -f
EOF
