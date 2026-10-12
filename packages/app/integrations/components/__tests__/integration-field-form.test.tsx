import {
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
} from "@repo/api/src/types/integration";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationFieldValues } from "../../lib/integration-field-values";
import { IntegrationFieldForm } from "../integration-field-form";

const INSERT_PR_URL_RE = /^Insert pr\.url:/;
const INSERT_SOURCE_KEY_RE = /^Insert source\.key:/;

const SITE_URL_RE = /Site URL/;

const DEPLOYMENT_CLOUD = "cloud";
const DEPLOYMENT_DATA_CENTER = "data_center";
const TYPE_STORY = "story";
const TYPE_BUG = "bug";

/** Controlled harness: renders the form and exposes the latest value map. */
function Harness({
  fields,
  initial = {},
  onValues,
  secretFields,
  errors,
}: Readonly<{
  fields: IntegrationFieldDescriptor[];
  initial?: IntegrationFieldValues;
  onValues?: (values: IntegrationFieldValues) => void;
  secretFields?: Record<string, { isSet: boolean; lastFour: string | null }>;
  errors?: Record<string, string>;
}>) {
  const [values, setValues] = useState<IntegrationFieldValues>(initial);
  return (
    <IntegrationFieldForm
      errors={errors}
      fields={fields}
      idPrefix="test"
      onChange={(next) => {
        setValues(next);
        onValues?.(next);
      }}
      secretFields={secretFields}
      values={values}
    />
  );
}

function lastValues(mock: ReturnType<typeof vi.fn>): IntegrationFieldValues {
  return mock.mock.calls.at(-1)?.[0] as IntegrationFieldValues;
}

describe("IntegrationFieldForm", () => {
  it("renders text, url and email inputs with label, placeholder, description and required marker", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(
      <Harness
        fields={[
          {
            key: "siteUrl",
            label: "Site URL",
            kind: IntegrationFieldKind.Url,
            required: true,
            placeholder: "https://acme.atlassian.net",
            description: "Your Jira site",
          },
          { key: "email", label: "Email", kind: IntegrationFieldKind.Email },
          {
            key: "name",
            label: "Display name",
            kind: IntegrationFieldKind.Text,
          },
        ]}
        onValues={onValues}
      />
    );

    const url = screen.getByLabelText(SITE_URL_RE);
    expect(url).toHaveAttribute("type", "url");
    expect(url).toHaveAttribute("placeholder", "https://acme.atlassian.net");
    expect(url).toHaveAccessibleDescription("Your Jira site");
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
    expect(screen.getByText("*")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Display name"), "Bot");
    expect(lastValues(onValues)).toMatchObject({ name: "Bot" });
  });

  it("renders a textarea", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(
      <Harness
        fields={[
          { key: "notes", label: "Notes", kind: IntegrationFieldKind.Textarea },
        ]}
        onValues={onValues}
      />
    );

    const notes = screen.getByLabelText("Notes");
    expect(notes.tagName).toBe("TEXTAREA");
    await user.type(notes, "hi");
    expect(lastValues(onValues)).toEqual({ notes: "hi" });
  });

  it("renders a secret as a password input with the stored last four as a keep hint", () => {
    render(
      <Harness
        fields={[
          {
            key: "apiToken",
            label: "API token",
            kind: IntegrationFieldKind.Secret,
          },
        ]}
        secretFields={{ apiToken: { isSet: true, lastFour: "9xYz" } }}
      />
    );

    const input = screen.getByLabelText("API token");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute(
      "placeholder",
      "•••• 9xYz - leave empty to keep"
    );
    expect(
      screen.getByText("•••• 9xYz - leave empty to keep")
    ).toBeInTheDocument();
  });

  it("stores numbers as numbers and an empty number as undefined", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(
      <Harness
        fields={[
          { key: "limit", label: "Limit", kind: IntegrationFieldKind.Number },
        ]}
        onValues={onValues}
      />
    );

    await user.type(screen.getByLabelText("Limit"), "12");
    expect(lastValues(onValues)).toEqual({ limit: 12 });
    await user.clear(screen.getByLabelText("Limit"));
    expect(lastValues(onValues)).toEqual({ limit: undefined });
  });

  it("renders a boolean as a switch starting from its default", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(
      <Harness
        fields={[
          {
            key: "notify",
            label: "Notify",
            kind: IntegrationFieldKind.Boolean,
            defaultValue: true,
          },
        ]}
        onValues={onValues}
      />
    );

    const toggle = screen.getByRole("switch", { name: "Notify" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(lastValues(onValues)).toEqual({ notify: false });
  });

  it("renders a select with options and stores the chosen value", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(
      <Harness
        fields={[
          {
            key: "deployment",
            label: "Deployment",
            kind: IntegrationFieldKind.Select,
            options: [
              { value: DEPLOYMENT_CLOUD, label: "Cloud" },
              { value: DEPLOYMENT_DATA_CENTER, label: "Data Center" },
            ],
          },
        ]}
        onValues={onValues}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Deployment" }));
    await user.click(
      await screen.findByRole("option", { name: "Data Center" })
    );
    expect(lastValues(onValues)).toEqual({
      deployment: DEPLOYMENT_DATA_CENTER,
    });
  });

  it("renders a multiselect as a checkbox list in option order", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(
      <Harness
        fields={[
          {
            key: "issueTypes",
            label: "Issue types",
            kind: IntegrationFieldKind.MultiSelect,
            options: [
              { value: TYPE_STORY, label: "Story" },
              { value: TYPE_BUG, label: "Bug" },
            ],
          },
        ]}
        onValues={onValues}
      />
    );

    expect(
      screen.getByRole("group", { name: "Issue types" })
    ).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Bug" }));
    await user.click(screen.getByRole("checkbox", { name: "Story" }));
    expect(lastValues(onValues)).toEqual({
      issueTypes: [TYPE_STORY, TYPE_BUG],
    });
    await user.click(screen.getByRole("checkbox", { name: "Bug" }));
    expect(lastValues(onValues)).toEqual({ issueTypes: [TYPE_STORY] });
  });

  it("adds string list items with Enter and commas, and removes them with chips", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(
      <Harness
        fields={[
          {
            key: "labels",
            label: "Labels",
            kind: IntegrationFieldKind.StringList,
          },
        ]}
        onValues={onValues}
      />
    );

    const input = screen.getByLabelText("Labels");
    await user.type(input, "ai{Enter}");
    await user.type(input, "backend,");
    expect(lastValues(onValues)).toEqual({ labels: ["ai", "backend"] });
    expect(input).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Remove ai" }));
    expect(lastValues(onValues)).toEqual({ labels: ["backend"] });
  });

  it("inserts template variables at the caret from the Variables helper", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(
      <Harness
        fields={[
          {
            key: "message",
            label: "Message",
            kind: IntegrationFieldKind.Template,
            defaultValue: "PR: ",
          },
        ]}
        onValues={onValues}
      />
    );

    const textarea = screen.getByLabelText("Message");
    expect(textarea).toHaveValue("PR: ");
    await user.click(screen.getByRole("button", { name: "Variables" }));
    await user.click(screen.getByRole("button", { name: INSERT_PR_URL_RE }));
    expect(lastValues(onValues)).toEqual({ message: "PR: {{pr.url}}" });
  });

  it("inserts a template variable over the user's selection", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(
      <Harness
        fields={[
          {
            key: "message",
            label: "Message",
            kind: IntegrationFieldKind.Template,
          },
        ]}
        initial={{ message: "Done: KEY" }}
        onValues={onValues}
      />
    );

    const textarea = screen.getByLabelText<HTMLTextAreaElement>("Message");
    textarea.focus();
    textarea.setSelectionRange(6, 9);
    fireEvent.select(textarea);
    await user.click(screen.getByRole("button", { name: "Variables" }));
    await user.click(
      screen.getByRole("button", { name: INSERT_SOURCE_KEY_RE })
    );
    expect(lastValues(onValues)).toEqual({ message: "Done: {{source.key}}" });
  });

  it("shows a field only while its showWhen condition holds", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        fields={[
          {
            key: "deployment",
            label: "Deployment",
            kind: IntegrationFieldKind.Select,
            defaultValue: DEPLOYMENT_CLOUD,
            options: [
              { value: DEPLOYMENT_CLOUD, label: "Cloud" },
              { value: DEPLOYMENT_DATA_CENTER, label: "Data Center" },
            ],
          },
          {
            key: "email",
            label: "Account email",
            kind: IntegrationFieldKind.Email,
            showWhen: { field: "deployment", equals: DEPLOYMENT_CLOUD },
          },
        ]}
      />
    );

    expect(screen.getByLabelText("Account email")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Deployment" }));
    await user.click(
      await screen.findByRole("option", { name: "Data Center" })
    );
    expect(screen.queryByLabelText("Account email")).not.toBeInTheDocument();
  });

  it("renders error messages linked to their control", () => {
    render(
      <Harness
        errors={{ siteUrl: "This field is required" }}
        fields={[
          {
            key: "siteUrl",
            label: "Site URL",
            kind: IntegrationFieldKind.Url,
          },
        ]}
      />
    );

    const input = screen.getByLabelText("Site URL");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("This field is required");
  });

  it("disables every control when disabled", () => {
    render(
      <IntegrationFieldForm
        disabled
        fields={[
          { key: "a", label: "A", kind: IntegrationFieldKind.Text },
          { key: "b", label: "B", kind: IntegrationFieldKind.Boolean },
        ]}
        idPrefix="disabled"
        onChange={vi.fn()}
        values={{}}
      />
    );

    expect(screen.getByLabelText("A")).toBeDisabled();
    expect(screen.getByRole("switch", { name: "B" })).toBeDisabled();
  });

  it("renders nothing when no field is visible", () => {
    const { container } = render(
      <IntegrationFieldForm
        fields={[]}
        idPrefix="empty"
        onChange={vi.fn()}
        values={{}}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
