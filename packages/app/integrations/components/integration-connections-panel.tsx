"use client";

import {
  type IntegrationConnection,
  type IntegrationConnectionTestResult,
  IntegrationDeliveryMode,
  type IntegrationProviderSummary,
} from "@repo/api/src/types/integration";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  CheckCircleIcon,
  InboxIcon,
  Loader2Icon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  TrashIcon,
  XCircleIcon,
} from "lucide-react";
import { useState } from "react";
import {
  useDeleteIntegrationConnection,
  useIntegrationConnections,
  useIntegrationProviders,
  useTestIntegrationConnection,
} from "../hooks/use-integrations";
import {
  CONNECTION_STATUS_LABELS,
  CONNECTION_STATUS_TONES,
  DELIVERY_MODE_LABELS,
  getProviderDisplayName,
} from "../lib/integration-labels";
import { IntegrationConnectionDialog } from "./integration-connection-dialog";
import { IntegrationInboundDialog } from "./integration-inbound-dialog";
import { ProviderIcon } from "./provider-icon";
import { QueryErrorMessage } from "./query-error-message";

export type IntegrationConnectionsPanelProps = {
  /** Admins add, edit, test and delete connections; members get a read-only list. */
  isAdmin: boolean;
  /** Anchor id for deep links (`?tab=integrations#<id>`). */
  id?: string;
};

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; connection: IntegrationConnection }
  | { kind: "inbound"; connection: IntegrationConnection }
  | { kind: "delete"; connection: IntegrationConnection }
  | null;

/**
 * The org's generic integration connections (Jira, Azure DevOps, Microsoft
 * Teams, HTTPS webhooks, ...), rendered entirely from the provider catalog.
 * Workflows use these connections for their triggers and their pre and post
 * actions. A connection never changes the external system by itself: only
 * the actions a workflow configures do.
 */
export function IntegrationConnectionsPanel({
  isAdmin,
  id,
}: Readonly<IntegrationConnectionsPanelProps>) {
  const providers = useIntegrationProviders();
  const connections = useIntegrationConnections();
  const deleteConnection = useDeleteIntegrationConnection();
  const [dialog, setDialog] = useState<DialogState>(null);
  const closeDialog = () => setDialog(null);
  // Built-in providers (the generic HTTPS webhook) are not integrations to
  // connect: workflows use them through their own HTTP trigger and call.
  const connectableProviders = providers.data?.filter(
    (provider) => !provider.builtIn
  );
  const builtInKeys = new Set(
    (providers.data ?? [])
      .filter((provider) => provider.builtIn)
      .map((provider) => provider.key)
  );
  const canAdd = isAdmin && (connectableProviders?.length ?? 0) > 0;

  return (
    <Card id={id} tabIndex={id ? -1 : undefined}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <PlugIcon className="size-5" />
            Connections
          </CardTitle>
          <CardDescription>
            Accounts in Jira, Azure DevOps, Microsoft Teams and other systems
            that workflows use to receive events and to run the pre and post
            actions you configure.
            {isAdmin ? null : " Only organization admins can change them."}
          </CardDescription>
        </div>
        {canAdd ? (
          <Button
            onClick={() => setDialog({ kind: "create" })}
            size="sm"
            type="button"
          >
            <PlusIcon className="size-4" />
            Add connection
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <ConnectionsBody
          connections={connections.data?.filter(
            // A workflow's own HTTP endpoint is managed in its editor.
            (connection) =>
              connection.managedByWorkflowId === null &&
              !builtInKeys.has(connection.provider)
          )}
          error={connections.error}
          isAdmin={isAdmin}
          isLoading={connections.isLoading}
          onAdd={canAdd ? () => setDialog({ kind: "create" }) : undefined}
          onDelete={(connection) => setDialog({ kind: "delete", connection })}
          onEdit={(connection) => setDialog({ kind: "edit", connection })}
          onOpenInbound={(connection) =>
            setDialog({ kind: "inbound", connection })
          }
          onRetry={() => {
            connections.refetch();
          }}
          providers={connectableProviders}
        />
      </CardContent>

      {dialog?.kind === "create" || dialog?.kind === "edit" ? (
        <IntegrationConnectionDialog
          connection={dialog.kind === "edit" ? dialog.connection : undefined}
          onClose={closeDialog}
          onCreated={(created) => {
            // A new webhook connection is useless until the source system
            // knows its URL and secret, so go straight to the setup.
            if (created.deliveryMode === IntegrationDeliveryMode.Webhook) {
              setDialog({ kind: "inbound", connection: created });
            }
          }}
          providers={connectableProviders ?? []}
        />
      ) : null}
      {dialog?.kind === "inbound" ? (
        <IntegrationInboundDialog
          connection={dialog.connection}
          isAdmin={isAdmin}
          onClose={closeDialog}
        />
      ) : null}
      <ConfirmationDialog
        confirmLabel="Delete"
        description={
          dialog?.kind === "delete"
            ? `Delete "${dialog.connection.name}"? Its credentials are removed. A connection still used by a workflow trigger or action cannot be deleted.`
            : ""
        }
        isPending={deleteConnection.isPending}
        onConfirm={async () => {
          if (dialog?.kind === "delete") {
            await deleteConnection.mutateAsync(dialog.connection.id);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        open={dialog?.kind === "delete"}
        title="Delete connection?"
        variant="destructive"
      />
    </Card>
  );
}

type ConnectionsBodyProps = {
  connections: IntegrationConnection[] | undefined;
  providers: IntegrationProviderSummary[] | undefined;
  isLoading: boolean;
  error: Error | null;
  isAdmin: boolean;
  onRetry: () => void;
  onAdd: (() => void) | undefined;
  onEdit: (connection: IntegrationConnection) => void;
  onDelete: (connection: IntegrationConnection) => void;
  onOpenInbound: (connection: IntegrationConnection) => void;
};

function ConnectionsBody({
  connections,
  providers,
  isLoading,
  error,
  isAdmin,
  onRetry,
  onAdd,
  onEdit,
  onDelete,
  onOpenInbound,
}: Readonly<ConnectionsBodyProps>) {
  if (isLoading) {
    return (
      <div aria-label="Loading connections" className="space-y-3" role="status">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <QueryErrorMessage
        error={error}
        onRetry={onRetry}
        title="Couldn't load connections"
      />
    );
  }
  if (!connections || connections.length === 0) {
    return (
      <EmptyState
        action={
          onAdd ? (
            <Button onClick={onAdd} size="sm" type="button">
              <PlusIcon className="size-4" />
              Add connection
            </Button>
          ) : undefined
        }
        description={
          isAdmin
            ? "Connect Jira, Azure DevOps, Microsoft Teams or a generic HTTPS endpoint to start building workflows."
            : "An organization admin can connect Jira, Azure DevOps, Microsoft Teams or a generic HTTPS endpoint."
        }
        icon={PlugIcon}
        size="compact"
        title="No connections yet"
      />
    );
  }

  return (
    <ul
      aria-label="Integration connections"
      className="divide-y rounded-md border"
    >
      {connections.map((connection) => (
        <ConnectionRow
          connection={connection}
          isAdmin={isAdmin}
          key={connection.id}
          onDelete={() => onDelete(connection)}
          onEdit={() => onEdit(connection)}
          onOpenInbound={() => onOpenInbound(connection)}
          providerName={getProviderDisplayName(providers, connection.provider)}
        />
      ))}
    </ul>
  );
}

type ConnectionRowProps = {
  connection: IntegrationConnection;
  providerName: string;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onOpenInbound: () => void;
};

function ConnectionRow({
  connection,
  providerName,
  isAdmin,
  onEdit,
  onDelete,
  onOpenInbound,
}: Readonly<ConnectionRowProps>) {
  const testConnection = useTestIntegrationConnection();
  const [testResult, setTestResult] =
    useState<IntegrationConnectionTestResult | null>(null);
  const hasInbound = connection.deliveryMode !== IntegrationDeliveryMode.None;

  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <ProviderIcon
            className="mt-0.5 size-5"
            provider={connection.provider}
          />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium">{connection.name}</span>
              <Badge variant={CONNECTION_STATUS_TONES[connection.status]}>
                {CONNECTION_STATUS_LABELS[connection.status]}
              </Badge>
            </div>
            <ConnectionMeta
              connection={connection}
              providerName={providerName}
            />
            {connection.lastError ? (
              <p className="break-words text-destructive text-xs">
                Last error: {connection.lastError}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {hasInbound ? (
            <Button
              onClick={onOpenInbound}
              size="sm"
              type="button"
              variant="outline"
            >
              <InboxIcon className="size-3.5" />
              {isAdmin &&
              connection.deliveryMode === IntegrationDeliveryMode.Webhook
                ? "Inbound setup"
                : "Deliveries"}
            </Button>
          ) : null}
          {isAdmin ? (
            <>
              <Button
                disabled={testConnection.isPending}
                onClick={() =>
                  testConnection.mutate(connection.id, {
                    onSuccess: setTestResult,
                  })
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {testConnection.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : null}
                Test
              </Button>
              <Button
                aria-label={`Edit ${connection.name}`}
                onClick={onEdit}
                size="icon"
                type="button"
                variant="ghost"
              >
                <PencilIcon className="size-4" />
              </Button>
              <Button
                aria-label={`Delete ${connection.name}`}
                onClick={onDelete}
                size="icon"
                type="button"
                variant="ghost"
              >
                <TrashIcon className="size-4 text-muted-foreground" />
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {testResult ? <TestResultAlert result={testResult} /> : null}
    </li>
  );
}

function ConnectionMeta({
  connection,
  providerName,
}: Readonly<{ connection: IntegrationConnection; providerName: string }>) {
  const parts = [providerName, describeDeliveryMode(connection)];
  if (connection.account?.displayName) {
    parts.push(`as ${connection.account.displayName}`);
  }
  if (connection.usageCount > 0) {
    parts.push(
      `used by ${connection.usageCount} ${connection.usageCount === 1 ? "trigger or action" : "triggers and actions"}`
    );
  }

  return (
    <div className="space-y-0.5 text-muted-foreground text-xs">
      <p>{parts.join(" · ")}</p>
      <p>
        {connection.lastDeliveryAt
          ? `Last delivery ${formatRelativeTime(connection.lastDeliveryAt)}`
          : "No deliveries yet"}
      </p>
    </div>
  );
}

function TestResultAlert({
  result,
}: Readonly<{ result: IntegrationConnectionTestResult }>) {
  if (result.ok) {
    const account = result.account?.displayName;
    return (
      <Alert variant="success">
        <CheckCircleIcon />
        <AlertDescription>
          {account
            ? `Connection works. Authenticated as ${account}.`
            : "Connection works."}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="error">
      <XCircleIcon />
      <AlertDescription>
        {result.error ?? "The connection test failed."}
      </AlertDescription>
    </Alert>
  );
}

function describeDeliveryMode(connection: IntegrationConnection): string {
  const label = DELIVERY_MODE_LABELS[connection.deliveryMode];
  if (connection.deliveryMode !== IntegrationDeliveryMode.Poll) {
    return label;
  }
  const minutes = Math.round(connection.pollIntervalSeconds / 60);
  return minutes >= 1 ? `${label} every ${minutes} min` : label;
}
