import { Result } from "@repo/api/src/types/result";
import type {
  ProviderContext,
  SourceItemFile,
  SourceItemFileError,
  SourceItemFileUpload,
  SourceItemRef,
} from "../../types";
import type { AdoConnectionConfig, AdoSecrets } from "./schemas";

/**
 * Placeholder for comment attachments on Azure DevOps work items
 * (IntegrationSourceDefinition.attachFile). Not wired into the provider yet,
 * so agents of runs from Azure DevOps are not offered `attachments`.
 *
 * To implement: upload with `POST {org}/{project}/_apis/wit/attachments?fileName=...`
 * (octet-stream body), link the returned URL to the work item with a JSON
 * Patch `relations/-` of rel `AttachedFile`, return its id; then let the
 * comment action show the files (`<img src>` for images, links otherwise)
 * and set `attachFile` in provider.ts.
 */
export function attachAdoFile(
  _ctx: ProviderContext<AdoConnectionConfig, AdoSecrets>,
  _ref: SourceItemRef,
  file: SourceItemFileUpload
): Promise<Result<SourceItemFile, SourceItemFileError>> {
  return Promise.resolve(
    Result.err({
      message: `Azure DevOps comments do not take attachments yet (${file.name} was not uploaded).`,
      retryable: false,
    })
  );
}
