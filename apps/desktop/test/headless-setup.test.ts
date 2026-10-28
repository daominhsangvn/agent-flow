import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HeadlessRunnerEnv, RunnerMode } from "../src/headless/headless-env.js";
import {
  type Ask,
  applyRunnerConfig,
  askRunnerMode,
  askRunnerSettings,
  defaultRunnerName,
  defaultWorkspaceDir,
  needsSetup,
  readRunnerConfigFile,
  renderRunnerConfig,
  runnerConfigFile,
  type SetupAnswers,
  writeRunnerConfigFile,
} from "../src/headless/headless-setup.js";

const API_URL = "https://agentflow.example.test";
const API_KEY = "sk_live_abcdefghijkl";
const HOME = path.resolve("/home/dev");

function scriptedAsk(answers: string[]): {
  ask: Ask;
  questions: { question: string; shownDefault?: string }[];
} {
  const questions: { question: string; shownDefault?: string }[] = [];
  const ask: Ask = (question, shownDefault) => {
    questions.push({ question, shownDefault });
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error(`unexpected question: ${question}`);
    }
    return Promise.resolve(answer);
  };
  return { ask, questions };
}

function answers(overrides: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    [HeadlessRunnerEnv.ApiUrl]: API_URL,
    [HeadlessRunnerEnv.ApiKey]: API_KEY,
    [HeadlessRunnerEnv.RunnerName]: "dev-box",
    [HeadlessRunnerEnv.Workspace]: path.join(HOME, ".agentflow", "_works"),
    ...overrides,
  };
}

test("defaultRunnerName turns an account name into a runner name", () => {
  assert.equal(defaultRunnerName("Nguyễn Văn An"), "Nguyen-Van-An");
  assert.equal(defaultRunnerName("Đặng Thị Đào"), "Dang-Thi-Dao");
  assert.equal(defaultRunnerName("john.doe@corp"), "john-doe-corp");
  assert.equal(defaultRunnerName("  dev  box  "), "dev-box");
  assert.equal(defaultRunnerName("__build__01__"), "build-01");
  assert.equal(defaultRunnerName("   "), "runner");
  assert.equal(defaultRunnerName("運用"), "runner");
});

test("defaultWorkspaceDir is .agentflow/_works under the home directory", () => {
  assert.equal(
    defaultWorkspaceDir(HOME),
    path.join(HOME, ".agentflow", "_works")
  );
});

test("askRunnerSettings offers the account name and workspace as defaults", async () => {
  const { ask, questions } = scriptedAsk([API_URL, API_KEY, "", "", ""]);
  const result = await askRunnerSettings({
    ask,
    say: () => undefined,
    current: {},
    username: "Nguyễn Văn An",
    homeDir: HOME,
  });
  assert.deepEqual(result, {
    [HeadlessRunnerEnv.ApiUrl]: API_URL,
    [HeadlessRunnerEnv.ApiKey]: API_KEY,
    [HeadlessRunnerEnv.RunnerName]: "Nguyen-Van-An",
    [HeadlessRunnerEnv.Workspace]: path.join(HOME, ".agentflow", "_works"),
    [HeadlessRunnerEnv.GatewayPort]: "",
  });
  assert.equal(questions[4]?.shownDefault, "random");
  assert.equal(questions[2]?.shownDefault, "Nguyen-Van-An");
  assert.equal(
    questions[3]?.shownDefault,
    path.join(HOME, ".agentflow", "_works")
  );
});

test("askRunnerSettings asks again until an answer is valid", async () => {
  const said: string[] = [];
  const { ask } = scriptedAsk([
    "",
    "not a url",
    `${API_URL}/some/path`,
    "pk_wrong",
    API_KEY,
    "build-01",
    "~/work",
    "80",
    "50001",
  ]);
  const result = await askRunnerSettings({
    ask,
    say: (line) => said.push(line),
    current: {},
    username: "dev",
    homeDir: HOME,
  });
  assert.equal(result[HeadlessRunnerEnv.ApiUrl], API_URL);
  assert.equal(result[HeadlessRunnerEnv.ApiKey], API_KEY);
  assert.equal(result[HeadlessRunnerEnv.RunnerName], "build-01");
  assert.equal(result[HeadlessRunnerEnv.Workspace], path.join(HOME, "work"));
  assert.equal(result[HeadlessRunnerEnv.GatewayPort], "50001");
  assert.equal(said.length, 5);
});

test("askRunnerSettings keeps current values on Enter and masks the key", async () => {
  const { ask, questions } = scriptedAsk(["", "", "", "", ""]);
  const current = answers({
    [HeadlessRunnerEnv.RunnerName]: "kept-name",
    [HeadlessRunnerEnv.GatewayPort]: "50002",
  });
  const result = await askRunnerSettings({
    ask,
    say: () => undefined,
    current,
    username: "dev",
    homeDir: HOME,
  });
  assert.deepEqual(result, current);
  assert.equal(questions[1]?.shownDefault, "sk_live_…ijkl");
  assert.equal(questions[4]?.shownDefault, "50002");
});

test("askRunnerSettings refuses plain http to a remote host", async () => {
  const said: string[] = [];
  const { ask } = scriptedAsk([
    "http://agentflow.example.test",
    "http://localhost:3002",
    API_KEY,
    "",
    "",
    "",
  ]);
  const result = await askRunnerSettings({
    ask,
    say: (line) => said.push(line),
    current: {},
    username: "dev",
    homeDir: HOME,
  });
  assert.equal(result[HeadlessRunnerEnv.ApiUrl], "http://localhost:3002");
  assert.equal(said.length, 2);
});

test("renderRunnerConfig replaces settings and keeps everything else", () => {
  const existing = [
    "# my notes",
    `${HeadlessRunnerEnv.ApiUrl}=https://old.example.test`,
    "CLAUDE_CODE_OAUTH_TOKEN=token",
    "",
  ].join("\n");
  assert.equal(
    renderRunnerConfig(existing, answers()),
    [
      "# my notes",
      `${HeadlessRunnerEnv.ApiUrl}=${API_URL}`,
      "CLAUDE_CODE_OAUTH_TOKEN=token",
      `${HeadlessRunnerEnv.ApiKey}=${API_KEY}`,
      `${HeadlessRunnerEnv.RunnerName}=dev-box`,
      `${HeadlessRunnerEnv.Workspace}=${path.join(HOME, ".agentflow", "_works")}`,
      "",
    ].join("\n")
  );
});

test("the config file round-trips Windows paths and other variables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-setup-"));
  try {
    const file = runnerConfigFile(dir);
    assert.deepEqual(readRunnerConfigFile(file), {});

    const windowsWorkspace = String.raw`C:\Users\Dev\.agentflow\_works`;
    writeRunnerConfigFile(
      file,
      answers({ [HeadlessRunnerEnv.Workspace]: windowsWorkspace })
    );
    fs.appendFileSync(
      file,
      "ConnectionStrings__Default=Server=localhost;Database=App_Agent\n"
    );
    const values = readRunnerConfigFile(file);
    assert.equal(values[HeadlessRunnerEnv.Workspace], windowsWorkspace);
    assert.equal(values[HeadlessRunnerEnv.ApiKey], API_KEY);
    assert.equal(
      values.ConnectionStrings__Default,
      "Server=localhost;Database=App_Agent"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyRunnerConfig never overrides the environment", () => {
  const env: NodeJS.ProcessEnv = {
    [HeadlessRunnerEnv.ApiUrl]: "https://env.example.test",
    [HeadlessRunnerEnv.RunnerName]: " ",
  };
  applyRunnerConfig(env, answers());
  assert.equal(env[HeadlessRunnerEnv.ApiUrl], "https://env.example.test");
  assert.equal(env[HeadlessRunnerEnv.RunnerName], "dev-box");
  assert.equal(env[HeadlessRunnerEnv.ApiKey], API_KEY);
});

test("needsSetup is true until the API URL and key are set", () => {
  assert.equal(needsSetup({}), true);
  assert.equal(needsSetup({ [HeadlessRunnerEnv.ApiUrl]: API_URL }), true);
  assert.equal(
    needsSetup({
      [HeadlessRunnerEnv.ApiUrl]: API_URL,
      [HeadlessRunnerEnv.ApiKey]: API_KEY,
    }),
    false
  );
});

test("askRunnerMode defaults to auto and accepts personal", async () => {
  const context = (answers: string[], current = {}) => ({
    ask: scriptedAsk(answers).ask,
    say: () => undefined,
    current,
    username: "dev",
    homeDir: HOME,
  });
  assert.equal(await askRunnerMode(context([""])), RunnerMode.Auto);
  assert.equal(await askRunnerMode(context(["P"])), RunnerMode.Personal);
  assert.equal(
    await askRunnerMode(
      context([""], { [HeadlessRunnerEnv.Mode]: RunnerMode.Personal })
    ),
    RunnerMode.Personal
  );
});

test("askRunnerSettings in personal mode asks for the project instead of a workspace", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-setup-"));
  try {
    const said: string[] = [];
    const { ask, questions } = scriptedAsk([
      API_URL,
      API_KEY,
      "pro-1",
      path.join(projectDir, "missing"),
      projectDir,
      "maybe",
      "",
      "yes",
      "",
      "",
    ]);
    const result = await askRunnerSettings(
      {
        ask,
        say: (line) => said.push(line),
        current: {},
        username: "Nguyễn Văn An",
        homeDir: HOME,
      },
      RunnerMode.Personal
    );
    assert.deepEqual(result, {
      [HeadlessRunnerEnv.Mode]: RunnerMode.Personal,
      [HeadlessRunnerEnv.ApiUrl]: API_URL,
      [HeadlessRunnerEnv.ApiKey]: API_KEY,
      [HeadlessRunnerEnv.RunnerName]: "Nguyen-Van-An-PRO-1",
      [HeadlessRunnerEnv.ProjectKey]: "PRO-1",
      [HeadlessRunnerEnv.ProjectDir]: projectDir,
      [HeadlessRunnerEnv.Parallel]: "false",
      [HeadlessRunnerEnv.SkipPermissions]: "true",
      [HeadlessRunnerEnv.GatewayPort]: "",
    });
    assert.equal(said.length, 3);
    assert.ok(
      !questions.some((question) => question.question.includes("Workspace"))
    );
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
