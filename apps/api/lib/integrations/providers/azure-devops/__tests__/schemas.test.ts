import { describe, expect, it } from "vitest";
import { AdoField } from "@/lib/integrations/providers/azure-devops/constants";
import {
  adoConnectionConfigSchema,
  normalizeOrganizationUrl,
  organizationNameFromUrl,
  parseWorkItemId,
  readWorkItemFields,
  urlBelongsToOrganization,
} from "@/lib/integrations/providers/azure-devops/schemas";

describe("normalizeOrganizationUrl", () => {
  it.each([
    ["https://dev.azure.com/contoso", "https://dev.azure.com/contoso"],
    ["https://dev.azure.com/contoso/", "https://dev.azure.com/contoso"],
    [
      "https://DEV.AZURE.COM/contoso/Fabrikam/_workitems?x=1#y",
      "https://dev.azure.com/contoso",
    ],
    ["https://contoso.visualstudio.com", "https://contoso.visualstudio.com"],
    [
      "https://Contoso.VisualStudio.com/DefaultCollection/",
      "https://contoso.visualstudio.com",
    ],
    ["http://localhost:4010/contoso/", "http://localhost:4010/contoso"],
    ["http://127.0.0.1:4010", "http://127.0.0.1:4010"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeOrganizationUrl(input)).toBe(expected);
  });

  it.each([
    "http://dev.azure.com/contoso",
    "https://dev.azure.com/",
    "https://example.com/contoso",
    "https://contoso.visualstudio.com.evil.example",
    "ftp://localhost/contoso",
    "dev.azure.com/contoso",
    "",
  ])("rejects %s", (input) => {
    expect(normalizeOrganizationUrl(input)).toBeNull();
  });
});

describe("adoConnectionConfigSchema", () => {
  it("stores the normalized organization URL", () => {
    expect(
      adoConnectionConfigSchema.parse({
        organizationUrl: "  https://dev.azure.com/contoso/Fabrikam  ",
      })
    ).toEqual({ organizationUrl: "https://dev.azure.com/contoso" });
  });

  it("rejects unsupported hosts with a hint", () => {
    const result = adoConnectionConfigSchema.safeParse({
      organizationUrl: "https://example.com/contoso",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("dev.azure.com");
  });
});

describe("URL helpers", () => {
  it("derives the organization name", () => {
    expect(organizationNameFromUrl("https://dev.azure.com/contoso")).toBe(
      "contoso"
    );
    expect(organizationNameFromUrl("https://fabrikam.visualstudio.com")).toBe(
      "fabrikam"
    );
  });

  it("checks that a URL lives inside the organization", () => {
    const org = "https://dev.azure.com/contoso";
    expect(
      urlBelongsToOrganization(
        "https://dev.azure.com/Contoso/Web/_workitems/edit/1",
        org
      )
    ).toBe(true);
    expect(
      urlBelongsToOrganization("https://dev.azure.com/contoso-other/Web", org)
    ).toBe(false);
    expect(urlBelongsToOrganization("not a url", org)).toBe(false);
  });

  it("parses positive 32-bit work item ids only", () => {
    expect(parseWorkItemId("4321")).toBe(4321);
    expect(parseWorkItemId("0")).toBeNull();
    expect(parseWorkItemId("-1")).toBeNull();
    expect(parseWorkItemId("12a")).toBeNull();
    expect(parseWorkItemId("2147483648")).toBeNull();
  });
});

describe("readWorkItemFields", () => {
  it("returns null for missing fields and fields of an unexpected type", () => {
    const fields = readWorkItemFields({
      [AdoField.Title]: "  Export orders  ",
      [AdoField.State]: 12,
      [AdoField.Priority]: 2,
      [AdoField.Tags]: "   ",
    });
    expect(fields[AdoField.Title]).toBe("Export orders");
    expect(fields[AdoField.State]).toBeNull();
    expect(fields[AdoField.Priority]).toBe("2");
    expect(fields[AdoField.Tags]).toBeNull();
    expect(fields[AdoField.Description]).toBeNull();
  });

  it("accepts a missing field map", () => {
    expect(readWorkItemFields(null)[AdoField.Title]).toBeNull();
  });
});
