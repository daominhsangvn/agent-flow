/**
 * Self-hosted servers can run without Liveblocks. The document editors must
 * then show the saved content (they used to spin forever waiting for the
 * room's Y.Doc while every room auth answered 500), and publishing an edit
 * must save a new version through the API. The status endpoint is stubbed so
 * the spec holds whatever the server under test is configured with.
 */
import type { ApiResult } from "@repo/api/src/types/common";
import {
  type DocumentDetail,
  DocumentType,
} from "@repo/api/src/types/document";
import { getApiBaseUrl } from "./helpers/api-url";
import { getSessionBearerToken } from "./helpers/better-auth";
import { createProject, deleteProject } from "./helpers/create-project";
import { createDocument, deleteDocument } from "./helpers/documents";
import { authenticateToApp } from "./helpers/sign-in";
import { E2ETag } from "./helpers/tags";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const SAVED_LINE = "Saved line from the self-hosted document spec.";
const ADDED_LINE = "Added without a collaboration room.";
const PUBLISH_RE = /^Publish$/;

test("documents render and publish without collaboration (no Liveblocks)", {
  tag: E2ETag.Smoke,
}, async ({ page, request }) => {
  await authenticateToApp(page);
  const token = await getSessionBearerToken(page);
  const api = getApiBaseUrl();

  const roomAuthCalls: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().includes("/collaboration/auth")) {
      roomAuthCalls.push(sent.url());
    }
  });
  await page.route("**/collaboration/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { enabled: false } }),
    })
  );

  const project = await createProject(request, {
    name: createUniqueName("e2e-no-collab-project"),
    token,
  });
  const prd = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Prd,
    title: createUniqueName("e2e-no-collab-prd"),
    content: SAVED_LINE,
    token,
  });

  try {
    await page.goto(`/prds/${prd.slug}`);
    const body = page.locator(".ProseMirror");
    await expect(body.getByText(SAVED_LINE)).toBeVisible({ timeout: 30_000 });

    await body.getByText(SAVED_LINE).click();
    await body.press("ControlOrMeta+End");
    await body.press("Enter");
    await body.pressSequentially(ADDED_LINE);
    await page.getByRole("button", { name: PUBLISH_RE }).click();

    await expect
      .poll(
        async () => {
          const response = await request.get(`${api}/documents/${prd.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const detail = (await response.json()) as ApiResult<DocumentDetail>;
          return detail.success
            ? {
                latestVersion: detail.data.latestVersion,
                hasAddedLine:
                  detail.data.version.content?.includes(ADDED_LINE) ?? false,
              }
            : null;
        },
        { timeout: 20_000 }
      )
      .toEqual({ latestVersion: 2, hasAddedLine: true });
    expect(roomAuthCalls).toEqual([]);
  } finally {
    await deleteDocument(request, prd.id, token);
    await deleteProject(request, project.id, token);
  }
});
