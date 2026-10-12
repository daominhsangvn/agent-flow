# syntax=docker/dockerfile:1
# Example project runner: the AgentFlow base runner plus the toolchain a
# Node.js/pnpm project needs to build and test, so the agent team can verify
# its own changes.
#
#   docker build -f deploy/runner/examples/node-project.Dockerfile \
#     --build-arg BASE_IMAGE=agentflow-runner:base -t agentflow-runner:my-web-app .
#
# The base image already has Node.js 24, git, gh, jq, python3 and Claude Code.
# Other stacks follow the same shape, for example:
#   .NET:   USER root; apt-get install -y dotnet-sdk-8.0 (after adding the Microsoft apt repo); USER runner
#   Java:   USER root; apt-get install -y openjdk-17-jdk-headless maven; USER runner
#   Python: USER root; apt-get install -y python3-venv python3-pip; USER runner

ARG BASE_IMAGE=agentflow-runner:base
FROM ${BASE_IMAGE}

USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential; \
    rm -rf /var/lib/apt/lists/*; \
    corepack enable; \
    corepack prepare pnpm@latest --activate
USER runner

# Optional: pre-clone the repository so the first loop does not wait for a
# clone (the runner clones missing repositories into /workspace with gh).
# RUN gh repo clone your-org/your-repo /workspace/your-repo
