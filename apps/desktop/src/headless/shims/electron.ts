/**
 * @file electron.ts
 * @description Node-only stand-in for the `electron` module, aliased in by the
 * headless runner bundle. Only the members that desktop modules reachable from
 * the gateway touch at load or run time are provided:
 *
 * - `app`: paths resolve under the runner data directory; nothing is packaged.
 * - `shell`: there is no desktop to open files on, so it reports an error.
 * - `powerMonitor`: never emits; a server does not sleep and wake.
 * - `safeStorage`: deliberately absent. Stores that need it receive an explicit
 *   implementation from the runner composition (see headless-safe-storage.ts),
 *   so nothing silently stores secrets with a fake cipher.
 */

import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { BUILD_APP_VERSION } from "../../shared/build-info.js";
import { resolveRunnerDataDir } from "../headless-env.js";

const appEvents = new EventEmitter();

export const app = {
  isPackaged: true,
  getName: () => "AgentFlow Runner",
  getVersion: () => BUILD_APP_VERSION,
  getPath: (name: string) =>
    name === "home" ? os.homedir() : path.join(resolveRunnerDataDir(), name),
  on: (event: string, listener: (...args: unknown[]) => void) => {
    appEvents.on(event, listener);
    return app;
  },
  quit: () => undefined,
};

export const shell = {
  openPath: (target: string) =>
    Promise.resolve(
      `Cannot open ${target}: the headless runner has no desktop`
    ),
  openExternal: () => Promise.resolve(),
};

export const powerMonitor = new EventEmitter();

const electron = { app, shell, powerMonitor };

export default electron;
