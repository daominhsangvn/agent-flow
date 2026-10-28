import {
  INTEGRATION_NAME_MAX,
  INTEGRATION_POLL_INTERVAL_DEFAULT_SECONDS,
  INTEGRATION_POLL_INTERVAL_MAX_SECONDS,
  INTEGRATION_POLL_INTERVAL_MIN_SECONDS,
  type IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import {
  unknownYamlKeyProblems,
  type YamlProblem,
  YamlProblemSeverity,
  yamlErrorMessage,
  yamlKeyRange,
  yamlNodeRange,
  yamlProblemAt,
} from "@repo/app/shared/lib/yaml-problems";
import { type Document, LineCounter, parseDocument, stringify } from "yaml";
import { z } from "zod";
import {
  buildFieldValues,
  type IntegrationFieldValues,
  isFieldVisible,
  validateFieldValues,
} from "./integration-field-values";
import {
  DELIVERY_MODE_LABELS,
  getDefaultDeliveryMode,
  getSelectableDeliveryModes,
} from "./integration-labels";
import { checkFieldValue } from "./integration-yaml-fields";

/**
 * A connection written as YAML: its name, the provider's settings and how
 * inbound events arrive, checked as you type against the provider's field
 * descriptors. Secrets (API tokens, personal access tokens, webhook URLs)
 * never go in the YAML: they are typed into the password fields under the
 * editor and are never shown again.
 *
 * ```yaml
 * name: Acme Jira
 * enabled: true                # existing connections only
 * config:
 *   deployment: cloud
 *   siteUrl: https://acme.atlassian.net
 *   email: agentflow-bot@acme.com
 * inbound:
 *   mode: webhook              # webhook | poll | none
 *   pollIntervalSeconds: 120   # poll only
 * ```
 */

export const ConnectionYamlKey = {
  Name: "name",
  Enabled: "enabled",
  Config: "config",
  Inbound: "inbound",
  Mode: "mode",
  PollIntervalSeconds: "pollIntervalSeconds",
} as const;
export type ConnectionYamlKey =
  (typeof ConnectionYamlKey)[keyof typeof ConnectionYamlKey];

/** Keys of each mapping, in the order generated YAML writes them. */
export const CONNECTION_YAML_KEYS = {
  connection: [
    ConnectionYamlKey.Name,
    ConnectionYamlKey.Enabled,
    ConnectionYamlKey.Config,
    ConnectionYamlKey.Inbound,
  ],
  inbound: [ConnectionYamlKey.Mode, ConnectionYamlKey.PollIntervalSeconds],
} as const;

export type ConnectionYamlContext = {
  provider: IntegrationProviderSummary;
  /** An existing connection is edited (`enabled` only applies then). */
  isEdit: boolean;
};

/** What the YAML describes, ready for the create and update requests. */
export type ConnectionYamlValue = {
  name: string;
  enabled: boolean;
  /** Non-secret settings, as the field form would hold them. */
  config: IntegrationFieldValues;
  deliveryMode: IntegrationDeliveryMode;
  pollIntervalSeconds: number;
};

export type ConnectionYamlResult = {
  /** Every problem: syntax, then shape, then the provider's settings. */
  problems: YamlProblem[];
  /** The connection, when the YAML has no error (warnings allowed). */
  value: ConnectionYamlValue | null;
  /**
   * The settings as far as they read, even with problems in them (null when
   * the YAML does not parse): what the secret fields are judged against.
   */
  settings: IntegrationFieldValues | null;
};

export const POLL_INTERVAL_ERROR = `Write a whole number of seconds between ${INTEGRATION_POLL_INTERVAL_MIN_SECONDS} and ${INTEGRATION_POLL_INTERVAL_MAX_SECONDS}`;

export function parseConnectionYaml(
  text: string,
  context: ConnectionYamlContext
): ConnectionYamlResult {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      problems: document.errors.map((error) =>
        yamlProblemAt(
          lineCounter,
          error.pos[0],
          error.pos[1],
          yamlErrorMessage(error.message),
          YamlProblemSeverity.Error
        )
      ),
      value: null,
      settings: null,
    };
  }
  const plain = toPlainValue(document);
  const problems: YamlProblem[] = [];
  const report = (
    path: readonly PropertyKey[],
    message: string,
    severity: YamlProblemSeverity = YamlProblemSeverity.Error
  ) => {
    const [from, to] = yamlNodeRange(document, path, text);
    problems.push(yamlProblemAt(lineCounter, from, to, message, severity));
  };
  const reportKey = (
    path: readonly PropertyKey[],
    key: string,
    message: string,
    severity: YamlProblemSeverity
  ) => {
    const range = yamlKeyRange(document, path, key);
    if (range) {
      problems.push(
        yamlProblemAt(lineCounter, range[0], range[1], message, severity)
      );
    } else {
      report([...path, key], message, severity);
    }
  };
  const parsed = connectionYamlSchema.safeParse(plain);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      report(issue.path.map(toPathKey), issue.message);
    }
  }
  // The settings are checked even when another part has a problem, so a
  // save attempt lists everything at once.
  const config = settingsMappingOf(plain);
  const settings = config
    ? resolveSettings(config, context.provider, { report, reportKey })
    : null;
  const resolved =
    parsed.success && settings
      ? resolveConnection(parsed.data, settings, context, {
          report,
          reportKey,
        })
      : null;
  problems.push(...unknownKeyProblems(document, lineCounter, context));
  const sorted = [...problems].sort((a, b) => a.from - b.from);
  const hasError = sorted.some(
    (problem) => problem.severity === YamlProblemSeverity.Error
  );
  return {
    problems: sorted,
    value: hasError ? null : resolved,
    settings,
  };
}

/** Every problem of the YAML (what the editor underlines). */
export function connectionYamlProblems(
  text: string,
  context: ConnectionYamlContext
): YamlProblem[] {
  return parseConnectionYaml(text, context).problems;
}

/**
 * The YAML of a connection: its stored settings, or for a new one the
 * provider's defaults with an empty value for every required setting. Each
 * setting carries a comment with its label and allowed values.
 */
export function connectionToYaml(
  provider: IntegrationProviderSummary,
  connection?: IntegrationConnection
): string {
  const values = buildFieldValues(
    provider.connectionFields,
    connection?.config
  );
  const settings = provider.connectionFields.filter(
    (field) =>
      !isSecretField(field) &&
      isFieldVisible(field, values, provider.connectionFields)
  );
  const lines = [...headerLines(provider)];
  lines.push(
    `${ConnectionYamlKey.Name}: ${yamlScalar(connection?.name ?? provider.displayName)}`
  );
  if (connection) {
    lines.push(
      `${ConnectionYamlKey.Enabled}: ${connection.status !== IntegrationConnectionStatus.Disabled}`
    );
  }
  if (settings.length === 0) {
    lines.push(`${ConnectionYamlKey.Config}: {}`);
  } else {
    lines.push(`${ConnectionYamlKey.Config}:`);
    for (const field of settings) {
      const value = yamlValue(values[field.key], "  ");
      lines.push(
        `  # ${settingComment(field)}`,
        value ? `  ${field.key}: ${value}` : `  ${field.key}:`
      );
    }
  }
  const modes = getSelectableDeliveryModes(provider);
  if (modes.length > 1) {
    lines.push(
      `${ConnectionYamlKey.Inbound}:`,
      `  # ${modes.map((mode) => `${mode} (${DELIVERY_MODE_LABELS[mode]})`).join(" | ")}`,
      `  ${ConnectionYamlKey.Mode}: ${connection?.deliveryMode ?? getDefaultDeliveryMode(provider)}`
    );
    if (modes.includes(IntegrationDeliveryMode.Poll)) {
      lines.push(
        `  ${ConnectionYamlKey.PollIntervalSeconds}: ${connection?.pollIntervalSeconds ?? INTEGRATION_POLL_INTERVAL_DEFAULT_SECONDS}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The provider's settings that may be written in the YAML (every non-secret field). */
export function getYamlSettingFields(
  provider: IntegrationProviderSummary
): IntegrationFieldDescriptor[] {
  return provider.connectionFields.filter((field) => !isSecretField(field));
}

/** The provider's secrets, typed in the fields under the editor. */
export function getSecretSettingFields(
  provider: IntegrationProviderSummary
): IntegrationFieldDescriptor[] {
  return provider.connectionFields.filter(isSecretField);
}

/** The problem of a secret written in the YAML: where to type it instead. */
export function secretInYamlMessage(field: IntegrationFieldDescriptor): string {
  return `${field.key} is a secret: type it in the "${field.label}" field under the editor. Secrets are never written in the YAML.`;
}

type Reporters = {
  report: (
    path: readonly PropertyKey[],
    message: string,
    severity?: YamlProblemSeverity
  ) => void;
  reportKey: (
    path: readonly PropertyKey[],
    key: string,
    message: string,
    severity: YamlProblemSeverity
  ) => void;
};

function requiredText(message: string, max: number) {
  return z
    .string({
      error: (issue) => (issue.input === undefined ? message : "Write text"),
    })
    .trim()
    .min(1, message)
    .max(max);
}

const connectionYamlSchema = z.object(
  {
    name: requiredText("Name the connection", INTEGRATION_NAME_MAX),
    enabled: z.boolean({ error: "enabled is true or false" }).default(true),
    // `config:` left empty parses as null: no settings.
    config: z
      .record(z.string(), z.unknown(), {
        error: "Write the settings as a mapping of setting: value",
      })
      .nullish()
      .transform((config) => config ?? {}),
    inbound: z
      .object(
        {
          mode: z
            .enum(IntegrationDeliveryMode, {
              error: `Write one of: ${Object.values(IntegrationDeliveryMode).join(", ")}`,
            })
            .optional(),
          pollIntervalSeconds: z
            .number({ error: POLL_INTERVAL_ERROR })
            .int(POLL_INTERVAL_ERROR)
            .min(INTEGRATION_POLL_INTERVAL_MIN_SECONDS, POLL_INTERVAL_ERROR)
            .max(INTEGRATION_POLL_INTERVAL_MAX_SECONDS, POLL_INTERVAL_ERROR)
            .optional(),
        },
        { error: "Write inbound as a mapping: mode, pollIntervalSeconds" }
      )
      .nullish(),
  },
  { error: "Write the connection as a mapping: name, config, inbound" }
);

type ConnectionYaml = z.infer<typeof connectionYamlSchema>;

function resolveConnection(
  yaml: ConnectionYaml,
  settings: IntegrationFieldValues,
  context: ConnectionYamlContext,
  reporters: Reporters
): ConnectionYamlValue {
  const { provider } = context;
  const modes = getSelectableDeliveryModes(provider);
  const deliveryMode = yaml.inbound?.mode ?? getDefaultDeliveryMode(provider);
  if (!modes.includes(deliveryMode)) {
    reporters.report(
      [ConnectionYamlKey.Inbound, ConnectionYamlKey.Mode],
      `${provider.displayName} does not receive events by ${deliveryMode}. Modes: ${modes.join(", ")}`
    );
  }
  if (!context.isEdit && yaml.enabled === false) {
    reporters.reportKey(
      [],
      ConnectionYamlKey.Enabled,
      "A new connection starts enabled: disable it after creating it",
      YamlProblemSeverity.Warning
    );
  }
  return {
    name: yaml.name,
    enabled: yaml.enabled,
    config: settings,
    deliveryMode,
    pollIntervalSeconds:
      yaml.inbound?.pollIntervalSeconds ??
      INTEGRATION_POLL_INTERVAL_DEFAULT_SECONDS,
  };
}

/**
 * The settings as field values, after checking each against its descriptor:
 * the value kind, the provider's rules (required, URL, email, options),
 * secrets written in the YAML, and settings that do not apply (unknown, or
 * hidden by another setting) as warnings.
 */
function resolveSettings(
  config: Record<string, unknown>,
  provider: IntegrationProviderSummary,
  reporters: Reporters
): IntegrationFieldValues {
  const path = [ConnectionYamlKey.Config];
  const fields = provider.connectionFields;
  const values: IntegrationFieldValues = {};
  for (const [key, value] of Object.entries(config)) {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) {
      reporters.reportKey(
        path,
        key,
        `Unknown setting "${key}". Settings: ${getYamlSettingFields(provider)
          .map((item) => item.key)
          .join(", ")}`,
        YamlProblemSeverity.Warning
      );
      continue;
    }
    if (isSecretField(field)) {
      reporters.reportKey(
        path,
        key,
        secretInYamlMessage(field),
        YamlProblemSeverity.Error
      );
      continue;
    }
    const checked = checkFieldValue(field, value);
    if (checked.ok) {
      values[key] = checked.value;
    } else {
      reporters.report([...path, key], checked.message);
    }
  }
  const settingFields = getYamlSettingFields(provider);
  const formValues = buildFieldValues(settingFields, values);
  for (const key of Object.keys(values)) {
    const field = settingFields.find((candidate) => candidate.key === key);
    if (field && !isFieldVisible(field, formValues, fields)) {
      reporters.reportKey(
        path,
        key,
        `${key} is not used: it only applies when ${describeCondition(field)}`,
        YamlProblemSeverity.Warning
      );
    }
  }
  const errors = validateFieldValues(settingFields, formValues);
  for (const [key, message] of Object.entries(errors)) {
    const label = fields.find((field) => field.key === key)?.label ?? key;
    if (Object.hasOwn(values, key)) {
      reporters.report([...path, key], message);
    } else {
      // A missing setting is marked on `config:` (or the root, without one).
      reporters.reportKey(
        [],
        ConnectionYamlKey.Config,
        `Add the setting ${key} (${label}): ${message}`,
        YamlProblemSeverity.Error
      );
    }
  }
  return formValues;
}

function unknownKeyProblems(
  document: Document,
  lineCounter: LineCounter,
  context: ConnectionYamlContext
): YamlProblem[] {
  return [
    ...unknownYamlKeyProblems(
      document.contents,
      CONNECTION_YAML_KEYS.connection,
      `the ${context.provider.displayName} connection`,
      lineCounter
    ),
    ...unknownYamlKeyProblems(
      document.getIn([ConnectionYamlKey.Inbound], true),
      CONNECTION_YAML_KEYS.inbound,
      ConnectionYamlKey.Inbound,
      lineCounter
    ),
  ];
}

function headerLines(provider: IntegrationProviderSummary): string[] {
  const secrets = getSecretSettingFields(provider).map((field) => field.label);
  const lines = [
    `# ${provider.displayName} connection. Ctrl+Space suggests the settings and their values.`,
  ];
  if (secrets.length > 0) {
    lines.push(
      `# Secrets (${secrets.join(", ")}) go in the fields under the editor, never in the YAML.`
    );
  }
  return lines;
}

/** "Site URL (required), e.g. https://…" / "Deployment: cloud (Jira Cloud) | data_center (…)". */
function settingComment(field: IntegrationFieldDescriptor): string {
  const parts = [`${field.label}${field.required ? " (required)" : ""}`];
  if (field.options && field.options.length > 0) {
    parts.push(
      `: ${field.options.map((option) => `${option.value} (${option.label})`).join(" | ")}`
    );
  } else if (field.placeholder) {
    parts.push(`, e.g. ${field.placeholder}`);
  }
  return parts.join("");
}

function describeCondition(field: IntegrationFieldDescriptor): string {
  const condition = field.showWhen;
  if (!condition) {
    return "another setting has a certain value";
  }
  const values = Array.isArray(condition.equals)
    ? condition.equals
    : [condition.equals];
  return `${condition.field} is ${values.map(String).join(" or ")}`;
}

/**
 * A setting's value as YAML: `[a, b]` for lists, a block for multi-line
 * text, nothing for an unset number.
 */
function yamlValue(value: unknown, indent: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => yamlScalar(String(item))).join(", ")}]`;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  const text = typeof value === "string" ? value : "";
  if (text.includes("\n")) {
    const body = text
      .split("\n")
      .map((line) => `${indent}  ${line}`)
      .join("\n");
    return `|\n${body}`;
  }
  return yamlScalar(text);
}

/** `text` as a YAML scalar: quoted only when it has to be. */
function yamlScalar(text: string): string {
  return stringify(text, { lineWidth: 0 }).trim();
}

function isSecretField(field: IntegrationFieldDescriptor): boolean {
  return field.kind === IntegrationFieldKind.Secret;
}

/** The `config:` mapping of the YAML ({} when absent), or null when it is not one. */
function settingsMappingOf(plain: unknown): Record<string, unknown> | null {
  if (!isRecord(plain)) {
    return null;
  }
  const config = plain[ConnectionYamlKey.Config];
  if (config === undefined || config === null) {
    return {};
  }
  return isRecord(config) ? config : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPathKey(key: PropertyKey): string | number {
  return typeof key === "symbol" ? String(key) : key;
}

/** The document as plain data; undefined when it cannot be (an alias bomb). */
function toPlainValue(document: Document): unknown {
  try {
    return document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch {
    return;
  }
}

const MAX_ALIAS_COUNT = 50;
