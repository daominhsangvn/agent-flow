import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { LoopCommand } from "@agentflow-ai/loops-api/commands";
import {
  closeLoopWorkspace,
  loopWorkspaceDirFor,
  openLoopWorkspace,
  writeLoopWorkspaceInstructions,
} from "../src/server/operations/loop-workspace.js";

let root: string;
/** A checkout as loop-repo-checkout.ts lays it out: <workspace>/<host>/<owner>__<repo>. */
const checkout = (name: string) => path.join(root, "github.com", name);

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loop-workspace-"));
  delete process.env.SYMPHONY_WORKTREE_PARENT_DIR;
});

afterEach(() => {
  closeLoopWorkspace("loop-1");
  closeLoopWorkspace("loop-2");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loop workspace", () => {
  test("puts every repository's worktree under one folder per loop key", async () => {
    const rootDir = await openLoopWorkspace({
      loopId: "loop-1",
      command: LoopCommand.Plan,
      worktreeKey: "iss-7",
      repos: [
        { fullName: "acme/shop", repoPath: checkout("acme__shop") },
        { fullName: "acme/api", repoPath: checkout("acme__api") },
        { fullName: "other/api", repoPath: checkout("other__api") },
        { fullName: "acme/.claude", repoPath: checkout("acme__claude") },
        { fullName: "acme/CLAUDE.md", repoPath: checkout("acme__claudemd") },
      ],
    });

    assert.equal(rootDir, path.join(root, "loops", "iss-7"));
    assert.ok(existsSync(rootDir ?? ""));
    // The loop's own key and its additional repositories' keys.
    assert.equal(
      loopWorkspaceDirFor(checkout("acme__shop"), "iss-7"),
      path.join(root, "loops", "iss-7", "shop")
    );
    assert.equal(
      loopWorkspaceDirFor(checkout("acme__api"), "iss-7-main-0a1b2c3d"),
      path.join(root, "loops", "iss-7", "api")
    );
    // Same name twice: the second one keeps its owner. A leading dot is
    // dropped, and a name clashing with the workspace CLAUDE.md is avoided.
    assert.equal(
      loopWorkspaceDirFor(checkout("other__api"), "iss-7-main-ffff"),
      path.join(root, "loops", "iss-7", "other__api")
    );
    assert.equal(
      loopWorkspaceDirFor(checkout("acme__claude"), "iss-7-main-eeee"),
      path.join(root, "loops", "iss-7", "claude")
    );
    assert.equal(
      loopWorkspaceDirFor(checkout("acme__claudemd"), "iss-7-main-dddd"),
      path.join(root, "loops", "iss-7", "acme__CLAUDE.md")
    );
    // Another loop key, an unknown repository, or a closed workspace: none.
    assert.equal(loopWorkspaceDirFor(checkout("acme__shop"), "iss-70"), null);
    assert.equal(loopWorkspaceDirFor(checkout("unknown"), "iss-7"), null);
    closeLoopWorkspace("loop-1");
    assert.equal(loopWorkspaceDirFor(checkout("acme__shop"), "iss-7"), null);
  });

  test("PLAN starts from a fresh work directory, EXECUTE keeps it", async () => {
    const repos = [{ fullName: "acme/shop", repoPath: checkout("acme__shop") }];
    const rootDir = path.join(root, "loops", "iss-8");
    const plan = path.join(rootDir, ".agentflow-ai", "work", "plan.json");
    mkdirSync(path.dirname(plan), { recursive: true });
    writeFileSync(plan, "{}");

    await openLoopWorkspace({
      loopId: "loop-1",
      command: LoopCommand.Execute,
      worktreeKey: "iss-8",
      repos,
    });
    assert.ok(existsSync(plan), "EXECUTE reuses the plan");

    await openLoopWorkspace({
      loopId: "loop-2",
      command: LoopCommand.Plan,
      worktreeKey: "iss-8",
      repos,
    });
    assert.equal(existsSync(plan), false, "PLAN never reuses an old plan");
  });

  test("a re-plan keeps the earlier work directory aside, once", async () => {
    const repos = [{ fullName: "acme/shop", repoPath: checkout("acme__shop") }];
    const stateDir = path.join(root, "loops", "pln-6", ".agentflow-ai");
    const plan = path.join(stateDir, "work", "plan.json");
    mkdirSync(path.dirname(plan), { recursive: true });
    writeFileSync(plan, '{"v":1}');
    const replan = {
      loopId: "loop-1",
      command: LoopCommand.Plan,
      worktreeKey: "pln-6",
      repos,
      keepPrevious: true,
    };

    await openLoopWorkspace(replan);
    const kept = path.join(stateDir, "previous-work", "plan.json");
    assert.equal(existsSync(plan), false, "the re-plan starts fresh");
    assert.equal(readFileSync(kept, "utf8"), '{"v":1}');

    // A plain PLAN never leaves an earlier plan around, kept or not.
    await openLoopWorkspace({
      ...replan,
      loopId: "loop-2",
      keepPrevious: false,
    });
    assert.equal(existsSync(kept), false);
  });

  test("writes the project instructions and the repositories to CLAUDE.md", async () => {
    const rootDir = path.join(root, "loops", "iss-9");
    const shop = path.join(rootDir, "shop");
    const api = path.join(rootDir, "api");
    mkdirSync(shop, { recursive: true });
    mkdirSync(api, { recursive: true });
    writeFileSync(path.join(shop, "CLAUDE.md"), "# shop\n");
    writeFileSync(path.join(api, "AGENTS.md"), "# api\n");

    await writeLoopWorkspaceInstructions({
      rootDir,
      instructions: "- shop: storefront\n- api: backend",
      repos: [
        { fullName: "acme/shop", dir: shop, baseBranch: "main" },
        { fullName: "acme/api", dir: api },
      ],
    });

    const content = readFileSync(path.join(rootDir, "CLAUDE.md"), "utf8");
    assert.ok(content.startsWith("# Project workspace\n"));
    assert.ok(
      content.includes("## Project instructions\n\n- shop: storefront")
    );
    assert.ok(content.includes("| `shop/` | acme/shop | `main` | CLAUDE.md |"));
    assert.ok(content.includes("| `api/` | acme/api | `main` | AGENTS.md |"));
    // Only api lacks a CLAUDE.md, so only its AGENTS.md is imported.
    assert.ok(
      content.includes(
        "## Repository instructions (AGENTS.md)\n\n@api/AGENTS.md\n"
      )
    );
    assert.equal(content.includes("@shop/"), false);

    await writeLoopWorkspaceInstructions({
      rootDir,
      instructions: "   ",
      repos: [{ dir: shop }],
    });
    const bare = readFileSync(path.join(rootDir, "CLAUDE.md"), "utf8");
    assert.equal(bare.includes("## Project instructions"), false);
    assert.ok(bare.includes("| `shop/` | shop |"));
  });
});
