/**
 * RDS IAM connection minting — disabled in self-hosted deployments.
 *
 * The hosted product signed 15-minute RDS IAM tokens (via Vercel OIDC) to build
 * schema-scoped connection URLs for the build-time migrate and the preview
 * schema `ensure` route. Self-hosted deployments authenticate with a plain
 * `DATABASE_URL` and have no AWS dependency, so this module keeps its contract
 * (callers already treat a `null` config as "IAM auth unavailable") without
 * pulling in the AWS SDK:
 *
 * - `readIamAuthConfig` always returns `null`, so `migrate.ts` falls back to
 *   `DATABASE_URL` and the preview-schema `ensure` route reports that it is not
 *   configured.
 * - `createSchemaUrlMinter` throws, because no caller can reach it without a
 *   config.
 */

export type IamAuthConfig = {
  roleArn: string;
  region: string;
  host: string;
  port: string;
  user: string;
  database: string;
};

export function readIamAuthConfig(
  _env: NodeJS.ProcessEnv
): IamAuthConfig | null {
  return null;
}

export function createSchemaUrlMinter(
  _config: IamAuthConfig
): (schema: string | null) => Promise<string> {
  throw new Error(
    "RDS IAM authentication is not available in self-hosted deployments; use DATABASE_URL."
  );
}
