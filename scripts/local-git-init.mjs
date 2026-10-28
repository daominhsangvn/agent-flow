// Prepares Local Git (the `local-git` service of docker-compose.yml, Gitea):
// creates its admin account, optionally an organization, and an access token,
// and writes the token and addresses into apps/api/.env.local
// (LOCAL_GIT_SERVER_URL, LOCAL_GIT_RUNNER_URL, LOCAL_GIT_TOKEN and, with
// --org, LOCAL_GIT_OWNER). After a restart the API provides the "Local Git"
// connection to every organization: nobody adds it in Settings. Idempotent:
// an existing account and organization are kept; every run issues a new
// token (revoke old ones in Local Git → Settings → Applications).
//
//   pnpm local-git:init                     # account + token, written to the API env
//   pnpm local-git:init --org my-team       # also an organization (the owner)
//   pnpm local-git:init --no-env            # print the values, write nothing
//   pnpm local-git:init --no-token          # account only
//   pnpm local-git:init --json              # machine-readable output
//
// Reads LOCAL_GIT_URL / LOCAL_GIT_PORT and LOCAL_GIT_ADMIN_USER /
// LOCAL_GIT_ADMIN_PASSWORD / LOCAL_GIT_ADMIN_EMAIL from the environment or the
// `.env` next to docker-compose.yml. Without a password one is generated and
// printed once.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const LINE_BREAK = /\r?\n/;
const ENV_LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/;
const SURROUNDING_QUOTES = /^(["'])(.*)\1$/;
const TRAILING_SLASHES = /\/+$/;
const TRAILING_NEWLINES = /\n+$/;
const TOKEN_SCOPES =
  "write:repository,write:organization,write:user,write:issue";
const HEALTH_TIMEOUT_MS = 60_000;

const root = path.resolve(import.meta.dirname, "..");
const apiEnvFile = path.join(root, "apps", "api", ".env.local");
const env = { ...readDotEnv(path.join(root, ".env")), ...process.env };
const args = process.argv.slice(2);

const url = (
  env.LOCAL_GIT_URL ?? `http://localhost:${env.LOCAL_GIT_PORT ?? "3300"}`
).replace(TRAILING_SLASHES, "");
const username = env.LOCAL_GIT_ADMIN_USER ?? "agentflow";
const email = env.LOCAL_GIT_ADMIN_EMAIL ?? `${username}@local-git.invalid`;
const organization = readOption("--org");
const wantsToken = !args.includes("--no-token");
const writesEnv = !args.includes("--no-env");
const asJson = args.includes("--json");
// Runners in Docker on this machine reach the host's published port here.
const runnerUrl = url.replace("localhost", "host.docker.internal");

await waitForHealth();
const password = createAdmin();
const token = wantsToken ? createToken() : null;
if (organization && token) {
  await createOrganization(organization, token);
}
const envWritten = token && writesEnv ? writeApiEnv(token) : false;
report({ password, token, envWritten });

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
  if (created.envWritten) {
    console.log(
      `\nWrote LOCAL_GIT_SERVER_URL, LOCAL_GIT_RUNNER_URL, LOCAL_GIT_TOKEN${organization ? " and LOCAL_GIT_OWNER" : ""} to ${path.relative(root, apiEnvFile)}.`
    );
    console.log(
      "Restart the API: every organization then has the Local Git connection (Settings → Connections); nobody adds it."
    );
    console.log(
      `  Runner URL is ${runnerUrl} (runners in Docker on this machine); change LOCAL_GIT_RUNNER_URL when runners reach Local Git elsewhere.`
    );
    return;
  }
  console.log(
    `\nSet these in ${path.relative(root, apiEnvFile)} and restart the API, so every organization has the Local Git connection:`
  );
  console.log(`  LOCAL_GIT_SERVER_URL="${url}"`);
  console.log(
    `  LOCAL_GIT_RUNNER_URL="${runnerUrl}"  (runners in Docker on this machine; empty when runners reach the server URL)`
  );
  console.log(`  LOCAL_GIT_TOKEN="${created.token}"`);
  console.log(
    `  LOCAL_GIT_OWNER="${organization ?? ""}"  (empty: new repositories go to this account)`
  );
}

/**
 * Sets the LOCAL_GIT_* keys of the API's .env.local (replacing their lines,
 * or appending them); false when the file does not exist yet.
 */
function writeApiEnv(accessToken) {
  let text;
  try {
    text = readFileSync(apiEnvFile, "utf8");
  } catch {
    return false;
  }
  const values = {
    LOCAL_GIT_SERVER_URL: url,
    LOCAL_GIT_RUNNER_URL: runnerUrl,
    LOCAL_GIT_TOKEN: accessToken,
  };
  if (organization) {
    values.LOCAL_GIT_OWNER = organization;
  }
  const lines = text.split(LINE_BREAK);
  const missing = [];
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}="${value}"`;
    const index = lines.findIndex(
      (candidate) => ENV_LINE.exec(candidate)?.[1] === key
    );
    if (index === -1) {
      missing.push(line);
    } else {
      lines[index] = line;
    }
  }
  if (missing.length > 0) {
    while (lines.length > 0 && lines.at(-1) === "") {
      lines.pop();
    }
    lines.push(
      "",
      "# Local Git (docker-compose `local-git`): the API gives every organization",
      "# its connection. Written by `pnpm local-git:init`.",
      ...missing
    );
  }
  writeFileSync(
    apiEnvFile,
    `${lines.join("\n").replace(TRAILING_NEWLINES, "")}\n`
  );
  return true;
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
