import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCronHost,
  resolveSelfHostedCronJobs,
  SELF_HOSTED_CRON_INITIAL_DELAY_MS,
  type SelfHostedCronEnv,
  STALE_SESSIONS_INTERVAL_MS,
  startSelfHostedCronRunner,
  TIMEOUT_LOOPS_INTERVAL_MS,
} from "./self-hosted-cron";

const PORT = 3002;

function okResponse(status = 200): Response {
  return new Response("{}", { status });
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("startSelfHostedCronRunner", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
  });

  it("calls every cron route after the initial delay with the bearer secret", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(okResponse())
    );
    const env: SelfHostedCronEnv = { CRON_SECRET: "configured-secret" };

    stop = startSelfHostedCronRunner({
      port: PORT,
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: createLogger(),
    });
    await vi.advanceTimersByTimeAsync(SELF_HOSTED_CRON_INITIAL_DELAY_MS - 1);
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const urls = fetchImpl.mock.calls.map((call) => call[0]);
    expect(urls).toEqual([
      "http://127.0.0.1:3002/cron/workflows",
      "http://127.0.0.1:3002/cron/timeout-loops",
      "http://127.0.0.1:3002/cron/reconcile-stale-sessions",
    ]);
    const init = fetchImpl.mock.calls[0][1] ?? {};
    expect(init.headers).toEqual({ authorization: "Bearer configured-secret" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("repeats the workflow tick every WORKFLOW_TICK_SECONDS", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(okResponse())
    );

    stop = startSelfHostedCronRunner({
      port: PORT,
      env: { CRON_SECRET: "s", WORKFLOW_TICK_SECONDS: "7" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: createLogger(),
      initialDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(7000 * 3);

    const workflowCalls = fetchImpl.mock.calls.filter((call) =>
      String(call[0]).endsWith("/cron/workflows")
    );
    expect(workflowCalls).toHaveLength(4);
  });

  it("never overlaps a job with itself", async () => {
    let release: (value: Response) => void = () => undefined;
    const fetchImpl = vi.fn((url: string) =>
      url.endsWith("/cron/workflows")
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(okResponse())
    );

    stop = startSelfHostedCronRunner({
      port: PORT,
      env: { CRON_SECRET: "s" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: createLogger(),
      initialDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    const pendingCalls = () =>
      fetchImpl.mock.calls.filter((call) =>
        String(call[0]).endsWith("/cron/workflows")
      ).length;
    expect(pendingCalls()).toBe(1);

    release(okResponse());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pendingCalls()).toBe(2);
  });

  it("generates an ephemeral secret when CRON_SECRET is unset and never logs it", async () => {
    const env: SelfHostedCronEnv = { CRON_SECRET: "" };
    const logger = createLogger();
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(okResponse())
    );

    stop = startSelfHostedCronRunner({
      port: PORT,
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
      initialDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);

    const secret = env.CRON_SECRET ?? "";
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const init = fetchImpl.mock.calls[0][1] ?? {};
    expect(init.headers).toEqual({ authorization: `Bearer ${secret}` });
    const logged = [...logger.info.mock.calls, ...logger.warn.mock.calls]
      .flat()
      .join("\n");
    expect(logged).toContain("ephemeral");
    expect(logged).not.toContain(secret);
  });

  it("puts a generated secret back when the env lost it (Next.js reloads .env files)", async () => {
    const env: SelfHostedCronEnv = {
      CRON_SECRET: "",
      WORKFLOW_TICK_SECONDS: "5",
    };
    // What the cron route reads from the env when each call arrives.
    const seenByRoute: Array<string | undefined> = [];
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => {
      seenByRoute.push(env.CRON_SECRET);
      return Promise.resolve(okResponse());
    });

    stop = startSelfHostedCronRunner({
      port: PORT,
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: createLogger(),
      initialDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    const secret = env.CRON_SECRET ?? "";
    expect(secret).not.toBe("");

    // A dev-server reload resets the env to the files: CRON_SECRET="".
    env.CRON_SECRET = "";
    await vi.advanceTimersByTimeAsync(5000);

    expect(seenByRoute.at(-1)).toBe(secret);
    expect(fetchImpl.mock.calls.at(-1)?.[1]?.headers).toEqual({
      authorization: `Bearer ${secret}`,
    });
  });

  it("logs non-2xx answers and fetch errors and keeps running", async () => {
    const logger = createLogger();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse(500))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(okResponse());

    stop = startSelfHostedCronRunner({
      port: PORT,
      env: { CRON_SECRET: "s" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
      initialDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);

    const warnings = logger.warn.mock.calls.flat().join("\n");
    expect(warnings).toContain("/cron/workflows answered HTTP 500");
    expect(warnings).toContain("/cron/timeout-loops failed: ECONNREFUSED");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("does nothing when SELF_HOSTED_CRON_DISABLED is true", async () => {
    const env: SelfHostedCronEnv = { SELF_HOSTED_CRON_DISABLED: "true" };
    const fetchImpl = vi.fn();

    stop = startSelfHostedCronRunner({
      port: PORT,
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: createLogger(),
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.CRON_SECRET).toBeUndefined();
  });

  it("stops scheduling after stop()", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(okResponse())
    );

    const stopRunner = startSelfHostedCronRunner({
      port: PORT,
      env: { CRON_SECRET: "s" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: createLogger(),
    });
    stopRunner();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("resolveSelfHostedCronJobs", () => {
  it("defaults the workflow tick to 10 s and floors it at 5 s", () => {
    expect(resolveSelfHostedCronJobs({})).toEqual([
      { path: "/cron/workflows", intervalMs: 10_000 },
      { path: "/cron/timeout-loops", intervalMs: TIMEOUT_LOOPS_INTERVAL_MS },
      {
        path: "/cron/reconcile-stale-sessions",
        intervalMs: STALE_SESSIONS_INTERVAL_MS,
      },
    ]);
    expect(
      resolveSelfHostedCronJobs({ WORKFLOW_TICK_SECONDS: "1" })[0].intervalMs
    ).toBe(5000);
    expect(
      resolveSelfHostedCronJobs({ WORKFLOW_TICK_SECONDS: "abc" })[0].intervalMs
    ).toBe(10_000);
  });
});

describe("resolveCronHost", () => {
  it("maps wildcard addresses to loopback and brackets IPv6", () => {
    expect(resolveCronHost("0.0.0.0")).toBe("127.0.0.1");
    expect(resolveCronHost("::")).toBe("127.0.0.1");
    expect(resolveCronHost(undefined)).toBe("127.0.0.1");
    expect(resolveCronHost("localhost")).toBe("localhost");
    expect(resolveCronHost("::1")).toBe("[::1]");
  });
});
