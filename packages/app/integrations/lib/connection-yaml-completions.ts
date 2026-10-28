import {
  INTEGRATION_POLL_INTERVAL_DEFAULT_SECONDS,
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import {
  filterYamlCompletions,
  type YamlCompletion,
  YamlCompletionKind,
  type YamlCompletionResult,
} from "@repo/app/shared/lib/yaml-completion";
import {
  analyzeYamlCursor,
  type YamlCursor,
  YamlCursorKind,
} from "@repo/app/shared/lib/yaml-cursor";
import { stringify } from "yaml";
import {
  CONNECTION_YAML_KEYS,
  type ConnectionYamlContext,
  ConnectionYamlKey,
  getYamlSettingFields,
} from "./connection-yaml";
import {
  DELIVERY_MODE_DESCRIPTIONS,
  DELIVERY_MODE_LABELS,
  getSelectableDeliveryModes,
} from "./integration-labels";

/**
 * Suggestions of the connection YAML editor: what fits where the cursor is —
 * the keys of the mapping, the provider's settings (with their labels and
 * descriptions), the allowed values of a setting, and the inbound modes the
 * provider supports. Secrets are never suggested: they are typed in the
 * fields under the editor. Pure, so the editor only adapts them to its popup.
 */
export function connectionYamlCompletions(
  text: string,
  pos: number,
  context: ConnectionYamlContext
): YamlCompletionResult | null {
  const cursor = analyzeYamlCursor(text, pos, {
    isScalarList: (path, key) =>
      path.join("/") === ConnectionYamlKey.Config &&
      isListField(settingField(context, key)),
  });
  if (!cursor || cursor.kind === YamlCursorKind.Variable) {
    return null;
  }
  return {
    from: cursor.from,
    options: filterYamlCompletions(candidates(cursor, context), cursor.typed),
    variable: false,
  };
}

const KEY_DOCS: Record<string, { detail: string; info: string }> = {
  [ConnectionYamlKey.Name]: {
    detail: "text",
    info: "How the connection is listed; workflows name it in connection:.",
  },
  [ConnectionYamlKey.Enabled]: {
    detail: "true | false",
    info: "A disabled connection ignores inbound events and skips its pre and post actions.",
  },
  [ConnectionYamlKey.Config]: {
    detail: "mapping",
    info: "The provider's settings; Ctrl+Space lists them. Secrets go in the fields under the editor.",
  },
  [ConnectionYamlKey.Inbound]: {
    detail: "mapping",
    info: "How events of the source system reach AgentFlow: mode and, for poll, pollIntervalSeconds.",
  },
  [ConnectionYamlKey.Mode]: {
    detail: "webhook | poll | none",
    info: "webhook: the source system calls a public HTTPS URL. poll: AgentFlow asks it on an interval (no public URL needed). none: actions only.",
  },
  [ConnectionYamlKey.PollIntervalSeconds]: {
    detail: "seconds",
    info: "How often poll mode asks the source system for changes (60 to 3600).",
  },
};

function candidates(
  cursor: YamlCursor,
  context: ConnectionYamlContext
): YamlCompletion[] {
  const where = cursor.path.join("/");
  if (cursor.kind === YamlCursorKind.Item) {
    return (settingField(context, cursor.key ?? "")?.options ?? []).map(
      (option) => value(option.value, option.label)
    );
  }
  if (cursor.kind === YamlCursorKind.Value) {
    return valueCandidates(where, cursor.key ?? "", context);
  }
  return keyCandidates(where, cursor, context);
}

function keyCandidates(
  where: string,
  cursor: YamlCursor,
  context: ConnectionYamlContext
): YamlCompletion[] {
  const fresh = (key: string) => !cursor.existingKeys.includes(key);
  if (where === "") {
    return CONNECTION_YAML_KEYS.connection
      .filter((key) => context.isEdit || key !== ConnectionYamlKey.Enabled)
      .filter(fresh)
      .map(keyCompletion);
  }
  if (where === ConnectionYamlKey.Inbound) {
    return CONNECTION_YAML_KEYS.inbound.filter(fresh).map(keyCompletion);
  }
  if (where === ConnectionYamlKey.Config) {
    return getYamlSettingFields(context.provider)
      .filter((field) => fresh(field.key))
      .map(settingKeyCompletion);
  }
  return [];
}

function valueCandidates(
  where: string,
  key: string,
  context: ConnectionYamlContext
): YamlCompletion[] {
  if (where === "" && key === ConnectionYamlKey.Enabled) {
    return booleanValues();
  }
  if (where === ConnectionYamlKey.Inbound) {
    if (key === ConnectionYamlKey.Mode) {
      return getSelectableDeliveryModes(context.provider).map((mode) => ({
        ...value(mode, DELIVERY_MODE_DESCRIPTIONS[mode]),
        detail: DELIVERY_MODE_LABELS[mode],
      }));
    }
    if (key === ConnectionYamlKey.PollIntervalSeconds) {
      return [
        value(
          String(INTEGRATION_POLL_INTERVAL_DEFAULT_SECONDS),
          "The default interval"
        ),
      ];
    }
    return [];
  }
  if (where === ConnectionYamlKey.Config) {
    const field = settingField(context, key);
    return field ? settingValues(field) : [];
  }
  return [];
}

function settingValues(field: IntegrationFieldDescriptor): YamlCompletion[] {
  if (field.kind === IntegrationFieldKind.Boolean) {
    return booleanValues();
  }
  if (field.options && field.options.length > 0) {
    return field.options.map((option) =>
      value(yamlScalar(option.value), option.label)
    );
  }
  return field.placeholder
    ? [{ ...value(yamlScalar(field.placeholder), "Example"), detail: "e.g." }]
    : [];
}

function settingKeyCompletion(
  field: IntegrationFieldDescriptor
): YamlCompletion {
  return {
    label: field.key,
    insert: isListField(field) ? `${field.key}:\n  - ` : `${field.key}: `,
    kind: YamlCompletionKind.Key,
    detail: `${field.label}${field.required ? " (required)" : ""}`,
    info: field.description,
  };
}

function keyCompletion(key: string): YamlCompletion {
  const doc = KEY_DOCS[key];
  const isMapping =
    key === ConnectionYamlKey.Config || key === ConnectionYamlKey.Inbound;
  return {
    label: key,
    insert: isMapping ? `${key}:\n  ` : `${key}: `,
    kind: YamlCompletionKind.Key,
    detail: doc?.detail,
    info: doc?.info,
  };
}

function settingField(
  context: ConnectionYamlContext,
  key: string
): IntegrationFieldDescriptor | undefined {
  return getYamlSettingFields(context.provider).find(
    (field) => field.key === key
  );
}

function isListField(field: IntegrationFieldDescriptor | undefined): boolean {
  return (
    field?.kind === IntegrationFieldKind.MultiSelect ||
    field?.kind === IntegrationFieldKind.StringList
  );
}

function booleanValues(): YamlCompletion[] {
  return [value("true", "Yes"), value("false", "No")];
}

function value(label: string, info: string): YamlCompletion {
  return { label, insert: label, kind: YamlCompletionKind.Value, info };
}

/** `text` as a YAML scalar: quoted only when it has to be. */
function yamlScalar(text: string): string {
  return stringify(text, { lineWidth: 0 }).trim();
}
