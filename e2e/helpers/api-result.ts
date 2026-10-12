import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { ApiResult } from "@repo/api/src/types/common";

/**
 * Unwraps the API's `{success, data}` envelope, throwing with the HTTP status
 * and the API's error message when the call failed.
 */
export async function readApiResult<T>(
  response: APIResponse,
  action: string
): Promise<T> {
  const body = (await response.json().catch(() => null)) as ApiResult<T> | null;
  if (body?.success) {
    return body.data;
  }
  const reason = body ? body.error : response.statusText();
  throw new Error(`${action} failed: ${response.status()} ${reason}`);
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Best-effort DELETE for test cleanup: logs instead of throwing so one failed
 * cleanup step does not mask the test's own failure or skip the others.
 */
export async function deleteQuietly(
  request: APIRequestContext,
  url: string,
  token: string
): Promise<void> {
  try {
    const response = await request.delete(url, { headers: bearer(token) });
    if (!response.ok()) {
      console.error({
        url,
        status: response.status(),
        statusText: response.statusText(),
      });
    }
  } catch {
    console.error({ url, status: 0, statusText: "request failed" });
  }
}
