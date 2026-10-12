import { IntegrationFieldKind } from "@repo/api/src/types/integration";
import { describe, expect, it } from "vitest";
import {
  ADMIN_VIEWER,
  redactUrlFields,
  toUrlOrigin,
} from "@/lib/integrations/connection/url-redaction";

const FIELDS = [
  { key: "url", label: "URL", kind: IntegrationFieldKind.Url },
  { key: "message", label: "Message", kind: IntegrationFieldKind.Template },
];
const MEMBER = { isAdmin: false };

describe("toUrlOrigin", () => {
  it.each([
    [
      "https://hooks.zapier.com/hooks/catch/123/abc/",
      "https://hooks.zapier.com/…",
    ],
    ["https://hooks.example.com/?token=abc", "https://hooks.example.com/…"],
    ["https://hooks.example.com/#token", "https://hooks.example.com/…"],
    ["https://user:secret@hooks.example.com/", "https://hooks.example.com"],
    ["https://example.atlassian.net", "https://example.atlassian.net"],
    ["http://localhost:8080/hook", "http://localhost:8080/…"],
    ["not a url", "…"],
    ["mailto:ops@example.com", "…"],
  ])("%s -> %s", (value, expected) => {
    expect(toUrlOrigin(value)).toBe(expected);
  });
});

describe("redactUrlFields", () => {
  const config = {
    url: "https://hooks.example.com/hooks/catch/123/abc",
    message: "https://kept.example.com/not-a-url-field",
    unknown: "x",
  };

  it("keeps everything for admins", () => {
    expect(redactUrlFields(config, FIELDS, ADMIN_VIEWER)).toBe(config);
  });

  it("reduces url fields to their origin for members", () => {
    expect(redactUrlFields(config, FIELDS, MEMBER)).toEqual({
      ...config,
      url: "https://hooks.example.com/…",
    });
  });

  it("leaves empty and missing values alone", () => {
    expect(redactUrlFields({ url: "", other: null }, FIELDS, MEMBER)).toEqual({
      url: "",
      other: null,
    });
  });

  it("returns nothing to members when the fields are unknown", () => {
    expect(redactUrlFields(config, null, MEMBER)).toEqual({});
    expect(redactUrlFields(config, null, ADMIN_VIEWER)).toBe(config);
  });
});
