import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";

/**
 * JSON Schema of an agent tool's arguments, built from the operation's field
 * descriptors (the same fields the workflow editor offers). Fields the
 * workflow fixed (`with`) and secrets are not arguments: the agent never sees
 * or sets them.
 */

export type ToolProperty = {
  key: string;
  schema: JsonObject;
  required: boolean;
};

export function fieldProperties(
  fields: readonly IntegrationFieldDescriptor[],
  fixed: ReadonlySet<string>
): ToolProperty[] {
  return fields
    .filter(
      (field) =>
        field.kind !== IntegrationFieldKind.Secret && !fixed.has(field.key)
    )
    .map((field) => ({
      key: field.key,
      schema: fieldSchema(field),
      required: field.required === true && field.defaultValue === undefined,
    }));
}

export function objectSchema(properties: readonly ToolProperty[]): JsonObject {
  return {
    type: "object",
    properties: Object.fromEntries(
      properties.map((property) => [property.key, property.schema])
    ),
    required: properties
      .filter((property) => property.required)
      .map((property) => property.key),
    additionalProperties: false,
  };
}

/** One line per argument for a tool description: `name — label. detail`. */
export function describeProperties(
  properties: readonly ToolProperty[]
): string {
  return properties
    .map((property) => {
      const description =
        typeof property.schema.description === "string"
          ? property.schema.description
          : "";
      const required = property.required ? " (required)" : "";
      return `- ${property.key}${required}: ${description}`;
    })
    .join("\n");
}

const TEMPLATE_NOTE =
  "Write the full text; {{variables}} are not filled in. Leave it out to use the workflow's default text.";

function fieldSchema(field: IntegrationFieldDescriptor): JsonObject {
  const description = [
    `${field.label}.`,
    field.description ?? "",
    field.kind === IntegrationFieldKind.Template ? TEMPLATE_NOTE : "",
    field.placeholder ? `Example: ${field.placeholder}` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  return { ...typeSchema(field), description };
}

function typeSchema(field: IntegrationFieldDescriptor): JsonObject {
  const options: JsonValue[] = (field.options ?? []).map(
    (option) => option.value
  );
  switch (field.kind) {
    case IntegrationFieldKind.Number:
      return { type: "number" };
    case IntegrationFieldKind.Boolean:
      return { type: "boolean" };
    case IntegrationFieldKind.Select:
      return options.length > 0 ? { enum: options } : { type: "string" };
    case IntegrationFieldKind.MultiSelect:
      return {
        type: "array",
        items: options.length > 0 ? { enum: options } : { type: "string" },
      };
    case IntegrationFieldKind.StringList:
      return { type: "array", items: { type: "string" } };
    case IntegrationFieldKind.Url:
      return { type: "string", format: "uri" };
    default:
      return { type: "string" };
  }
}
