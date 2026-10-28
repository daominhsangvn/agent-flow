# Local Git

Git hosting on your own machine, for projects that have no remote repository
(no GitHub, Azure DevOps or Bitbucket). It is the `local-git` service of
`docker-compose.yml`: [Gitea](https://about.gitea.com) (MIT), a complete git
server with a web UI. Everything git does works: branches, tags, history,
clone/fetch/push over HTTP, pull requests with review and merge, and
downloading a branch or tag as a zip or tar.gz.

AgentFlow talks to it through the **Local Git** integration
(`apps/api/lib/integrations/providers/local-git/`): projects add or create
repositories from it, agents clone and push with the connection's token
(issued per loop, never stored on runners), and the workflow action
"Create pull request" opens pull requests that you review and merge in the
Local Git web UI.

## Start it

```bash
docker compose up -d local-git
pnpm local-git:init --org my-team
# restart the API (pnpm dev) so it reads the new values
```

`local-git:init` (scripts/local-git-init.mjs) is idempotent. It

- creates the admin account (`agentflow`; `LOCAL_GIT_ADMIN_USER`,
  `LOCAL_GIT_ADMIN_PASSWORD`, `LOCAL_GIT_ADMIN_EMAIL` in `.env` override it).
  Without a password one is generated and printed once: change it in Local
  Git → Settings;
- with `--org`, creates an organization for the team's repositories;
- issues a new access token (scopes `write:repository`, `write:organization`,
  `write:user`, `write:issue`) and writes it, with the addresses, to
  `apps/api/.env.local` (`--no-env` prints them instead). Every run issues
  another token; revoke old ones in Local Git → Settings → Applications.

The web UI is at **http://localhost:3300** (`LOCAL_GIT_PORT`; set
`LOCAL_GIT_URL` too when browsers reach it under another address). Sign-in is
required and new repositories are private. Data lives in the `local_git_data`
volume (`docker run --rm -v agentflow_local_git_data:/data -v "$PWD:/backup"
alpine tar czf /backup/local-git.tgz /data` backs it up).

## The default connection

Local Git is the default git hosting, so nobody adds its connection: when the
API has `LOCAL_GIT_TOKEN`, every organization has a **Local Git** connection
(Settings → Integrations → Connections lists it as *Default*, and Add
connection no longer offers Local Git). The API creates each organization's
connection the first time its connections are listed, and refreshes it when
these values change (`apps/api/lib/integrations/server-connections.ts`):

| Variable (`apps/api/.env.local`) | Value |
|-------|-------|
| `LOCAL_GIT_SERVER_URL` | Where the AgentFlow API reaches it: `http://localhost:3300` (default) when the API runs on the same machine. |
| `LOCAL_GIT_RUNNER_URL` | Where runners reach it, when that differs: `http://host.docker.internal:3300` for runner containers on this machine, the machine's network address for runners elsewhere. Empty = the server URL. Repositories added before a change keep their old clone URL: remove and add them again. |
| `LOCAL_GIT_TOKEN` | The access token `pnpm local-git:init` issued. Without it there is no default connection, and an admin can add a Local Git connection by hand instead. |
| `LOCAL_GIT_OWNER` | The organization (or user) whose repositories projects can add, and where new ones are created. Empty = every repository the token can see; new ones go to the token's account. |

The default connection is read-only in Settings (Test still works): change
it through these variables and restart the API. A Local Git connection an
admin added earlier for the same server (same server and runner URLs) is
adopted as the default rather than duplicated: it keeps its id, so the
project repositories and workflow actions using it keep working. It is
recognised by having no creator, and written under a per-organization
advisory lock, so concurrent requests never create two.

## Use it in a project

Project → Integrations → **Add repository** → choose the Local Git connection:

- **Add** an existing repository from the list, or
- **Create and add**: a new private repository with a first commit on `main`
  (README), added to the project right away.

Each repository row links to its page in Local Git: code, commits, branches,
pull requests, and **Download** (zip / tar.gz) of any branch or tag. Clone it
like any remote:

```bash
git clone http://localhost:3300/my-team/my-repo.git
```

Agents push a branch per run (`symphony/…`); with the "Create pull request"
post action, the pull requests appear in Local Git → the repository → Pull
requests, where you review and merge them. A draft pull request is opened
with Gitea's `WIP:` title prefix.

## Moving to a remote later

Local Git is a normal git server: add the new remote and push everything,
then add the repository from the new provider's connection and remove the
Local Git one from the project.

```bash
git clone --mirror http://localhost:3300/my-team/my-repo.git
cd my-repo.git && git push --mirror https://github.com/my-org/my-repo.git
```

## Limits

- Nothing flows back from Local Git: merging or closing a pull request there
  is not reported to AgentFlow (no webhooks/triggers yet), like Bitbucket.
- The Build section of a plan ("No branch exists yet") and PR-based code
  evaluation only know GitHub pull requests.
- No SSH: git runs over HTTP(S) with a token or the account password.
