import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { scheduleLogFlush } from "@/lib/route-utils";
import type { InboundConnection } from "./handlers/inbound-delivery-handler";

/**
 * Terminal handling of an integration webhook request: the one structured
 * outcome log, the log flush, and a generic response body (internal details
 * never leave the server).
 */

/** Route-level outcomes besides the ingest outcomes (accepted, ignored, duplicate). */
export const IngressOutcome = {
  UnknownInboundKey: "unknown_inbound_key",
  Ignored: "ignored",
  PayloadTooLarge: "payload_too_large",
  Unauthorized: "unauthorized",
  Error: "error",
} as const;
export type IngressOutcome =
  (typeof IngressOutcome)[keyof typeof IngressOutcome];

export type IngressCompletion = {
  status: number;
  outcome: string;
  connection?: InboundConnection;
  fields?: Record<string, unknown>;
};

const LOG_MESSAGE = "[webhook/integrations] Completed webhook handling";

const GENERIC_MESSAGES = new Map<number, string>([
  [400, "Invalid payload"],
  [401, "Unauthorized"],
  [404, "Not found"],
  [413, "Payload too large"],
  [500, "Something went wrong"],
]);

export function completeIngress(entry: IngressCompletion): Response {
  const meta = {
    outcome: entry.outcome,
    status: entry.status,
    connectionId: entry.connection?.record.id ?? null,
    organizationId: entry.connection?.record.organizationId ?? null,
    provider: entry.connection?.record.provider ?? null,
    ...entry.fields,
  };
  if (entry.status >= 500) {
    log.error(LOG_MESSAGE, meta);
  } else if (entry.status >= 400) {
    log.warn(LOG_MESSAGE, meta);
  } else {
    log.info(LOG_MESSAGE, meta);
  }
  scheduleLogFlush();
  return NextResponse.json(responseBody(entry.status), {
    status: entry.status,
  });
}

function responseBody(status: number): { ok: boolean; message?: string } {
  if (status < 300) {
    return { ok: true };
  }
  return {
    ok: false,
    message: GENERIC_MESSAGES.get(status) ?? "Something went wrong",
  };
}
