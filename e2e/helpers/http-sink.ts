import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { pollUntil } from "./poll";

/**
 * A throwaway local HTTP endpoint that records the requests it receives, for
 * asserting on server-side outbound calls (workflow post actions) that
 * page.route cannot intercept. Listens on 127.0.0.1 on a random port.
 */

export type SinkRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  json: unknown;
  receivedAt: Date;
};

export type HttpSink = {
  /** Base URL of the sink, e.g. http://127.0.0.1:53211 (no trailing slash). */
  url: string;
  requests(): readonly SinkRequest[];
  waitForRequest(
    predicate: (request: SinkRequest) => boolean,
    options: { description: string; timeoutMs: number }
  ): Promise<SinkRequest>;
  close(): Promise<void>;
};

const SINK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;
const HttpStatus = {
  Ok: 200,
  MethodNotAllowed: 405,
  PayloadTooLarge: 413,
} as const;

export async function startHttpSink(): Promise<HttpSink> {
  const received: SinkRequest[] = [];
  const server = createServer((request, response) => {
    handleRequest(request, response, received).catch(() => {
      if (!response.headersSent) {
        response.statusCode = HttpStatus.PayloadTooLarge;
      }
      response.end();
    });
  });

  const port = await listen(server);

  return {
    url: `http://${SINK_HOST}:${port}`,
    requests: () => [...received],
    waitForRequest: (predicate, { description, timeoutMs }) =>
      pollUntil(() => Promise.resolve(received.find(predicate) ?? null), {
        description,
        timeoutMs,
        describeLastAttempt: () =>
          `${received.length} request(s) received: ${received
            .map((entry) => `${entry.method} ${entry.path}`)
            .join(", ")}`,
      }),
    close: () => closeServer(server),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  received: SinkRequest[]
): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(HttpStatus.MethodNotAllowed).end();
    return;
  }
  const rawBody = await readBody(request);
  received.push({
    method: request.method,
    path: request.url ?? "/",
    headers: request.headers,
    rawBody,
    json: parseJson(rawBody),
    receivedAt: new Date(),
  });
  response
    .writeHead(HttpStatus.Ok, { "content-type": "application/json" })
    .end(JSON.stringify({ ok: true }));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Sink request body exceeds 1 MB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(rawBody: string): unknown {
  if (!rawBody) {
    return null;
  }
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, SINK_HOST, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}
