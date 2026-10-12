/**
 * @file electron-store.ts
 * @description Node-only stand-in for `electron-store`, aliased in by the
 * headless runner bundle (scripts/build-headless-runner.mjs). The stores the
 * runner reuses from the desktop (JobStore, LoopTokenStore) only need a small
 * synchronous key/value API persisted as JSON, which this provides without
 * Electron's `app.getPath`.
 *
 * Files live in `options.cwd`, or the runner data directory
 * (`AGENTFLOW_RUNNER_DATA_DIR`), and are written atomically with mode 0600.
 * Keys are top-level property names; dot paths are not interpreted, which
 * matches how the reused stores address their data.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveRunnerDataDir } from "../headless-env.js";

export type StoreOptions<T extends Record<string, unknown>> = {
  name?: string;
  cwd?: string;
  defaults?: Partial<T>;
  fileExtension?: string;
};

const DEFAULT_STORE_NAME = "config";
const FILE_MODE = 0o600;

export default class Store<T extends Record<string, unknown>> {
  readonly path: string;
  private data: Record<string, unknown>;

  constructor(options: StoreOptions<T> = {}) {
    const directory = options.cwd ?? resolveRunnerDataDir();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const extension = options.fileExtension ?? "json";
    this.path = path.join(
      directory,
      `${options.name ?? DEFAULT_STORE_NAME}.${extension}`
    );
    this.data = { ...options.defaults, ...readStoreFile(this.path) };
  }

  get store(): T {
    return { ...this.data } as T;
  }

  set store(value: T) {
    this.data = { ...value };
    this.persist();
  }

  get<K extends keyof T>(key: K, defaultValue?: T[K]): T[K] {
    const value = this.data[key as string];
    return (value === undefined ? defaultValue : value) as T[K];
  }

  set<K extends keyof T>(key: K | Partial<T>, value?: T[K]): void {
    if (typeof key === "object" && key !== null) {
      Object.assign(this.data, key);
    } else {
      this.data[key as string] = value;
    }
    this.persist();
  }

  has(key: keyof T): boolean {
    return Object.hasOwn(this.data, key as string);
  }

  delete(key: keyof T): void {
    delete this.data[key as string];
    this.persist();
  }

  clear(): void {
    this.data = {};
    this.persist();
  }

  private persist(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), {
      mode: FILE_MODE,
    });
    fs.renameSync(temporary, this.path);
  }
}

function readStoreFile(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A corrupt file must not stop the runner; keep a copy for diagnosis.
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    return {};
  }
}
