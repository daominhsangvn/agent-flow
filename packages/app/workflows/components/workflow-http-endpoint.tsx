"use client";

import type { IntegrationConnection } from "@repo/api/src/types/integration";
// Cross-slice: the inbound URL and secret dialog belongs to the integrations slice.
import { IntegrationInboundDialog } from "@repo/app/integrations/components/integration-inbound-dialog";
import { Button } from "@repo/design-system/components/ui/button";
import { GlobeIcon } from "lucide-react";
import { useState } from "react";

/**
 * Where the workflow's own HTTP endpoint is (a trigger with `connection:
 * http`): its URL and secret, revealed in the inbound dialog, once the
 * workflow was saved.
 */
export function WorkflowHttpEndpoint({
  connection,
}: Readonly<{ connection: IntegrationConnection | undefined }>) {
  const [isOpen, setIsOpen] = useState(false);
  if (!connection) {
    return (
      <p className="flex items-start gap-2 rounded-md border border-dashed p-3 text-muted-foreground text-sm">
        <GlobeIcon className="mt-0.5 size-4 shrink-0" />
        The workflow gets its own URL and signing secret when you save it. Send
        a JSON body with an id, a title and a description to start a run.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <GlobeIcon className="size-4 shrink-0" />
        Requests to this workflow's URL, signed with its secret, start runs.
      </p>
      <Button
        onClick={() => setIsOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        Show URL and secret
      </Button>
      {isOpen ? (
        <IntegrationInboundDialog
          connection={connection}
          isAdmin
          onClose={() => setIsOpen(false)}
        />
      ) : null}
    </div>
  );
}
