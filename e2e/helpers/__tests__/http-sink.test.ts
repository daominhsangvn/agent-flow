import { afterEach, describe, expect, it } from "vitest";
import { type HttpSink, startHttpSink } from "../http-sink";

const RE_RECEIVED_SUMMARY = /1 request\(s\) received: POST \/other/;

describe("startHttpSink", () => {
  let sink: HttpSink | null = null;

  afterEach(async () => {
    await sink?.close();
    sink = null;
  });

  it("records POSTed JSON bodies", async () => {
    sink = await startHttpSink();

    const response = await fetch(`${sink.url}/events?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "run.failed" }),
    });

    expect(response.status).toBe(200);
    expect(sink.requests()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/events?x=1",
        json: { type: "run.failed" },
        rawBody: '{"type":"run.failed"}',
      }),
    ]);
  });

  it("keeps non-JSON bodies raw", async () => {
    sink = await startHttpSink();

    await fetch(sink.url, { method: "POST", body: "plain text" });

    expect(sink.requests()[0]).toMatchObject({
      json: null,
      rawBody: "plain text",
    });
  });

  it("rejects other methods without recording them", async () => {
    sink = await startHttpSink();

    const response = await fetch(sink.url);

    expect(response.status).toBe(405);
    expect(sink.requests()).toHaveLength(0);
  });

  it("waits for a matching request", async () => {
    const started = await startHttpSink();
    sink = started;

    const waiting = started.waitForRequest(
      (request) => request.path === "/late",
      { description: "the late request", timeoutMs: 5000 }
    );
    await fetch(`${started.url}/early`, { method: "POST", body: "{}" });
    await fetch(`${started.url}/late`, { method: "POST", body: "{}" });

    await expect(waiting).resolves.toMatchObject({ path: "/late" });
  });

  it("times out with the requests it did receive", async () => {
    const started = await startHttpSink();
    sink = started;
    await fetch(`${started.url}/other`, { method: "POST", body: "{}" });

    await expect(
      started.waitForRequest((request) => request.path === "/never", {
        description: "a request that never comes",
        timeoutMs: 300,
      })
    ).rejects.toThrow(RE_RECEIVED_SUMMARY);
  });
});
