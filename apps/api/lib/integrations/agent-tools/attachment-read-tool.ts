import {
  IntegrationToolAccess,
  IntegrationToolName,
} from "@repo/api/src/types/integration-tools";
import { Result } from "@repo/api/src/types/result";
import { getIntegrationProvider } from "../registry";
import {
  type AgentTool,
  type AgentToolSessionInput,
  cap,
  READ_ANNOTATIONS,
} from "./catalog";
import {
  describeProperties,
  objectSchema,
  type ToolProperty,
} from "./field-schema";

/**
 * `source_item_attachment_read`: the text of one file attached to the run's
 * source item, by its name. A read of the source item, so every session has
 * it without a grant, when the source provider reads attachments
 * (IntegrationSourceDefinition.readAttachment). Which file to read and what
 * it is (the PRD, notes) is the instruction's to say; the API downloads it
 * with the connection's credentials, which the computer never holds.
 */

const NAME_MAX = 255;

export function sourceAttachmentReadTools(
  input: AgentToolSessionInput
): AgentTool[] {
  const provider = input.source.provider;
  return provider && getIntegrationProvider(provider)?.source?.readAttachment
    ? [attachmentReadTool()]
    : [];
}

function attachmentReadTool(): AgentTool {
  const properties: ToolProperty[] = [
    {
      key: "name",
      schema: {
        type: "string",
        maxLength: NAME_MAX,
        description:
          'The file name exactly as source_item_get lists it (case-insensitive). Example: "PRD-LD-1.md".',
      },
      required: true,
    },
  ];
  return {
    name: IntegrationToolName.SourceItemAttachmentRead,
    title: "Read a file attached to the run's source item",
    description: cap([
      "Read the text of one file attached to the item this run started from (a PRD, a spec, notes, a log).",
      `Use when: the instruction or the item points at an attached file; ${IntegrationToolName.SourceItemGet} lists the item's attachments with their names.`,
      "Do not use for: images or other binary files (refused), files of any other item, or downloading the attachment link yourself (the computer has no credentials).",
      "Only text files up to 1 MB are read.",
      `Input:\n${describeProperties(properties)}`,
      "Returns: the file's name, content type, size and text.",
    ]),
    inputSchema: objectSchema(properties),
    annotations: READ_ANNOTATIONS,
    access: IntegrationToolAccess.Read,
    operationType: null,
    plan: (args) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (name === "" || name.length > NAME_MAX) {
        return Result.err(
          "name must be the attachment's file name as source_item_get lists it."
        );
      }
      return Result.ok({ kind: "read_source_attachment", name });
    },
  };
}
