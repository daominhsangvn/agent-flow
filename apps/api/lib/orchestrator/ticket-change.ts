import type { JsonValue } from "@repo/api/src/types/common";
import { OrchestratorTicketChange } from "@repo/api/src/types/orchestrator";
import { z } from "zod";
import type { InboundItemChange } from "@/lib/integrations/types";

/**
 * The one place where a change of the ticket itself (its status, its labels)
 * becomes an orchestrator message: its kind, its text and its payload. The
 * kinds are the values of agent.orchestrator.cancelOn (docs/orchestrator.md).
 */

const NONE = "(none)";

export type TicketChangeMessage = {
  kind: OrchestratorTicketChange;
  text: string;
  payload: Record<string, JsonValue>;
};

export const ticketChangePayloadSchema = z.looseObject({
  from: z.string().nullish(),
  to: z.string().nullish(),
  added: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  actor: z.string().nullish(),
});

export type TicketChangePayload = z.infer<typeof ticketChangePayloadSchema>;

/** The message for an item change, or null when it holds no change. */
export function ticketChangeMessage(
  change: InboundItemChange,
  actor: string | null
): TicketChangeMessage | null {
  const by = actor ? ` (by ${actor})` : "";
  if (change.status) {
    const { from, to } = change.status;
    return {
      kind: OrchestratorTicketChange.StatusChanged,
      text: `Status changed: ${from ?? NONE} → ${to ?? NONE}${by}`,
      payload: { from, to, actor },
    };
  }
  if (change.labels) {
    const { added, removed } = change.labels;
    const lines: string[] = [];
    if (added.length > 0) {
      lines.push(`Label added: ${added.join(", ")}`);
    }
    if (removed.length > 0) {
      lines.push(`Label removed: ${removed.join(", ")}`);
    }
    if (lines.length === 0) {
      return null;
    }
    return {
      kind:
        removed.length > 0
          ? OrchestratorTicketChange.LabelRemoved
          : OrchestratorTicketChange.LabelAdded,
      text: lines.map((line) => `${line}${by}`).join("\n"),
      payload: { added, removed, actor },
    };
  }
  return null;
}

/** Reads the stored payload of a ticket-change message; null when it has another shape. */
export function readTicketChange(payload: unknown): TicketChangePayload | null {
  const parsed = ticketChangePayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function isTicketChangeKind(
  kind: string
): kind is OrchestratorTicketChange {
  return Object.values<string>(OrchestratorTicketChange).includes(kind);
}
