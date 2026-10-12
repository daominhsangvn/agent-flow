"use client";

import { useState } from "react";
import { authApi, setActive } from "../auth-client";
import { AuthCard, AuthField, errorMessage } from "./auth-card";

const SLUG_INVALID_CHARS = /[^a-z0-9-]+/g;
const SLUG_EDGE_DASHES = /^-+|-+$/g;

/**
 * Creates an organization, makes it active and navigates to
 * `afterCreateOrganizationUrl` (`:slug` is replaced). Creation is disabled by
 * default in single-tenant deployments (`AUTH_ALLOW_CREATE_ORGANIZATION`); the
 * server's refusal is shown as an error.
 */
export function CreateOrganization({
  afterCreateOrganizationUrl = "/",
}: Readonly<{
  afterCreateOrganizationUrl?: string;
  [key: string]: unknown;
}>) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const create = async () => {
    const finalSlug = slug || toSlug(name);
    setSubmitting(true);
    setError(null);
    const result = await authApi.createOrganization({ name, slug: finalSlug });
    if (result.error || !result.data) {
      setError(errorMessage(result.error, "Could not create the organization"));
      setSubmitting(false);
      return;
    }
    await setActive({ organization: result.data.id });
    globalThis.location.assign(
      afterCreateOrganizationUrl.replace(":slug", finalSlug)
    );
  };

  return (
    <AuthCard
      error={error}
      onSubmit={create}
      submitLabel="Create organization"
      submitting={submitting}
      title="Create organization"
    >
      <AuthField id="org-name" label="Name" onChange={setName} value={name} />
      <AuthField
        id="org-slug"
        label="URL slug"
        onChange={(value) => setSlug(toSlug(value))}
        value={slug || toSlug(name)}
      />
    </AuthCard>
  );
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(SLUG_INVALID_CHARS, "-")
    .replaceAll(SLUG_EDGE_DASHES, "");
}
