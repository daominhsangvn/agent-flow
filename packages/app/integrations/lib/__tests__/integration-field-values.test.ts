import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import {
  buildFieldValues,
  collectFieldValues,
  getFieldDefaultValue,
  getSecretReentry,
  getVisibleFields,
  INVALID_EMAIL_MESSAGE,
  INVALID_NUMBER_MESSAGE,
  INVALID_URL_MESSAGE,
  isFieldVisible,
  parseNumberInput,
  REMOVED_SECRET_VALUE,
  REQUIRED_FIELD_MESSAGE,
  readFieldValue,
  splitStringListEntry,
  toStringList,
  validateFieldValues,
} from "../integration-field-values";

const DEPLOYMENT_CLOUD = "cloud";
const DEPLOYMENT_DATA_CENTER = "data_center";

const deploymentField: IntegrationFieldDescriptor = {
  key: "deployment",
  label: "Deployment",
  kind: IntegrationFieldKind.Select,
  required: true,
  defaultValue: DEPLOYMENT_CLOUD,
  options: [
    { value: DEPLOYMENT_CLOUD, label: "Cloud" },
    { value: DEPLOYMENT_DATA_CENTER, label: "Data Center" },
  ],
};

const emailField: IntegrationFieldDescriptor = {
  key: "email",
  label: "Email",
  kind: IntegrationFieldKind.Email,
  required: true,
  showWhen: { field: "deployment", equals: DEPLOYMENT_CLOUD },
};

const siteUrlField: IntegrationFieldDescriptor = {
  key: "siteUrl",
  label: "Site URL",
  kind: IntegrationFieldKind.Url,
  required: true,
};

const tokenField: IntegrationFieldDescriptor = {
  key: "apiToken",
  label: "API token",
  kind: IntegrationFieldKind.Secret,
  required: true,
};

const signingSecretField: IntegrationFieldDescriptor = {
  key: "signingSecret",
  label: "Signing secret",
  kind: IntegrationFieldKind.Secret,
};

const FIELDS = [deploymentField, siteUrlField, emailField, tokenField];

const STORED_JIRA_CONFIG = {
  deployment: DEPLOYMENT_CLOUD,
  siteUrl: "https://acme.atlassian.net",
  email: "bot@acme.dev",
};

const STORED_TOKEN = { apiToken: { isSet: true, lastFour: "x9Kd" } };

const JIRA_ORIGIN_FIELDS = ["deployment", "siteUrl"];

describe("defaults and reads", () => {
  it("starts each kind from its descriptor default or kind-specific empty value", () => {
    expect(getFieldDefaultValue(deploymentField)).toBe(DEPLOYMENT_CLOUD);
    expect(
      getFieldDefaultValue({
        key: "on",
        label: "On",
        kind: IntegrationFieldKind.Boolean,
      })
    ).toBe(false);
    expect(
      getFieldDefaultValue({
        key: "tags",
        label: "Tags",
        kind: IntegrationFieldKind.StringList,
      })
    ).toEqual([]);
    expect(
      getFieldDefaultValue({
        key: "n",
        label: "N",
        kind: IntegrationFieldKind.Number,
      })
    ).toBeUndefined();
    // A secret never starts from a default, even a malicious descriptor one.
    expect(getFieldDefaultValue({ ...tokenField, defaultValue: "x" })).toBe("");
  });

  it("reads a stored value, falling back to the default only when the key is absent", () => {
    expect(readFieldValue(deploymentField, {})).toBe(DEPLOYMENT_CLOUD);
    expect(
      readFieldValue(deploymentField, { deployment: DEPLOYMENT_DATA_CENTER })
    ).toBe(DEPLOYMENT_DATA_CENTER);
  });

  it("builds initial values from an existing config and never echoes secrets", () => {
    const values = buildFieldValues(FIELDS, {
      siteUrl: "https://acme.atlassian.net",
      apiToken: "should-not-appear",
    });
    expect(values).toEqual({
      deployment: DEPLOYMENT_CLOUD,
      siteUrl: "https://acme.atlassian.net",
      email: "",
      apiToken: "",
    });
  });
});

describe("showWhen", () => {
  it("evaluates the condition through the controlling field's default", () => {
    expect(isFieldVisible(emailField, {}, FIELDS)).toBe(true);
    expect(
      isFieldVisible(emailField, { deployment: DEPLOYMENT_DATA_CENTER }, FIELDS)
    ).toBe(false);
  });

  it("supports a list of accepted values and boolean conditions", () => {
    const listCondition: IntegrationFieldDescriptor = {
      key: "x",
      label: "X",
      kind: IntegrationFieldKind.Text,
      showWhen: {
        field: "deployment",
        equals: [DEPLOYMENT_CLOUD, DEPLOYMENT_DATA_CENTER],
      },
    };
    const booleanCondition: IntegrationFieldDescriptor = {
      key: "y",
      label: "Y",
      kind: IntegrationFieldKind.Text,
      showWhen: { field: "advanced", equals: true },
    };
    expect(
      isFieldVisible(listCondition, { deployment: DEPLOYMENT_DATA_CENTER }, [
        deploymentField,
      ])
    ).toBe(true);
    expect(isFieldVisible(booleanCondition, { advanced: true }, [])).toBe(true);
    expect(isFieldVisible(booleanCondition, { advanced: false }, [])).toBe(
      false
    );
  });

  it("lists only the visible fields, in descriptor order", () => {
    expect(
      getVisibleFields(FIELDS, { deployment: DEPLOYMENT_DATA_CENTER }).map(
        (field) => field.key
      )
    ).toEqual(["deployment", "siteUrl", "apiToken"]);
  });
});

describe("validateFieldValues", () => {
  it("requires visible required fields and skips hidden ones", () => {
    expect(validateFieldValues(FIELDS, {})).toEqual({
      siteUrl: REQUIRED_FIELD_MESSAGE,
      email: REQUIRED_FIELD_MESSAGE,
      apiToken: REQUIRED_FIELD_MESSAGE,
    });
    expect(
      validateFieldValues(FIELDS, { deployment: DEPLOYMENT_DATA_CENTER })
    ).toEqual({
      siteUrl: REQUIRED_FIELD_MESSAGE,
      apiToken: REQUIRED_FIELD_MESSAGE,
    });
  });

  it("accepts an empty secret that is already stored (keep it)", () => {
    const errors = validateFieldValues(
      FIELDS,
      {
        deployment: DEPLOYMENT_DATA_CENTER,
        siteUrl: "https://jira.acme.internal",
        apiToken: "",
      },
      { secretFields: { apiToken: { isSet: true, lastFour: "abcd" } } }
    );
    expect(errors).toEqual({});
  });

  it("checks url, email and number formats", () => {
    const numberField: IntegrationFieldDescriptor = {
      key: "count",
      label: "Count",
      kind: IntegrationFieldKind.Number,
    };
    const plainEmailField: IntegrationFieldDescriptor = {
      key: "email",
      label: "Email",
      kind: IntegrationFieldKind.Email,
    };
    expect(
      validateFieldValues([siteUrlField, plainEmailField, numberField], {
        siteUrl: "ftp://acme",
        email: "not-an-email",
        count: Number.NaN,
      })
    ).toEqual({
      siteUrl: INVALID_URL_MESSAGE,
      email: INVALID_EMAIL_MESSAGE,
      count: INVALID_NUMBER_MESSAGE,
    });
  });

  it("treats false as an answer for a required boolean and [] as empty for lists", () => {
    const required: IntegrationFieldDescriptor[] = [
      {
        key: "flag",
        label: "Flag",
        kind: IntegrationFieldKind.Boolean,
        required: true,
      },
      {
        key: "types",
        label: "Types",
        kind: IntegrationFieldKind.MultiSelect,
        required: true,
      },
    ];
    expect(validateFieldValues(required, { flag: false, types: [] })).toEqual({
      types: REQUIRED_FIELD_MESSAGE,
    });
  });
});

describe("collectFieldValues", () => {
  it("splits config and typed secrets, trims text and drops hidden fields", () => {
    const collected = collectFieldValues(FIELDS, {
      deployment: DEPLOYMENT_DATA_CENTER,
      siteUrl: "  https://jira.acme.internal  ",
      email: "stale@acme.dev",
      apiToken: "  pat-123  ",
    });
    expect(collected).toEqual({
      config: {
        deployment: DEPLOYMENT_DATA_CENTER,
        siteUrl: "https://jira.acme.internal",
      },
      secrets: { apiToken: "pat-123" },
    });
  });

  it("omits an untouched secret so the stored one is kept", () => {
    expect(collectFieldValues([tokenField], { apiToken: "" }).secrets).toEqual(
      {}
    );
  });

  it('sends "" for a stored secret the user removed, which clears it', () => {
    expect(
      collectFieldValues([signingSecretField], {
        signingSecret: REMOVED_SECRET_VALUE,
      }).secrets
    ).toEqual({ signingSecret: "" });
  });

  it("drops blank optional text and empty numbers, applies defaults of absent keys", () => {
    const fields: IntegrationFieldDescriptor[] = [
      { key: "label", label: "Label", kind: IntegrationFieldKind.Text },
      { key: "limit", label: "Limit", kind: IntegrationFieldKind.Number },
      {
        key: "message",
        label: "Message",
        kind: IntegrationFieldKind.Template,
        defaultValue: "{{summary}}",
      },
      { key: "labels", label: "Labels", kind: IntegrationFieldKind.StringList },
      { key: "notify", label: "Notify", kind: IntegrationFieldKind.Boolean },
    ];
    expect(
      collectFieldValues(fields, { label: "   ", limit: undefined })
    ).toEqual({
      config: { message: "{{summary}}", labels: [], notify: false },
      secrets: {},
    });
  });
});

describe("getSecretReentry", () => {
  it("asks for nothing while the credential origin is unchanged", () => {
    const reentry = getSecretReentry({
      fields: FIELDS,
      values: buildFieldValues(FIELDS, STORED_JIRA_CONFIG),
      storedConfig: STORED_JIRA_CONFIG,
      secretFields: STORED_TOKEN,
      credentialOriginFields: JIRA_ORIGIN_FIELDS,
    });

    expect(reentry.hints).toEqual({});
    expect(reentry.secretFields).toEqual(STORED_TOKEN);
    expect(reentry.fields).toEqual(FIELDS);
  });

  it("ignores whitespace and a stored config that relies on a default", () => {
    const stored = { siteUrl: "https://acme.atlassian.net" };
    const reentry = getSecretReentry({
      fields: FIELDS,
      values: {
        ...buildFieldValues(FIELDS, stored),
        siteUrl: " https://acme.atlassian.net ",
      },
      storedConfig: stored,
      secretFields: STORED_TOKEN,
      credentialOriginFields: JIRA_ORIGIN_FIELDS,
    });

    expect(reentry.hints).toEqual({});
  });

  it("requires the stored secrets again when an origin field changes", () => {
    const values = {
      ...buildFieldValues(FIELDS, STORED_JIRA_CONFIG),
      siteUrl: "https://other.atlassian.net",
    };
    const reentry = getSecretReentry({
      fields: FIELDS,
      values,
      storedConfig: STORED_JIRA_CONFIG,
      secretFields: STORED_TOKEN,
      credentialOriginFields: JIRA_ORIGIN_FIELDS,
    });

    expect(reentry.hints).toEqual({
      apiToken: "Re-enter API token because Site URL changed",
    });
    expect(reentry.secretFields.apiToken).toEqual({
      isSet: false,
      lastFour: null,
    });
    expect(
      validateFieldValues(reentry.fields, values, {
        secretFields: reentry.secretFields,
      })
    ).toEqual({ apiToken: REQUIRED_FIELD_MESSAGE });
    expect(
      validateFieldValues(
        reentry.fields,
        { ...values, apiToken: "new-token" },
        { secretFields: reentry.secretFields }
      )
    ).toEqual({});
  });

  it("names every changed origin field and marks optional stored secrets required", () => {
    const fields = [...FIELDS, signingSecretField];
    const reentry = getSecretReentry({
      fields,
      values: {
        ...buildFieldValues(fields, STORED_JIRA_CONFIG),
        deployment: DEPLOYMENT_DATA_CENTER,
        siteUrl: "https://jira.acme.internal",
      },
      storedConfig: STORED_JIRA_CONFIG,
      secretFields: {
        ...STORED_TOKEN,
        signingSecret: { isSet: true, lastFour: "abcd" },
      },
      credentialOriginFields: JIRA_ORIGIN_FIELDS,
    });

    expect(reentry.hints).toEqual({
      apiToken: "Re-enter API token because Deployment and Site URL changed",
      signingSecret:
        "Re-enter Signing secret because Deployment and Site URL changed",
    });
    expect(
      reentry.fields.find((field) => field.key === "signingSecret")?.required
    ).toBe(true);
  });

  it("does not ask for a secret that is not stored or is being removed", () => {
    const fields = [siteUrlField, tokenField, signingSecretField];
    const reentry = getSecretReentry({
      fields,
      values: {
        siteUrl: "https://other.atlassian.net",
        apiToken: "",
        signingSecret: REMOVED_SECRET_VALUE,
      },
      storedConfig: STORED_JIRA_CONFIG,
      secretFields: {
        apiToken: { isSet: false, lastFour: null },
        signingSecret: { isSet: true, lastFour: "abcd" },
      },
      credentialOriginFields: ["siteUrl"],
    });

    expect(reentry.hints).toEqual({});
  });
});

describe("input helpers", () => {
  it("parses number input text", () => {
    expect(parseNumberInput("")).toBeUndefined();
    expect(parseNumberInput("42")).toBe(42);
    expect(parseNumberInput("abc")).toBeUndefined();
  });

  it("splits comma-separated tag entries without duplicates", () => {
    expect(splitStringListEntry(" ai, , backend ,ai", ["ai"])).toEqual([
      "ai",
      "backend",
    ]);
  });

  it("tolerates a malformed stored list", () => {
    expect(toStringList("nope")).toEqual([]);
    expect(toStringList(["a", "b"])).toEqual(["a", "b"]);
  });
});
