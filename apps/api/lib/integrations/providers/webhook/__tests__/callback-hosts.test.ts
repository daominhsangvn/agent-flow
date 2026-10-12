import { describe, expect, it } from "vitest";
import {
  checkRequestCallbackUrl,
  isLocalOrPrivateHost,
} from "../callback-hosts";

describe("isLocalOrPrivateHost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "api.localhost",
    "nas.local",
    "metadata.google.internal",
    "intranet",
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "100.127.255.255",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "[::1]",
    "::",
    "fe80::abcd",
    "fdff::1",
    "::ffff:7f00:1",
    "[::ffff:a9fe:a9fe]",
  ])("treats %s as local or private", (host) => {
    expect(isLocalOrPrivateHost(host)).toBe(true);
  });

  it.each([
    "hooks.example.com",
    "hooks.example.com.",
    "my.localhost.example.com",
    "8.8.8.8",
    "100.63.255.255",
    "172.15.255.255",
    "172.32.0.0",
    "192.169.0.1",
    "2001:4860:4860::8888",
    "[::ffff:808:808]",
  ])("treats %s as public", (host) => {
    expect(isLocalOrPrivateHost(host)).toBe(false);
  });
});

describe("checkRequestCallbackUrl", () => {
  it("allows a public host when no hosts are listed", () => {
    expect(
      checkRequestCallbackUrl("https://hooks.example.com/cb?token=x", [])
    ).toEqual({ ok: true, value: "https://hooks.example.com/cb?token=x" });
  });

  it("refuses a private host when no hosts are listed", () => {
    expect(checkRequestCallbackUrl("http://localhost.:3002/x", [])).toEqual({
      ok: false,
      error:
        "its host localhost is a local or private address (list it in the connection's allowed callback hosts to allow it)",
    });
  });

  it("with a list, allows exactly the listed hosts", () => {
    const allowed = ["hooks.example.com", "fd00::1"];

    expect(
      checkRequestCallbackUrl("https://Hooks.Example.com:8443/cb", allowed).ok
    ).toBe(true);
    expect(
      checkRequestCallbackUrl("http://[fd00::1]:8080/cb", allowed).ok
    ).toBe(true);
    expect(checkRequestCallbackUrl("https://example.com/cb", allowed)).toEqual({
      ok: false,
      error:
        "its host example.com is not in the connection's allowed callback hosts",
    });
  });

  it("refuses a value that is not a URL", () => {
    expect(checkRequestCallbackUrl("not a url", [])).toEqual({
      ok: false,
      error: "it is not a valid URL",
    });
  });
});
