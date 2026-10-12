import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/lib/workflows/template";

describe("renderTemplate", () => {
  const variables = {
    summary: "**PROJ-1** is done.",
    "run.url": "https://app.example.test/acme/workflows/w/runs/r",
    "source.key": "PROJ-1",
  };

  it("replaces known variables", () => {
    expect(renderTemplate("{{source.key}}: {{run.url}}", variables)).toBe(
      "PROJ-1: https://app.example.test/acme/workflows/w/runs/r"
    );
  });

  it("resolves step replies, also of step ids with dashes", () => {
    expect(
      renderTemplate("{{steps.draft-ticket.reply}} / {{steps.email.reply}}", {
        "steps.draft-ticket.reply": "Ticket",
        "steps.email.reply": "Email",
      })
    ).toBe("Ticket / Email");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(
      renderTemplate("{{ source.key }} / {{   summary\t}}", variables)
    ).toBe("PROJ-1 / **PROJ-1** is done.");
  });

  it("renders unknown variables as an empty string", () => {
    expect(renderTemplate("[{{pr.url}}]", variables)).toBe("[]");
  });

  it("does not resolve prototype properties", () => {
    expect(renderTemplate("{{constructor}}{{toString}}", variables)).toBe("");
  });

  it("inserts values verbatim without escaping", () => {
    expect(
      renderTemplate("{{summary}}", { summary: "<b>&amp;</b> {{x}}" })
    ).toBe("<b>&amp;</b> {{x}}");
  });

  it("leaves text that is not a placeholder alone", () => {
    expect(renderTemplate("{ {source.key} } {{}} {{a b}}", variables)).toBe(
      "{ {source.key} } {{}} {{a b}}"
    );
  });
});
