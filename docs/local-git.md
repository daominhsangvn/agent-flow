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
```

`local-git:init` (scripts/local-git-init.mjs) is idempotent. It

- creates the admin account (`agentflow`; `LOCAL_GIT_ADMIN_USER`,
  `LOCAL_GIT_ADMIN_PASSWORD`, `LOCAL_GIT_ADMIN_EMAIL` in `.env` override it).
  Without a password one is generated and printed once: change it in Local
  Git → Settings;
- with `--org`, creates an organization for the team's repositories;
- prints a new access token (scopes `write:repository`, `write:organization`,
  `write:user`, `write:issue`) and the values of the connection form. Every run
  issues another token; revoke old ones in Local Git → Settings → Applications.

The web UI is at **http://localhost:3300** (`LOCAL_GIT_PORT`; set
`LOCAL_GIT_URL` too when browsers reach it under another address). Sign-in is
required and new repositories are private. Data lives in the `local_git_data`
volume (`docker run --rm -v agentflow_local_git_data:/data -v "$PWD:/backup"
alpine tar czf /backup/local-git.tgz /data` backs it up).

## Connect AgentFlow

Settings → Integrations → Connections → Add connection → **Local Git**:

| Field | Value |
|-------|-------|
| Server URL | Where the AgentFlow API reaches it: `http://localhost:3300` when the API runs on the same machine. |
| Runner URL | Where runners reach it, when that differs: `http://host.docker.internal:3300` for runner containers on this machine, the machine's network address for runners elsewhere. Empty = the server URL. Repositories added before a change keep their old clone URL: remove and add them again. |
| Access token | The token printed by `pnpm local-git:init`. |
| Owner | The organization (or user) whose repositories projects can add, and where new ones are created. Empty = every repository the token can see; new ones go to the token's account. |

## Use it in a project

Project → Repositories → **Add repository** → choose the Local Git connection:

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
