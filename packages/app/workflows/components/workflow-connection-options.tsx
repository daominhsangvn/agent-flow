"use client";

import {
  type IntegrationConnection,
  IntegrationConnectionStatus,
} from "@repo/api/src/types/integration";
// Cross-slice: connection rows show the integrations slice's provider glyph.
import { ProviderIcon } from "@repo/app/integrations/components/provider-icon";
import { SelectItem } from "@repo/design-system/components/ui/select";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { InfoIcon } from "lucide-react";

/** Select items for the connections a trigger or action row can use. */
export function ConnectionSelectItems({
  connections,
  selectedId,
}: Readonly<{
  connections: readonly IntegrationConnection[];
  selectedId: string;
}>) {
  const isKnown =
    selectedId === "" ||
    connections.some((connection) => connection.id === selectedId);

  return (
    <>
      {connections.map((connection) => (
        <SelectItem key={connection.id} value={connection.id}>
          <span className="flex items-center gap-2">
            <ProviderIcon provider={connection.provider} />
            {connection.name}
            {connection.status === IntegrationConnectionStatus.Disabled
              ? " (disabled)"
              : null}
          </span>
        </SelectItem>
      ))}
      {isKnown ? null : (
        <SelectItem value={selectedId}>Unavailable connection</SelectItem>
      )}
    </>
  );
}

/**
 * Shown when no connection can serve a trigger or an action yet, pointing the
 * admin at the Connections section in Settings.
 */
export function MissingConnectionsHint({
  message,
  settingsPath,
}: Readonly<{ message: string; settingsPath: string | undefined }>) {
  const buildOrgPath = useOrgPath();

  return (
    <p className="flex items-start gap-2 rounded-md border border-dashed p-3 text-muted-foreground text-sm">
      <InfoIcon className="mt-0.5 size-4 shrink-0" />
      <span>
        {message}{" "}
        {settingsPath ? (
          <Link
            className="text-[var(--link)] underline underline-offset-2"
            href={buildOrgPath(settingsPath)}
          >
            Manage connections
          </Link>
        ) : null}
      </span>
    </p>
  );
}

/**
 * Radix Select mirrors its value into a hidden native `<select>`. When a new
 * value and the item that matches it appear in the same commit (a trigger or
 * action type preselected together with its connection), the native element
 * has no matching `<option>` yet, reports `""` and Radix forwards that as a
 * change. No item of these selects has an empty value, so an empty selection
 * is that echo, never a user choice, and must not reset the row.
 */
export function isRadixResetValue(value: string): boolean {
  return value === "";
}
