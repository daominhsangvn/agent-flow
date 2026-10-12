# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# AgentFlow headless runner: base image.
#
# A plain Node.js process (no Electron, no UI) that connects to a self-hosted
# AgentFlow API, registers as a compute target and runs agent loops with the
# Claude Code CLI and the vendored plugins (agent-plugins/). The runner code is
# the desktop gateway, bundled by `pnpm -C apps/desktop build:headless`.
#
#   docker buildx build -f deploy/runner/Dockerfile -t agentflow-runner:base .
#
# Projects extend this image with their toolchain (see
# deploy/runner/examples/). Configuration and volumes: docs/runner.md.
#
# Validate both targets when changing it (root AGENTS.md "Dockerized
# Workspace Apps"):
#   docker buildx build -f deploy/runner/Dockerfile --target builder .
#   docker buildx build -f deploy/runner/Dockerfile .
# ---------------------------------------------------------------------------

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_STORE_PATH=/pnpm/store
RUN corepack enable

# --- Pruner: the desktop workspace closure (manifests + source) ---
FROM base AS pruner
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=af-runner-pnpm-store,target=/pnpm/store,sharing=locked \
    corepack prepare --activate && \
    pnpm config set store-dir "${PNPM_STORE_PATH}" && \
    turbo_version="$(node -p "require('./package.json').devDependencies.turbo.match(/[0-9.]+/)[0]")" && \
    pnpm dlx "turbo@${turbo_version}" prune desktop --docker

# --- Builder: install the closure and bundle the runner ---
FROM base AS builder
WORKDIR /app
# Only the JavaScript is bundled; never download Electron or browsers.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --from=pruner /repo/out/json/ ./
# Full lockfile + workspace manifest + patches, as in apps/api/Dockerfile:
# the pruned lockfile and workspace yaml do not survive a frozen install.
COPY --from=pruner /repo/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /repo/patches/ ./patches/
RUN corepack prepare --activate
RUN --mount=type=cache,id=af-runner-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir "${PNPM_STORE_PATH}" && \
    pnpm config set fetch-retries 5 && \
    pnpm config set fetch-timeout 600000 && \
    pnpm install --frozen-lockfile --filter desktop... --ignore-scripts --prefer-offline
RUN pnpm config set ignore-scripts true
COPY --from=pruner /repo/out/full/ ./
ARG BUILD_COMMIT_HASH=unknown
RUN BUILD_COMMIT_HASH="${BUILD_COMMIT_HASH}" pnpm -C apps/desktop build:headless

# --- Runtime ---
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# "stable" (about a week behind, skips bad releases) or "latest".
ARG CLAUDE_CODE_CHANNEL=stable
# Fingerprint of the Claude Code release signing key (docs: code.claude.com/docs/en/setup).
ARG CLAUDE_CODE_KEY_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash ca-certificates curl git gnupg jq less openssh-client procps \
      python3 python3-yaml ripgrep tini unzip; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    curl -fsSL https://downloads.claude.ai/keys/claude-code.asc \
      -o /etc/apt/keyrings/claude-code.asc; \
    gpg --show-keys --with-colons /etc/apt/keyrings/claude-code.asc \
      | grep -q "^fpr:*${CLAUDE_CODE_KEY_FINGERPRINT}:"; \
    echo "deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/${CLAUDE_CODE_CHANNEL} ${CLAUDE_CODE_CHANNEL} main" \
      > /etc/apt/sources.list.d/claude-code.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh claude-code; \
    rm -rf /var/lib/apt/lists/*; \
    claude --version; gh --version

# Run as an unprivileged user (Claude Code and the agent's tools do not need root).
RUN usermod --login runner --home /home/runner --move-home node \
    && groupmod --new-name runner node \
    && install -d -o runner -g runner -m 0755 /workspace \
    && install -d -o runner -g runner -m 0700 /home/runner/.agentflow-runner /home/runner/.claude /home/runner/.agentflow-ai

COPY --from=builder /app/apps/desktop/dist-headless/ /opt/agentflow-runner/
COPY --from=pruner /repo/agent-plugins/ /opt/agentflow-runner/agent-plugins/
COPY deploy/runner/entrypoint.sh /usr/local/bin/agentflow-runner-entrypoint
RUN chmod 0755 /usr/local/bin/agentflow-runner-entrypoint \
    && find /opt/agentflow-runner/agent-plugins -name '*.sh' -exec chmod 0755 {} +

ENV SHELL=/bin/bash \
    HOME=/home/runner \
    AGENTFLOW_PLUGINS_DIR=/opt/agentflow-runner/agent-plugins \
    AGENTFLOW_RUNNER_WORKSPACE=/workspace \
    AGENTFLOW_RUNNER_DATA_DIR=/home/runner/.agentflow-runner \
    DISABLE_AUTOUPDATER=1

USER runner
WORKDIR /workspace
# Workspace (checkouts and loop worktrees), runner identity, Claude Code state
# (sessions; no credentials: the model provider comes with each loop) and
# AgentFlow learnings all survive recreating the container.
VOLUME ["/workspace", "/home/runner/.agentflow-runner", "/home/runner/.claude", "/home/runner/.agentflow-ai"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "/opt/agentflow-runner/healthcheck.mjs"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentflow-runner-entrypoint"]
CMD ["node", "/opt/agentflow-runner/runner.mjs"]
