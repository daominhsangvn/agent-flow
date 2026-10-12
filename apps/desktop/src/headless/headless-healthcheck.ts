/**
 * @file headless-healthcheck.ts
 * @description Container healthcheck for the headless runner
 * (`dist-headless/healthcheck.mjs`). Exits 0 when the runner is connected to
 * AgentFlow and keeps refreshing its status file, 1 otherwise.
 */

import { resolveRunnerDataDir } from "./headless-env.js";
import { evaluateRunnerHealth, readRunnerStatus } from "./headless-status.js";

const verdict = evaluateRunnerHealth(
  readRunnerStatus(resolveRunnerDataDir()),
  new Date()
);
process.stdout.write(
  `${verdict.healthy ? "healthy" : "unhealthy"}: ${verdict.reason}\n`
);
process.exitCode = verdict.healthy ? 0 : 1;
