# syntax=docker/dockerfile:1
# Example project runner for Rust / Tauri 2 desktop apps: the AgentFlow base
# runner plus Rust (rustup, stable) and the Linux libraries Tauri compiles
# against (WebKitGTK 4.1, GTK, libsoup, OpenSSL), so the agent team can build
# and test its own changes (cargo check / cargo test / tauri build --no-bundle).
#
#   docker build -f deploy/runner/examples/tauri-project.Dockerfile \
#     --build-arg BASE_IMAGE=agentflow-runner:base -t agentflow-runner:tauri .
#
# Rust lives in /usr/local (CARGO_HOME, RUSTUP_HOME) and belongs to the runner
# user, so cargo can fill its registry cache at run time. Plain Rust projects
# can drop the GTK / WebKit packages.

ARG BASE_IMAGE=agentflow-runner:base
FROM ${BASE_IMAGE}

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH}

USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential curl file pkg-config \
      libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
      libssl-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev; \
    rm -rf /var/lib/apt/lists/*; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path; \
    rustup component add clippy rustfmt; \
    chown -R runner:runner "$RUSTUP_HOME" "$CARGO_HOME"; \
    # The runner (and the agents it starts) take PATH from a login shell, and
    # /etc/profile resets PATH there: put cargo back on it.
    printf '%s\n' \
      'export RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo' \
      'case ":$PATH:" in *:/usr/local/cargo/bin:*) ;; *) PATH="/usr/local/cargo/bin:$PATH" ;; esac' \
      'export PATH' > /etc/profile.d/rust.sh; \
    cargo --version; rustc --version; \
    su runner -s /bin/bash -lc 'cargo --version'
USER runner
