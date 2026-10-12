import { describe, expect, it } from "vitest";
import {
  createSchemaUrlMinter,
  readIamAuthConfig,
} from "../scripts/iam-database-url";

/**
 * Self-hosted deployments authenticate with DATABASE_URL only. Both callers of
 * this module (build-time migrate and the preview-schema ensure route) branch on
 * a `null` config, so the contract worth pinning is that IAM is never reported
 * as configured — even when the legacy variables are present.
 */
const DATABASE_URL_HINT = /DATABASE_URL/;

describe("readIamAuthConfig", () => {
  it("never reports IAM auth as configured", () => {
    expect(
      readIamAuthConfig({
        AWS_ROLE_ARN: "arn:aws:iam::1:role/legacy",
        AWS_REGION: "us-east-1",
        PGHOST: "db.example.test",
        PGUSER: "app",
        PGDATABASE: "app",
      })
    ).toBeNull();
  });
});

describe("createSchemaUrlMinter", () => {
  it("refuses to mint IAM URLs", () => {
    expect(() =>
      createSchemaUrlMinter({
        roleArn: "r",
        region: "us-east-1",
        host: "h",
        port: "5432",
        user: "u",
        database: "d",
      })
    ).toThrow(DATABASE_URL_HINT);
  });
});
