import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ALLOW_HTTP_HOSTS_ENV,
  normalizeAndValidateOrigin,
  normalizeWebAppOrigin,
} from "../src/main/settings/origin-policy.js";

const MUST_USE_HTTPS_RE = /must use https/i;
const DOCKER_HOST_ORIGIN = "http://host.docker.internal:3002";

afterEach(() => {
  delete process.env[ALLOW_HTTP_HOSTS_ENV];
});

test("plain http to a non-loopback host stays rejected by default", () => {
  assert.throws(
    () => normalizeAndValidateOrigin(DOCKER_HOST_ORIGIN),
    MUST_USE_HTTPS_RE
  );
});

test("hosts listed in the allow list may use http, case-insensitively", () => {
  process.env[ALLOW_HTTP_HOSTS_ENV] = " Host.Docker.Internal , api.lan ";
  assert.equal(
    normalizeAndValidateOrigin(DOCKER_HOST_ORIGIN),
    DOCKER_HOST_ORIGIN
  );
  assert.equal(
    normalizeWebAppOrigin("http://api.lan:3100/x"),
    "http://api.lan:3100"
  );
});

test("the allow list matches exact host names only", () => {
  process.env[ALLOW_HTTP_HOSTS_ENV] = "api.lan";
  for (const origin of ["http://evil-api.lan", "http://api.lan.evil.com"]) {
    assert.throws(() => normalizeAndValidateOrigin(origin), MUST_USE_HTTPS_RE);
  }
});
