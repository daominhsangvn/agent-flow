#!/usr/bin/env bash
# Sets up An's Ubuntu machine (container leavedesk-dev-an) for the personal
# runner test, as a developer sets up their own computer:
#   - a Local Git (Gitea) account `an` with write access to leavedesk-app and
#     leavedesk-superpowers, its token in git's credential store and in tea;
#   - the dev's project folder ~/work/leavedesk: both repositories cloned, the
#     superpowers skills linked into .claude/skills, a CLAUDE.md for the folder;
#   - the runner bundle in ~/agentflow-runner (runner.mjs and agent-plugins/).
# The Jira login (`jira login`) and the runner setup are the developer's: see
# README.md. Run from the repository root:
#   docs/workshop/leavedesk/dev-machine/setup.sh
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/docs/workshop/leavedesk/dev-machine"
CONTAINER=leavedesk-dev-an
IMAGE=leavedesk-dev-machine
GITEA_HOST=http://localhost:3300
GITEA_IN_CONTAINER=http://host.docker.internal:3300
ORG=workshop
REPOS=(leavedesk-app leavedesk-superpowers)
DEV_USER=an
DEV_EMAIL=an@leavedesk.dev
DEV_NAME="An Nguyen"

admin_token="$(grep -E '^LOCAL_GIT_TOKEN=' "$ROOT/apps/api/.env.local" | cut -d= -f2- | tr -d '"')"
[[ -n "$admin_token" ]] || { echo "LOCAL_GIT_TOKEN missing in apps/api/.env.local" >&2; exit 1; }
gitea() {
  curl -fsS -H "Authorization: token $admin_token" -H "Content-Type: application/json" "$@"
}

echo "== Ubuntu machine"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" "$HERE"
if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  docker run -d --name "$CONTAINER" --hostname an-ubuntu \
    -v "$CONTAINER-home:/home/an" "$IMAGE" >/dev/null
fi
docker start "$CONTAINER" >/dev/null

echo "== Local Git account $DEV_USER"
# The CLI, as the API token of the Local Git connection has no admin scope.
if ! docker exec -u git agentflow-local-git-1 gitea admin user list | awk '{print $2}' | grep -qx "$DEV_USER"; then
  docker exec -u git agentflow-local-git-1 gitea admin user create --username "$DEV_USER" \
    --email "$DEV_EMAIL" --fullname "$DEV_NAME" --random-password --must-change-password=false >/dev/null
fi
for repo in "${REPOS[@]}"; do
  gitea -X PUT "$GITEA_HOST/api/v1/repos/$ORG/$repo/collaborators/$DEV_USER" \
    --data '{"permission": "write"}' >/dev/null
done
# A fresh token for the machine (Gitea shows a token only once).
dev_token="$(docker exec -u git agentflow-local-git-1 gitea admin user generate-access-token \
  --username "$DEV_USER" --token-name "an-ubuntu-$(date +%s)" \
  --scopes write:repository,read:user,read:organization --raw)"

echo "== Credentials and project folder in the machine"
printf '%s\n' "$dev_token" | docker exec -i -e GITEA="$GITEA_IN_CONTAINER" \
  -e DEV_USER="$DEV_USER" -e DEV_EMAIL="$DEV_EMAIL" -e DEV_NAME="$DEV_NAME" -e ORG="$ORG" \
  "$CONTAINER" bash -euo pipefail -c '
    read -r token
    git config --global user.name "$DEV_NAME"
    git config --global user.email "$DEV_EMAIL"
    git config --global init.defaultBranch main
    git config --global credential.helper store
    host="${GITEA#http://}"
    (umask 077; printf "http://%s:%s@%s\n" "$DEV_USER" "$token" "$host" > ~/.git-credentials)
    tea logins delete local >/dev/null 2>&1 || true
    tea login add --name local --url "$GITEA" --token "$token" >/dev/null
    tea login default local >/dev/null
    mkdir -p ~/work/leavedesk/.claude
    cd ~/work/leavedesk
    for repo in leavedesk-app leavedesk-superpowers; do
      [ -d "$repo/.git" ] || git clone -q "$GITEA/$ORG/$repo.git"
    done
    ln -sfn ../leavedesk-superpowers/.claude/skills .claude/skills
  '
docker cp "$HERE/project-CLAUDE.md" "$CONTAINER:/home/an/work/leavedesk/CLAUDE.md"

echo "== Runner bundle"
docker exec "$CONTAINER" mkdir -p /home/an/agentflow-runner
# As in the runner release: runner.mjs with agent-plugins/ next to it.
docker cp "$ROOT/apps/desktop/dist-headless/runner.mjs" "$CONTAINER:/home/an/agentflow-runner/runner.mjs"
docker exec "$CONTAINER" rm -rf /home/an/agentflow-runner/agent-plugins
docker cp "$ROOT/agent-plugins" "$CONTAINER:/home/an/agentflow-runner/agent-plugins"
docker exec -u root "$CONTAINER" chown -R an:an /home/an/work /home/an/agentflow-runner

echo
echo "Done. Next, as the developer (see README.md):"
echo "  docker exec -it $CONTAINER jira login"
echo "  docker exec -it $CONTAINER node agentflow-runner/runner.mjs setup --project PRO-1"
