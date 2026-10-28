import { createHash, randomBytes } from "node:crypto";
import { ORCHESTRATOR_TOKEN_PREFIX } from "@repo/api/src/types/orchestrator";

/** A turn's tool session token (`ost_…`) and the hash the turn row keeps. */
export function mintOrchestratorToken(): { token: string; hash: string } {
  const token = `${ORCHESTRATOR_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashOrchestratorToken(token) };
}

export function hashOrchestratorToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
