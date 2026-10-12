import { describe, expect, it } from "vitest";
import {
  getApiBaseUrl,
  getAppBaseUrl,
  getAppOrigin,
  isLocalUrl,
} from "../api-url";

const RE_E2E_API_URL = /E2E_API_URL/;

describe("getAppBaseUrl", () => {
  it("prefers BASE_URL, then NEXT_PUBLIC_APP_URL, then localhost:3000", () => {
    expect(
      getAppBaseUrl({
        BASE_URL: "http://localhost:4000/",
        NEXT_PUBLIC_APP_URL: "http://localhost:3100",
      })
    ).toBe("http://localhost:4000");
    expect(
      getAppBaseUrl({ NEXT_PUBLIC_APP_URL: "http://localhost:3100" })
    ).toBe("http://localhost:3100");
    expect(getAppBaseUrl({ BASE_URL: "  " })).toBe("http://localhost:3000");
  });

  it("exposes the origin for Better Auth's Origin header", () => {
    expect(getAppOrigin({ BASE_URL: "http://localhost:3100/app/" })).toBe(
      "http://localhost:3100"
    );
  });
});

describe("getApiBaseUrl", () => {
  it("prefers E2E_API_URL over NEXT_PUBLIC_API_URL", () => {
    expect(
      getApiBaseUrl({
        E2E_API_URL: "http://127.0.0.1:4002/",
        NEXT_PUBLIC_API_URL: "http://localhost:3002",
      })
    ).toBe("http://127.0.0.1:4002");
    expect(
      getApiBaseUrl({ NEXT_PUBLIC_API_URL: "http://localhost:3002/" })
    ).toBe("http://localhost:3002");
  });

  it("ignores API_BASE_URL, which the API uses for loop callbacks", () => {
    expect(
      getApiBaseUrl({
        API_BASE_URL: "https://tunnel.example.com",
        BASE_URL: "http://localhost:3100",
      })
    ).toBe("http://localhost:3002");
  });

  it("derives port 3002 on the app's local host", () => {
    expect(getApiBaseUrl({ BASE_URL: "http://127.0.0.1:3100" })).toBe(
      "http://127.0.0.1:3002"
    );
  });

  it("requires E2E_API_URL for remote app origins", () => {
    expect(() =>
      getApiBaseUrl({ BASE_URL: "https://app.example.com" })
    ).toThrow(RE_E2E_API_URL);
  });
});

describe("isLocalUrl", () => {
  it("recognises localhost and 127.0.0.1 only", () => {
    expect(isLocalUrl("http://localhost:3100")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:3002/health")).toBe(true);
    expect(isLocalUrl("https://app.example.com")).toBe(false);
  });
});
