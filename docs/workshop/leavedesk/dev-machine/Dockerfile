# A developer's Ubuntu machine for the personal runner test: Node, git, the
# Gitea CLI (tea), Claude Code and the developer's own `jira` command. The
# runner bundle, the repositories and the credentials are added by setup.sh,
# as the developer would on their own computer.
#   docker build -t leavedesk-dev-machine docs/workshop/leavedesk/dev-machine
FROM ubuntu:24.04

ARG NODE_VERSION=24.16.0
ARG TEA_VERSION=0.9.2
# The Claude proxy of the workshop only accepts the version pinned on runner-1
# (Model provider > Claude Code version).
ARG CLAUDE_CODE_VERSION=2.1.307

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq less procps python3 ripgrep unzip xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    arch="$(dpkg --print-architecture)"; \
    node_arch="$(echo "$arch" | sed 's/amd64/x64/')"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude LICENSE --exclude README.md; \
    curl -fsSL -o /usr/local/bin/tea "https://dl.gitea.com/tea/${TEA_VERSION}/tea-${TEA_VERSION}-linux-${arch}"; \
    chmod 0755 /usr/local/bin/tea; \
    node --version; tea --version

# The developer: An (the image's default user, renamed).
RUN usermod --login an --home /home/an --move-home --comment "An Nguyen" ubuntu \
    && groupmod --new-name an ubuntu

COPY jira /usr/local/bin/jira
RUN chmod 0755 /usr/local/bin/jira

USER an
WORKDIR /home/an
ENV HOME=/home/an \
    SHELL=/bin/bash \
    PATH=/home/an/.local/bin:$PATH \
    DISABLE_AUTOUPDATER=1 \
    # The workshop's AgentFlow API is plain http on the Mac, and the MCP
    # server (instruction actions' integration tools) is reached through the host.
    AGENTFLOW_ALLOW_HTTP_HOSTS=host.docker.internal \
    AGENTFLOW_MCP_URL=http://host.docker.internal:3010/mcp
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
    && claude --version

CMD ["sleep", "infinity"]
