import {
  test as base,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
  type TestInfo,
} from "@playwright/test";
import {
  type MeProbeResult,
  probeAuthenticatedMe,
} from "./helpers/app-bootstrap";
import {
  authUrl,
  decodeSessionClaims,
  getSessionBearerToken,
} from "./helpers/better-auth";

type ConsoleEntry = {
  location: string | null;
  text: string;
  type: string;
};

type NetworkEntry = {
  failureText?: string | null;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  url: string;
};

type PageSnapshot = {
  activeDialogText: string | null;
  activeDialogTitle: string | null;
  focusedElement: {
    ariaLabel: string | null;
    id: string | null;
    role: string | null;
    tagName: string | null;
    text: string | null;
  } | null;
  url: string;
};

type E2EDiagnostics = {
  auth: {
    appUrl: string | null;
    hasToken: boolean;
    meProbe: MeProbeResult | null;
    orgSlug: string | null;
    sessionLoaded: boolean;
    sessionStatus: number | null;
    userId: string | null;
  } | null;
  console: ConsoleEntry[];
  pageErrors: string[];
  recentApiResponses: NetworkEntry[];
  requestFailures: NetworkEntry[];
  snapshot: PageSnapshot | null;
};

const MAX_CONSOLE_ENTRIES = 20;
const MAX_NETWORK_ENTRIES = 20;
const MAX_PAGE_ERRORS = 10;
const MAX_RESPONSE_BODY_PREVIEW = 2000;

function pushBounded<T>(entries: T[], entry: T, max: number) {
  entries.push(entry);
  if (entries.length > max) {
    entries.shift();
  }
}

function formatConsoleMessage(message: ConsoleMessage): ConsoleEntry {
  const location = message.location();
  const locationText =
    location.url || location.lineNumber || location.columnNumber
      ? `${location.url}:${location.lineNumber}:${location.columnNumber}`
      : null;

  return {
    location: locationText,
    text: message.text(),
    type: message.type(),
  };
}

function formatRequestFailure(request: Request): NetworkEntry {
  return {
    failureText: request.failure()?.errorText ?? null,
    method: request.method(),
    resourceType: request.resourceType(),
    url: request.url(),
  };
}

async function formatApiResponse(response: Response): Promise<NetworkEntry> {
  const entry: NetworkEntry = {
    method: response.request().method(),
    resourceType: response.request().resourceType(),
    status: response.status(),
    statusText: response.statusText(),
    url: response.url(),
  };

  if (response.status() >= 400) {
    try {
      const body = await response.text();
      entry.failureText = body.slice(0, MAX_RESPONSE_BODY_PREVIEW);
    } catch {
      entry.failureText = "[unavailable]";
    }
  }

  return entry;
}

async function collectPageSnapshot(page: Page): Promise<PageSnapshot | null> {
  try {
    return await page.evaluate(() => {
      const focusedElement = document.activeElement as HTMLElement | null;
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const dialogTitle =
        dialog?.querySelector<HTMLElement>("[data-slot='dialog-title']")
          ?.textContent ??
        dialog?.querySelector<HTMLElement>("h1, h2, h3")?.textContent ??
        null;

      return {
        activeDialogText: dialog?.textContent?.trim() ?? null,
        activeDialogTitle: dialogTitle?.trim() ?? null,
        focusedElement: focusedElement
          ? {
              ariaLabel: focusedElement.getAttribute("aria-label"),
              id: focusedElement.id || null,
              role: focusedElement.getAttribute("role"),
              tagName: focusedElement.tagName,
              text: focusedElement.textContent?.trim() ?? null,
            }
          : null,
        url: window.location.href,
      };
    });
  } catch {
    return null;
  }
}

async function collectAuthDiagnostics(
  page: Page
): Promise<E2EDiagnostics["auth"]> {
  try {
    const sessionResponse = await page.request.get(authUrl("/get-session"));
    const sessionStatus = sessionResponse.status();
    const token = await getSessionBearerToken(page).catch(() => null);
    const claims = token ? decodeSessionClaims(token) : null;

    return {
      appUrl: page.url(),
      hasToken: Boolean(token),
      meProbe: token ? await probeAuthenticatedMe(page) : null,
      orgSlug: claims?.org_slug ?? null,
      sessionLoaded: sessionResponse.ok() && Boolean(claims),
      sessionStatus,
      userId: claims?.sub ?? null,
    };
  } catch {
    return null;
  }
}

async function attachDiagnostics(
  testInfo: TestInfo,
  diagnostics: E2EDiagnostics
): Promise<void> {
  await testInfo.attach("e2e-diagnostics", {
    body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
    contentType: "application/json",
  });
}

export const test = base.extend<{
  /** A fresh 15-minute session JWT minted from the context's Better Auth cookie. */
  apiToken: string;
  e2eDiagnostics: undefined;
}>({
  apiToken: async ({ page }, use) => {
    await use(await getSessionBearerToken(page));
  },
  e2eDiagnostics: [
    async ({ page }, use, testInfo) => {
      const consoleEntries: ConsoleEntry[] = [];
      const requestFailures: NetworkEntry[] = [];
      const recentApiResponses: NetworkEntry[] = [];
      const pageErrors: string[] = [];

      const onConsole = (message: ConsoleMessage) => {
        if (message.type() === "warning" || message.type() === "error") {
          pushBounded(
            consoleEntries,
            formatConsoleMessage(message),
            MAX_CONSOLE_ENTRIES
          );
        }
      };

      const onPageError = (error: Error) => {
        pushBounded(pageErrors, error.stack ?? error.message, MAX_PAGE_ERRORS);
      };

      const onRequestFailed = (request: Request) => {
        pushBounded(
          requestFailures,
          formatRequestFailure(request),
          MAX_NETWORK_ENTRIES
        );
      };

      const onResponse = async (response: Response) => {
        const url = response.url();
        const isApi =
          url.includes("/api/") ||
          url.includes("/teams") ||
          url.includes("/projects") ||
          url.includes("/documents") ||
          url.includes("/loops");

        if (!isApi) {
          return;
        }

        if (response.status() >= 400 || response.request().method() !== "GET") {
          pushBounded(
            recentApiResponses,
            await formatApiResponse(response),
            MAX_NETWORK_ENTRIES
          );
        }
      };

      page.on("console", onConsole);
      page.on("pageerror", onPageError);
      page.on("requestfailed", onRequestFailed);
      page.on("response", onResponse);

      try {
        await use(undefined);
      } finally {
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        page.off("requestfailed", onRequestFailed);
        page.off("response", onResponse);

        if (testInfo.status !== testInfo.expectedStatus) {
          await attachDiagnostics(testInfo, {
            auth: await collectAuthDiagnostics(page),
            console: consoleEntries,
            pageErrors,
            recentApiResponses,
            requestFailures,
            snapshot: await collectPageSnapshot(page),
          });
        }
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
