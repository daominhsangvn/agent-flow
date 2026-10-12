// Prepares Local Git (the `local-git` service of docker-compose.yml, Gitea):
// creates its admin account, optionally an organization, and prints an access
// token for the "Local Git" connection (Settings → Integrations →
// Connections). Idempotent: an existing account and organization are kept;
// every run issues a new token (revoke old ones in Local Git → Settings →
// Applications).
//
//   pnpm local-git:init                     # account + token
//   pnpm local-git:init --org my-team       # also an organization
//   pnpm local-git:init --no-token          # account only
//   pnpm local-git:init --json              # machine-readable output
//
// Reads LOCAL_GIT_URL / LOCAL_GIT_PORT and LOCAL_GIT_ADMIN_USER /
// LOCAL_GIT_ADMIN_PASSWORD / LOCAL_GIT_ADMIN_EMAIL from the environment or the
// `.env` next to docker-compose.yml. Without a password one is generated and
// printed once.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const LINE_BREAK = /\r?\n/;
const ENV_LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/;
const SURROUNDING_QUOTES = /^(["'])(.*)\1$/;
const TRAILING_SLASHES = /\/+$/;
const TOKEN_SCOPES =
  "write:repository,write:organization,write:user,write:issue";
const HEALTH_TIMEOUT_MS = 60_000;

const root = path.resolve(import.meta.dirname, "..");
const env = { ...readDotEnv(path.join(root, ".env")), ...process.env };
const args = process.argv.slice(2);

const url = (
  env.LOCAL_GIT_URL ?? `http://localhost:${env.LOCAL_GIT_PORT ?? "3300"}`
).replace(TRAILING_SLASHES, "");
const username = env.LOCAL_GIT_ADMIN_USER ?? "agentflow";
const email = env.LOCAL_GIT_ADMIN_EMAIL ?? `${username}@local-git.invalid`;
const organization = readOption("--org");
const wantsToken = !args.includes("--no-token");
const asJson = args.includes("--json");

await waitForHealth();
const password = createAdmin();
const token = wantsToken ? createToken() : null;
if (organization && token) {
  await createOrganization(organization, token);
}
report({ password, token });

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  fail(
    `Local Git does not answer at ${url}. Start it with \`docker compose up -d local-git\`.`
  );
}

/** The generated password, or null when it came from the env or the account existed. */
function createAdmin() {
  const generated = env.LOCAL_GIT_ADMIN_PASSWORD
    ? null
    : randomBytes(18).toString("base64url");
  const result = gitea([
    "admin",
    "user",
    "create",
    "--admin",
    "--username",
    username,
    "--email",
    email,
    "--password",
    env.LOCAL_GIT_ADMIN_PASSWORD ?? generated,
    "--must-change-password=false",
  ]);
  if (result.ok) {
    return generated;
  }
  if (result.output.includes("already exists")) {
    return null;
  }
  fail(`Could not create the account ${username}: ${result.output}`);
}

function createToken() {
  const name = `agentflow-${new Date().toISOString().replaceAll(/\D/g, "").slice(0, 14)}`;
  const result = gitea([
    "admin",
    "user",
    "generate-access-token",
    "--username",
    username,
    "--token-name",
    name,
    "--scopes",
    TOKEN_SCOPES,
    "--raw",
  ]);
  if (!result.ok) {
    fail(`Could not create an access token: ${result.output}`);
  }
  return result.output.trim();
}

async function createOrganization(name, accessToken) {
  const response = await fetch(`${url}/api/v1/orgs`, {
    method: "POST",
    headers: {
      authorization: `token ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ username: name, visibility: "private" }),
  });
  if (response.ok || response.status === 422) {
    return;
  }
  fail(`Could not create the organization ${name}: HTTP ${response.status}`);
}

function report(created) {
  if (asJson) {
    console.log(
      JSON.stringify({ url, username, organization, ...created }, null, 2)
    );
    return;
  }
  console.log(`Local Git is ready at ${url}`);
  if (created.password) {
    console.log(
      `  Sign in as ${username} with the password ${created.password} (shown once; change it in Local Git → Settings).`
    );
  } else {
    console.log(`  Sign in as ${username}.`);
  }
  if (!created.token) {
    return;
  }
  console.log(
    "\nAdd the connection in AgentFlow: Settings → Integrations → Connections → Local Git"
  );
  console.log(`  Server URL    ${url}`);
  console.log(
    `  Runner URL    ${url.replace("localhost", "host.docker.internal")}  (runners in Docker on this machine; empty when runners reach the server URL)`
  );
  console.log(`  Access token  ${created.token}`);
  console.log(
    `  Owner         ${organization ?? "(empty: new repositories go to this account)"}`
  );
}

function gitea(giteaArgs) {
  const result = spawnSync(
    "docker",
    ["compose", "exec", "-T", "-u", "git", "local-git", "gitea", ...giteaArgs],
    { cwd: root, encoding: "utf8" }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

function readOption(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readDotEnv(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const line of text.split(LINE_BREAK)) {
    const match = ENV_LINE.exec(line);
    if (match && !line.trimStart().startsWith("#")) {
      values[match[1]] = match[2].replace(SURROUNDING_QUOTES, "$2");
    }
  }
  return values;
}
