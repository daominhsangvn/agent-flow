import { describe, expect, it, vi } from "vitest";
import { createProviderHttp, isRetryableStatus } from "@/lib/integrations/http";

const URL_UNDER_TEST = "https://example.test/rest/api/3/myself";
const TIMEOUT_ERROR_RE = /timeout|abort/i;

type FetchCall = [string, RequestInit];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fetchReturning(response: Response) {
  return vi.fn<typeof fetch>(() => Promise.resolve(response));
}

function headersOf(fetchMock: ReturnType<typeof fetchReturning>) {
  const [, init] = fetchMock.mock.calls[0] as FetchCall;
  return init.headers as Record<string, string>;
}

describe("createProviderHttp", () => {
  it("sends object bodies as JSON and parses JSON responses", async () => {
    const fetchMock = fetchReturning(jsonResponse({ accountId: "bot-1" }));
    const http = createProviderHttp(fetchMock);

    const response = await http.request({
      method: "POST",
      url: URL_UNDER_TEST,
      headers: { authorization: "Basic abc" },
      body: { hello: "world" },
    });

    expect(response).toMatchObject({
      ok: true,
      status: 200,
      json: { accountId: "bot-1" },
      error: null,
      retryable: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as FetchCall;
    expect(url).toBe(URL_UNDER_TEST);
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"hello":"world"}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(headersOf(fetchMock)).toEqual({
      accept: "application/json",
      authorization: "Basic abc",
      "content-type": "application/json",
    });
  });

  it("keeps an explicit content type whatever its case", async () => {
    const fetchMock = fetchReturning(jsonResponse({}));

    await createProviderHttp(fetchMock).request({
      method: "PUT",
      url: URL_UNDER_TEST,
      headers: { "Content-Type": "application/json-patch+json" },
      body: [{ op: "add", path: "/fields/System.Tags", value: "x" }],
    });

    expect(headersOf(fetchMock)).toEqual({
      accept: "application/json",
      "Content-Type": "application/json-patch+json",
    });
  });

  it("sends string bodies as-is without a content type", async () => {
    const fetchMock = fetchReturning(new Response("ok", { status: 200 }));

    const response = await createProviderHttp(fetchMock).request({
      method: "POST",
      url: URL_UNDER_TEST,
      body: "plain text",
    });

    const [, init] = fetchMock.mock.calls[0] as FetchCall;
    expect(init.body).toBe("plain text");
    expect(headersOf(fetchMock)).toEqual({ accept: "application/json" });
    expect(response.text).toBe("ok");
    expect(response.json).toBeUndefined();
  });

  it("sends no body for a request without one", async () => {
    const fetchMock = fetchReturning(jsonResponse({}));

    await createProviderHttp(fetchMock).request({
      method: "GET",
      url: URL_UNDER_TEST,
    });

    const [, init] = fetchMock.mock.calls[0] as FetchCall;
    expect(init.body).toBeUndefined();
  });

  it("leaves json undefined for non-JSON or unparseable bodies", async () => {
    const html = await createProviderHttp(
      fetchReturning(
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      )
    ).request({ method: "GET", url: URL_UNDER_TEST });
    const broken = await createProviderHttp(
      fetchReturning(
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    ).request({ method: "GET", url: URL_UNDER_TEST });

    expect(html.json).toBeUndefined();
    expect(broken).toMatchObject({
      ok: true,
      json: undefined,
      text: "{not json",
    });
  });

  it.each([
    [400, false],
    [401, false],
    [404, false],
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [503, true],
  ])("classifies HTTP %i as retryable=%s", async (status, retryable) => {
    const response = await createProviderHttp(
      fetchReturning(jsonResponse({ errorMessages: ["nope"] }, status))
    ).request({ method: "GET", url: URL_UNDER_TEST });

    expect(response).toMatchObject({
      ok: false,
      status,
      error: `HTTP ${status}`,
      retryable,
      json: { errorMessages: ["nope"] },
    });
  });

  it("never throws: transport errors come back as status 0 and retryable", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError("fetch failed"))
    );

    const response = await createProviderHttp(fetchMock).request({
      method: "GET",
      url: URL_UNDER_TEST,
    });

    expect(response).toMatchObject({
      ok: false,
      status: 0,
      text: "",
      json: undefined,
      error: "fetch failed",
      retryable: true,
    });
    expect(response.headers).toBeInstanceOf(Headers);
  });

  it("aborts after the timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason)
          );
        })
    );

    const response = await createProviderHttp(fetchMock).request({
      method: "GET",
      url: URL_UNDER_TEST,
      timeoutMs: 5,
    });

    expect(response).toMatchObject({ ok: false, status: 0, retryable: true });
    expect(response.error).toMatch(TIMEOUT_ERROR_RE);
  });

  it("caps very large response bodies", async () => {
    const response = await createProviderHttp(
      fetchReturning(new Response("x".repeat(2_100_000), { status: 200 }))
    ).request({ method: "GET", url: URL_UNDER_TEST });

    expect(response.text).toHaveLength(2_000_000);
  });
});

describe("isRetryableStatus", () => {
  it("retries throttling, timeouts and server errors only", () => {
    expect([408, 425, 429, 500, 502, 599].every(isRetryableStatus)).toBe(true);
    expect([200, 301, 400, 403, 404, 409, 422].some(isRetryableStatus)).toBe(
      false
    );
  });
});
