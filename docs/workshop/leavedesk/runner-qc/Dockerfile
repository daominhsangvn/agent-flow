# QC runner: the AgentFlow headless runner image plus Playwright's Chromium, so
# the QC workflow can start LeaveDesk and run the leavedesk-qa specs.
# Build after the base image (deploy/runner/Dockerfile → agentflow-runner:base):
#   docker build -t agentflow-runner:qc docs/workshop/leavedesk/runner-qc
# The Playwright version must match @playwright/test in leavedesk-qa.
FROM agentflow-runner:base

ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends lsof; \
    HOME=/root npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium; \
    chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"; \
    rm -rf /var/lib/apt/lists/* /root/.npm /home/runner/.npm; \
    echo "export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}" > /etc/profile.d/playwright.sh
USER runner
