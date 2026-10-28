/**
 * @file headless-runner.ts
 * @description Composition of the headless runner: the same three pieces the
 * Electron main process wires together, without Electron.
 *
 *   AgentFlow API --socket--> CloudSocketService --> CloudCommandExecutor
 *     --HTTP (loopback, gateway token)--> DesktopGatewayServer --> operations
 *
 * The runner registers as a compute target under the owner of its API key,
 * executes only the operations in HEADLESS_RUNNER_OPERATION_IDS, and runs
 * loops exactly as the desktop does (src/server/operations/symphony-loop.ts).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GatewayIdentityStore } from "../main/auth/gateway-identity.js";
import { CloudCommandExecutor } from "../main/cloud/cloud-command-executor.js";
import type {
  CloudSocketStatus,
  DesktopCommandEvent,
  DesktopHelloAckEvent,
} from "../main/cloud/cloud-protocol.js";
import { CloudSocketService } from "../main/cloud/cloud-socket.js";
import { JobStore } from "../main/jobs/job-store.js";
import { reconcileJobStoreOnBoot } from "../main/jobs/job-store-boot-reconciliation.js";
import { BootRecoveryService } from "../main/lifecycle/boot-recovery.js";
import { gatewayLog } from "../main/logging/gateway-logger.js";
import { prepareLoopCommandForExecution } from "../main/loop/loop-command-preparer.js";
import { LoopSchedulerContext } from "../main/loop/loop-scheduler-context.js";
import { LoopTokenStore } from "../main/loop/loop-token-store.js";
import {
  getBundledPluginDirs,
  getBundledPluginVersion,
} from "../server/operations/bundled-plugins.js";
import { excludePersonalProjectFiles } from "../server/operations/personal-runner.js";
import { getCodePluginVersion } from "../server/operations/plugin-cache.js";
import { computeSymphonyDir } from "../server/operations/symphony-utils.js";
import type {
  GatewayApprovalRequest,
  GatewayApprovalResult,
} from "../server/router.js";
import { DesktopGatewayServer } from "../server/server.js";
import { BUILD_APP_VERSION } from "../shared/build-info.js";
import { CloudSocketState } from "../shared/cloud-socket-error.js";
import {
  type ComputeTargetCapabilities,
  GATEWAY_PROTOCOL_VERSION,
} from "../shared/contracts.js";
import { startHeadlessCapabilitiesReporter } from "./headless-capabilities-reporter.js";
import {
  classifyHeadlessCommand,
  HEADLESS_RUNNER_OPERATION_IDS,
  rewriteLoopCallbackUrl,
} from "./headless-commands.js";
import type { HeadlessRunnerConfig } from "./headless-config.js";
import { createRunnerModelProviderLookup } from "./headless-model-provider.js";
import { createHeadlessSafeStorage } from "./headless-safe-storage.js";
import { startHeadlessSessionReporter } from "./headless-session-reporter.js";
import {
  type RunnerStatus,
  STATUS_REFRESH_INTERVAL_MS,
  writeRunnerStatus,
} from "./headless-status.js";
import { createHeadlessTranscriptUploader } from "./headless-transcript-uploader.js";
import { ensureRunnerWorktreeSettings } from "./headless-workspace.js";

const LOG_TAG = "headless-runner";
const LOOPBACK_HOST = "127.0.0.1";
const ANY_FREE_PORT = 0;
const GATEWAY_PORT_FILE = "gateway-port";
const GATEWAY_TOKEN_BYTES = 32;
const FORBIDDEN_STATUS = 403;
/** Gateway operations keep repos.json in <symphony dir>/config. */
const REPOS_CONFIG_SUBDIR = "config";
/** How long stop() waits for an in-flight finalization replay. */
const RECOVERY_QUIESCE_TIMEOUT_MS = 10_000;

export type HeadlessRunner = {
  stop(): Promise<void>;
  getStatus(): RunnerStatus;
};

export async function startHeadlessRunner(
  config: HeadlessRunnerConfig,
  capabilities: ComputeTargetCapabilities
): Promise<HeadlessRunner> {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const gatewayId = new GatewayIdentityStore(config.dataDir).loadSync();
  const gatewayAuthToken = randomBytes(GATEWAY_TOKEN_BYTES).toString("hex");
  const allowedDirectories = [config.workspaceDir];
  const loopTokenStore = new LoopTokenStore({
    cwd: config.dataDir,
    safeStorage: createHeadlessSafeStorage(config.dataDir),
  });
  const jobStore = new JobStore({ cwd: config.dataDir });
  // Loops whose agent process died with the runner (restart, upgrade, a
  // crash) are finalized from what they left on disk, like the desktop app
  // does on boot. A loop whose finalization could not reach AgentFlow (API
  // down) is replayed the same way when the runner reconnects.
  const deadJobs = reconcileJobStoreOnBoot(jobStore);
  const schedulers = new LoopSchedulerContext();
  const recovery = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => undefined },
    getApiKey: () => config.apiKey,
    getApiOrigin: () => config.apiUrl,
    getAllowedDirectories: () => [config.workspaceDir],
    loopTokenStore,
    schedulers,
  });
  const replayPendingFinalizations = (jobs: typeof deadJobs) => {
    recovery.startDeadJobFinalization(jobs).catch((error: unknown) => {
      gatewayLog.warn(
        LOG_TAG,
        `Loop finalization replay failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  };
  const symphonyDir = computeSymphonyDir(config.workspaceDir);
  if (config.personal) {
    // The runner's settings live in the project folder's `.agentflow-ai/`:
    // keep it out of the person's `git status` from the start.
    await excludePersonalProjectFiles(config.workspaceDir);
  }
  await ensureRunnerWorktreeSettings(
    path.join(symphonyDir, REPOS_CONFIG_SUBDIR),
    config.workspaceDir
  );

  let status: RunnerStatus = {
    state: CloudSocketState.Idle,
    computeTargetId: null,
    error: null,
    activeCommands: 0,
    queueDepth: 0,
    updatedAt: new Date().toISOString(),
  };
  const publishStatus = (patch: Partial<RunnerStatus>) => {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
    writeRunnerStatus(config.dataDir, status);
  };

  const server = new DesktopGatewayServer({
    host: LOOPBACK_HOST,
    // The configured port, or any free one: runners never compete for a
    // default port, however many share the computer.
    preferredPort: config.gatewayPort ?? ANY_FREE_PORT,
    fallbackPorts: [],
    webAppOrigin: config.webAppUrl,
    // In the runner's own data directory: the default file under the home
    // directory is shared by the desktop app and every runner of the account.
    discoveryFilePath: path.join(config.dataDir, GATEWAY_PORT_FILE),
    getGatewayAuthToken: () => gatewayAuthToken,
    getAllowedDirectories: () => allowedDirectories,
    getSymphonyDir: () => symphonyDir,
    evaluateApproval: approveRunnerRequest,
    machineName: config.runnerName,
    version: BUILD_APP_VERSION,
    capabilities,
    getApiKey: () => config.apiKey,
    getApiOrigin: () => config.apiUrl,
    jobStore,
    loopTokenStore,
    schedulers,
    getGatewayId: () => gatewayId,
    getComputeTargetId: () => status.computeTargetId,
    // Built from the repository (the image or `package:headless`), never a
    // desktop release: its version is reported as a local build instead of
    // being compared with the desktop release manifest.
    isPackagedBuild: () => false,
    systemCheckHost: {
      headlessRunner: true,
      getAgentFlowModelProvider: createRunnerModelProviderLookup({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        getComputeTargetId: () => status.computeTargetId,
      }),
    },
  });

  // The executor and the socket reference each other through callbacks.
  let cloudSocket: CloudSocketService | null = null;
  const executor = new CloudCommandExecutor({
    getGatewayPort: () => server.getActivePort(),
    getGatewayAuthToken: () => gatewayAuthToken,
    maxInFlightCommands: config.maxConcurrentCommands,
    sendCommandAck: (event) => cloudSocket?.sendCommandAck(event),
    sendCommandEvent: (event) => cloudSocket?.sendCommandEvent(event),
    prepareCommandForExecution: (command) =>
      prepareRunnerCommand(command, config, () => status.computeTargetId),
    onQueueStatsChange: (stats) => {
      publishStatus(stats);
      if (status.state === CloudSocketState.Online) {
        cloudSocket?.sendPresence({ state: CloudSocketState.Online, ...stats });
      }
    },
  });

  const socket = new CloudSocketService({
    getRelayOrigin: () => config.apiUrl,
    getApiKey: () => config.apiKey,
    getApiKeyProvenance: () => "USER_CREATED",
    getAllowedDirectories: () => allowedDirectories,
    getCapabilities: () => ({
      ...capabilities,
      loopRunnerRefreshSupported: true,
      loopRunnerHeartbeatSupported: true,
      loopStepForkSession: true,
      toolkitCapabilitiesRefresh: true,
      headlessRunner: true,
      ...(config.personal
        ? {
            personalRunner: {
              projectKey: config.personal.projectKey,
              parallel: config.personal.parallel,
            },
          }
        : {}),
    }),
    getMaxInFlightCommands: () => config.maxConcurrentCommands,
    getGatewayId: () => gatewayId,
    machineName: config.runnerName,
    pluginVersion: getBundledPluginVersion("code") ?? getCodePluginVersion(),
    desktopClientVersion: BUILD_APP_VERSION,
    gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
    getEnabledOperations: () => [...HEADLESS_RUNNER_OPERATION_IDS],
    onStatusChange: (next) => {
      handleStatusChange(next, executor, publishStatus);
      if (next.state === CloudSocketState.Online) {
        socket.sendPresence({
          state: CloudSocketState.Online,
          ...executor.getStats(),
        });
      }
    },
    onHelloAck: (event: DesktopHelloAckEvent) => {
      publishStatus({ computeTargetId: event.computeTargetId });
      // Connected (again): AgentFlow gets the runner's AGENTFLOW.md as it is now.
      capabilitiesReporter?.report({ force: true }).catch(() => undefined);
      // AgentFlow is reachable again: finish the loops it could not be told about.
      replayPendingFinalizations([]);
      if (event.resumeFromSequence) {
        executor.replayFrom(event.resumeFromSequence);
      }
    },
    onCommand: (command) => {
      const decision = classifyHeadlessCommand(command.path);
      if (!decision.accepted) {
        gatewayLog.warn(
          LOG_TAG,
          `Rejected command ${command.commandId} (${command.operationId} ${command.path}): ${decision.reason}`
        );
        socket.sendCommandAck({
          commandId: command.commandId,
          accepted: false,
          state: "failed",
          reason: decision.reason,
        });
        return;
      }
      executor.enqueue(command);
    },
    onCancel: (event) => executor.cancel(event),
    onCommandEventAck: (event) => executor.acknowledge(event),
    onDisconnect: (reason) =>
      gatewayLog.warn(LOG_TAG, `Disconnected from AgentFlow: ${reason}`),
  });
  cloudSocket = socket;
  // What this runner can do for its project, for the project's orchestrator.
  const capabilitiesReporter = config.personal
    ? startHeadlessCapabilitiesReporter({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        projectKey: config.personal.projectKey,
        projectDir: config.personal.projectDir,
        getComputeTargetId: () => status.computeTargetId,
      })
    : null;
  // Loops as agent sessions and the runner's agent components, for the
  // Sessions and Agents pages (the desktop app reports its own the same way).
  const sessionReporter = config.reportSessions
    ? startHeadlessSessionReporter({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        runnerName: config.runnerName,
        jobStore,
        getComputeTargetId: () =>
          status.state === CloudSocketState.Online
            ? status.computeTargetId
            : null,
        getPluginDirs: getBundledPluginDirs,
        uploadTranscripts: createHeadlessTranscriptUploader({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
        }).upload,
      })
    : null;

  await server.start();
  replayPendingFinalizations(deadJobs);
  recovery.reattachLiveJobs().catch((error: unknown) => {
    gatewayLog.warn(
      LOG_TAG,
      `Live loop reattach failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  publishStatus({});
  const refreshTimer = setInterval(
    () => publishStatus({}),
    STATUS_REFRESH_INTERVAL_MS
  );
  refreshTimer.unref();
  await socket.start();
  gatewayLog.info(
    LOG_TAG,
    `Runner "${config.runnerName}" started: gateway on ${LOOPBACK_HOST}:${server.getActivePort()}, connecting to ${config.apiUrl}`
  );

  return {
    getStatus: () => status,
    async stop() {
      clearInterval(refreshTimer);
      sessionReporter?.stop();
      capabilitiesReporter?.stop();
      const stats = executor.getStats();
      if (stats.activeCommands > 0) {
        gatewayLog.warn(
          LOG_TAG,
          `Stopping with ${stats.activeCommands} running command(s); their loops will time out in AgentFlow`
        );
      }
      socket.stop();
      executor.dispose();
      await recovery.quiesce(RECOVERY_QUIESCE_TIMEOUT_MS);
      await server.stop();
      // Clears the loop heartbeat/refresh timers shared with the server.
      recovery[Symbol.dispose]();
      publishStatus({ state: CloudSocketState.Idle, error: "stopped" });
    },
  };
}

/** Second gate inside the gateway, in case a request bypasses onCommand. */
function approveRunnerRequest(
  request: GatewayApprovalRequest
): GatewayApprovalResult {
  const decision = classifyHeadlessCommand(request.path);
  if (decision.accepted) {
    return { allow: true };
  }
  return {
    allow: false,
    statusCode: FORBIDDEN_STATUS,
    payload: { error: decision.reason },
  };
}

async function prepareRunnerCommand(
  command: DesktopCommandEvent,
  config: HeadlessRunnerConfig,
  getComputeTargetId: () => string | null
): Promise<DesktopCommandEvent> {
  // Browser-signed launches need a desktop-managed key; the shared preparer
  // fails them with its standard error instead of running them unsigned.
  const prepared = await prepareLoopCommandForExecution(command, {
    getApiOrigin: () => config.apiUrl,
    getApiKey: () => config.apiKey,
    getApiKeyProvenance: () => "USER_CREATED",
    getManagedPopSigningReadiness: () => ({
      provenance: "USER_CREATED",
      signingReady: false,
      reason: "user_created_key",
    }),
    getComputeTargetId,
  });
  return config.rewriteCallbackUrl
    ? rewriteLoopCallbackUrl(prepared, config.apiUrl)
    : prepared;
}

function handleStatusChange(
  next: CloudSocketStatus,
  executor: CloudCommandExecutor,
  publishStatus: (patch: Partial<RunnerStatus>) => void
): void {
  if (next.state === CloudSocketState.Online) {
    executor.setConnected(true);
    publishStatus({
      state: next.state,
      computeTargetId: next.targetId,
      error: null,
    });
    gatewayLog.info(LOG_TAG, `Online as compute target ${next.targetId}`);
    return;
  }
  executor.setConnected(false);
  const error = next.state === CloudSocketState.Degraded ? next.error : null;
  publishStatus({ state: next.state, error });
  if (error) {
    gatewayLog.warn(LOG_TAG, `Connection degraded: ${error}`);
  }
}
