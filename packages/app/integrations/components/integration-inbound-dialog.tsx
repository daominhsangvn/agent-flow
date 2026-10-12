"use client";

import {
  type IntegrationConnection,
  IntegrationDeliveryMode,
} from "@repo/api/src/types/integration";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { copyToClipboard } from "@repo/app/shared/lib/clipboard-utils";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { MarkdownContent } from "@repo/design-system/components/ui/primitives/markdown-content";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  RotateCwIcon,
} from "lucide-react";
import { useState } from "react";
import {
  useIntegrationDeliveries,
  useIntegrationInbound,
  useRotateIntegrationInbound,
} from "../hooks/use-integrations";
import { IntegrationMutationErrorTitle } from "../lib/mutation-error";
import { IntegrationDeliveriesTable } from "./integration-deliveries-table";
import { MutationErrorMessage } from "./mutation-error-message";
import { ProviderIcon } from "./provider-icon";
import { QueryErrorMessage } from "./query-error-message";

export type IntegrationInboundDialogProps = {
  connection: IntegrationConnection;
  /** Admins see the inbound endpoint and secret; members only the deliveries. */
  isAdmin: boolean;
  onClose: () => void;
};

/**
 * Inbound side of a connection. For an admin of a webhook-mode connection it
 * shows the endpoint URL and shared secret (revealed on click, copyable), the
 * provider's setup instructions and a rotate action; for everyone it lists
 * the latest deliveries. Mount it only while open: both reads are gated on
 * the dialog being mounted, so the secret is never fetched in the background.
 */
export function IntegrationInboundDialog({
  connection,
  isAdmin,
  onClose,
}: Readonly<IntegrationInboundDialogProps>) {
  const showEndpoint =
    isAdmin && connection.deliveryMode === IntegrationDeliveryMode.Webhook;
  const deliveries = useIntegrationDeliveries(connection.id, {
    enabled: true,
  });

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon className="size-5" provider={connection.provider} />
            {showEndpoint ? "Inbound setup" : "Deliveries"}: {connection.name}
          </DialogTitle>
          <DialogDescription>
            {showEndpoint
              ? "Configure the source system to send events to this endpoint, then watch the deliveries arrive below."
              : "The latest events received for this connection."}
          </DialogDescription>
        </DialogHeader>

        {showEndpoint ? (
          <InboundEndpointSection connection={connection} />
        ) : null}

        <section
          aria-labelledby="integration-recent-deliveries"
          className="space-y-2"
        >
          <h3
            className="font-medium text-sm"
            id="integration-recent-deliveries"
          >
            Recent deliveries
          </h3>
          <IntegrationDeliveriesTable
            deliveries={deliveries.data}
            error={deliveries.error}
            isLoading={deliveries.isLoading}
            onRetry={() => {
              deliveries.refetch();
            }}
          />
        </section>
      </DialogContent>
    </Dialog>
  );
}

function InboundEndpointSection({
  connection,
}: Readonly<{ connection: IntegrationConnection }>) {
  const inbound = useIntegrationInbound(connection.id, { enabled: true });
  const rotate = useRotateIntegrationInbound();
  const [confirmRotate, setConfirmRotate] = useState(false);

  if (inbound.isLoading) {
    return (
      <div
        aria-label="Loading inbound endpoint"
        className="space-y-3"
        role="status"
      >
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (inbound.error || !inbound.data) {
    return (
      <QueryErrorMessage
        error={inbound.error}
        onRetry={() => {
          inbound.refetch();
        }}
        title="Couldn't load the inbound endpoint"
      />
    );
  }

  const details = inbound.data;
  return (
    <section aria-label="Inbound endpoint" className="space-y-4">
      <CopyableValue
        id="integration-inbound-url"
        label="Inbound URL"
        value={details.inboundUrl}
      />
      <SecretValue
        id="integration-inbound-secret"
        label="Secret"
        value={details.inboundSecret}
      />
      <div className="flex justify-end">
        <Button
          disabled={rotate.isPending}
          onClick={() => setConfirmRotate(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          {rotate.isPending ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RotateCwIcon className="size-3.5" />
          )}
          Rotate URL and secret
        </Button>
      </div>
      <MutationErrorMessage
        error={rotate.error}
        title={IntegrationMutationErrorTitle.RotateInbound}
      />
      {details.setupInstructions ? (
        <div className="rounded-md border bg-muted/30 p-3">
          <h3 className="mb-2 font-medium text-sm">Setup instructions</h3>
          <MarkdownContent
            className="text-sm"
            skipHtml
            text={details.setupInstructions}
          />
        </div>
      ) : null}
      <ConfirmationDialog
        confirmLabel="Rotate"
        description="A new inbound URL and secret are issued immediately. The source system stops being accepted until you update it with the new values."
        isPending={rotate.isPending}
        onConfirm={async () => {
          await rotate.mutateAsync(connection.id);
        }}
        onOpenChange={setConfirmRotate}
        open={confirmRotate}
        title="Rotate the inbound URL and secret?"
        variant="destructive"
      />
    </section>
  );
}

function CopyableValue({
  id,
  label,
  value,
}: Readonly<{ id: string; label: string; value: string }>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input className="font-mono text-xs" id={id} readOnly value={value} />
        <CopyButton label={label} value={value} />
      </div>
    </div>
  );
}

function SecretValue({
  id,
  label,
  value,
}: Readonly<{ id: string; label: string; value: string }>) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          className="font-mono text-xs"
          id={id}
          readOnly
          type={revealed ? "text" : "password"}
          value={value}
        />
        <Button
          aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
          onClick={() => setRevealed((current) => !current)}
          size="icon"
          type="button"
          variant="outline"
        >
          {revealed ? (
            <EyeOffIcon className="size-4" />
          ) : (
            <EyeIcon className="size-4" />
          )}
        </Button>
        <CopyButton label={label} value={value} />
      </div>
    </div>
  );
}

function CopyButton({
  label,
  value,
}: Readonly<{ label: string; value: string }>) {
  const handleCopy = async () => {
    const copied = await copyToClipboard(value);
    if (copied) {
      toast.success(`${label} copied`);
    } else {
      toast.error(`Couldn't copy the ${label.toLowerCase()}`);
    }
  };

  return (
    <Button
      aria-label={`Copy ${label}`}
      onClick={handleCopy}
      size="icon"
      type="button"
      variant="outline"
    >
      <CopyIcon className="size-4" />
    </Button>
  );
}
