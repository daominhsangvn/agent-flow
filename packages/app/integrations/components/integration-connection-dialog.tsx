"use client";

import {
  INTEGRATION_NAME_MAX,
  INTEGRATION_POLL_INTERVAL_DEFAULT_SECONDS,
  INTEGRATION_POLL_INTERVAL_MAX_SECONDS,
  INTEGRATION_POLL_INTERVAL_MIN_SECONDS,
  type IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationDeliveryMode,
  type IntegrationProviderSummary,
  type UpdateIntegrationConnectionInput,
} from "@repo/api/src/types/integration";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Switch } from "@repo/design-system/components/ui/switch";
import { ArrowLeftIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import {
  useCreateIntegrationConnection,
  useUpdateIntegrationConnection,
} from "../hooks/use-integrations";
import {
  buildFieldValues,
  collectFieldValues,
  getSecretReentry,
  hasFieldErrors,
  type IntegrationFieldErrors,
  type IntegrationFieldValues,
  type SecretReentry,
  validateFieldValues,
} from "../lib/integration-field-values";
import {
  DELIVERY_MODE_DESCRIPTIONS,
  DELIVERY_MODE_LABELS,
  getDefaultDeliveryMode,
  getSelectableDeliveryModes,
} from "../lib/integration-labels";
import { IntegrationMutationErrorTitle } from "../lib/mutation-error";
import { IntegrationFieldForm } from "./integration-field-form";
import { MutationErrorMessage } from "./mutation-error-message";
import { ProviderIcon } from "./provider-icon";

export type IntegrationConnectionDialogProps = {
  /** The provider catalog (`GET /integrations/providers`). */
  providers: readonly IntegrationProviderSummary[];
  /** Present to edit an existing connection; absent to create one. */
  connection?: IntegrationConnection;
  onClose: () => void;
  /** Called after a successful create with the new connection. */
  onCreated?: (connection: IntegrationConnection) => void;
};

/**
 * Create / edit dialog for an integration connection. Mount it only while it
 * is open: every open starts from fresh state (the parent unmounts it on
 * close), so no reset effect is needed.
 *
 * Create is two steps: pick a provider from the catalog, then fill the
 * provider's connection fields. Edit skips the picker; the provider of a
 * connection never changes.
 */
export function IntegrationConnectionDialog({
  providers,
  connection,
  onClose,
  onCreated,
}: Readonly<IntegrationConnectionDialogProps>) {
  const [providerKey, setProviderKey] = useState<string | null>(
    connection?.provider ?? null
  );
  const provider = providers.find((candidate) => candidate.key === providerKey);
  const isEdit = Boolean(connection);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <ConnectionDialogBody
          connection={connection}
          isEdit={isEdit}
          onBack={() => setProviderKey(null)}
          onClose={onClose}
          onCreated={onCreated}
          onSelectProvider={setProviderKey}
          provider={provider}
          providers={providers}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConnectionDialogBody({
  provider,
  providers,
  connection,
  isEdit,
  onSelectProvider,
  onBack,
  onClose,
  onCreated,
}: Readonly<{
  provider: IntegrationProviderSummary | undefined;
  providers: readonly IntegrationProviderSummary[];
  connection: IntegrationConnection | undefined;
  isEdit: boolean;
  onSelectProvider: (providerKey: string) => void;
  onBack: () => void;
  onClose: () => void;
  onCreated: ((connection: IntegrationConnection) => void) | undefined;
}>) {
  if (provider) {
    return (
      <ConnectionForm
        connection={connection}
        key={provider.key}
        onBack={isEdit ? undefined : onBack}
        onClose={onClose}
        onCreated={onCreated}
        provider={provider}
      />
    );
  }
  if (connection) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Provider unavailable</DialogTitle>
          <DialogDescription>
            {`The provider "${connection.provider}" is no longer available on this server, so this connection cannot be edited.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }
  return <ProviderPicker onSelect={onSelectProvider} providers={providers} />;
}

function ProviderPicker({
  providers,
  onSelect,
}: Readonly<{
  providers: readonly IntegrationProviderSummary[];
  onSelect: (providerKey: string) => void;
}>) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add connection</DialogTitle>
        <DialogDescription>
          Choose the system to connect. One connection can serve any number of
          workflows.
        </DialogDescription>
      </DialogHeader>
      <ul aria-label="Providers" className="grid gap-2">
        {providers.map((provider) => (
          <li key={provider.key}>
            <button
              className="flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelect(provider.key)}
              type="button"
            >
              <ProviderIcon className="mt-0.5 size-5" provider={provider.key} />
              <span className="min-w-0 space-y-0.5">
                <span className="block font-medium text-sm">
                  {provider.displayName}
                </span>
                <span className="block text-muted-foreground text-xs">
                  {provider.description}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

type ConnectionFormProps = {
  provider: IntegrationProviderSummary;
  connection: IntegrationConnection | undefined;
  onBack: (() => void) | undefined;
  onClose: () => void;
  onCreated: ((connection: IntegrationConnection) => void) | undefined;
};

type ConnectionFormErrors = {
  name?: string;
  pollIntervalSeconds?: string;
  fields: IntegrationFieldErrors;
};

function ConnectionForm({
  provider,
  connection,
  onBack,
  onClose,
  onCreated,
}: Readonly<ConnectionFormProps>) {
  const createConnection = useCreateIntegrationConnection();
  const updateConnection = useUpdateIntegrationConnection();
  const isEdit = Boolean(connection);
  const deliveryModes = getSelectableDeliveryModes(provider);

  const [name, setName] = useState(
    connection?.name ?? defaultConnectionName(provider)
  );
  const [values, setValues] = useState<IntegrationFieldValues>(() =>
    buildFieldValues(provider.connectionFields, connection?.config)
  );
  const [deliveryMode, setDeliveryMode] = useState<IntegrationDeliveryMode>(
    connection?.deliveryMode ?? getDefaultDeliveryMode(provider)
  );
  const [pollInterval, setPollInterval] = useState(
    String(
      connection?.pollIntervalSeconds ??
        INTEGRATION_POLL_INTERVAL_DEFAULT_SECONDS
    )
  );
  const [enabled, setEnabled] = useState(
    connection?.status !== IntegrationConnectionStatus.Disabled
  );
  const [errors, setErrors] = useState<ConnectionFormErrors>({ fields: {} });
  const isPending = createConnection.isPending || updateConnection.isPending;
  // Changing where the credentials are sent (e.g. the Jira site URL) needs
  // the stored secrets typed again; the API rejects the update otherwise.
  const reentry = getConnectionSecretReentry(provider, connection, values);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateConnectionForm({
      name,
      pollInterval,
      deliveryMode,
      fieldErrors: validateFieldValues(reentry.fields, values, {
        secretFields: reentry.secretFields,
      }),
    });
    setErrors(nextErrors);
    if (hasConnectionFormErrors(nextErrors)) {
      return;
    }

    const { config, secrets } = collectFieldValues(
      provider.connectionFields,
      values
    );
    const shared = {
      name: name.trim(),
      config,
      secrets,
      deliveryMode,
      pollIntervalSeconds: parsePollInterval(pollInterval),
    };

    if (connection) {
      updateConnection.mutate(
        {
          id: connection.id,
          input: {
            ...shared,
            ...statusChange(connection, enabled),
          },
        },
        { onSuccess: onClose }
      );
      return;
    }
    createConnection.mutate(
      { provider: provider.key, ...shared },
      {
        onSuccess: (created) => {
          onClose();
          onCreated?.(created);
        },
      }
    );
  };

  return (
    <form className="space-y-5" noValidate onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ProviderIcon className="size-5" provider={provider.key} />
          {isEdit
            ? `Edit ${provider.displayName} connection`
            : provider.displayName}
        </DialogTitle>
        <DialogDescription>
          {provider.description}
          {provider.docsUrl ? (
            <>
              {" "}
              <a
                className="inline-flex items-center gap-1 text-[var(--link)] underline underline-offset-2"
                href={provider.docsUrl}
                rel="noreferrer noopener"
                target="_blank"
              >
                Setup guide
                <ExternalLinkIcon className="size-3" />
              </a>
            </>
          ) : null}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="integration-connection-name">
          Name
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        </Label>
        <Input
          aria-describedby={
            errors.name ? "integration-connection-name-error" : undefined
          }
          aria-invalid={errors.name ? true : undefined}
          id="integration-connection-name"
          maxLength={INTEGRATION_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
        {errors.name ? (
          <p
            className="text-destructive text-sm"
            id="integration-connection-name-error"
          >
            {errors.name}
          </p>
        ) : null}
      </div>

      <IntegrationFieldForm
        disabled={isPending}
        errors={errors.fields}
        fields={reentry.fields}
        idPrefix="integration-connection-field"
        notices={reentry.hints}
        onChange={setValues}
        secretFields={reentry.secretFields}
        values={values}
      />

      <DeliverySettings
        deliveryMode={deliveryMode}
        deliveryModes={deliveryModes}
        disabled={isPending}
        onDeliveryModeChange={setDeliveryMode}
        onPollIntervalChange={setPollInterval}
        pollInterval={pollInterval}
        pollIntervalError={errors.pollIntervalSeconds}
      />

      {isEdit ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="integration-connection-enabled">
              Connection enabled
            </Label>
            <p className="text-muted-foreground text-xs">
              A disabled connection ignores inbound events and skips its pre and
              post actions.
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={isPending}
            id="integration-connection-enabled"
            onCheckedChange={setEnabled}
          />
        </div>
      ) : null}

      <MutationErrorMessage
        error={isEdit ? updateConnection.error : createConnection.error}
        title={
          isEdit
            ? IntegrationMutationErrorTitle.UpdateConnection
            : IntegrationMutationErrorTitle.CreateConnection
        }
      />

      <DialogFooter className="gap-2 sm:justify-between">
        {onBack ? (
          <Button
            disabled={isPending}
            onClick={onBack}
            type="button"
            variant="ghost"
          >
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button
            disabled={isPending}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isPending} type="submit">
            {isPending ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {getSubmitLabel(isEdit, isPending)}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

function DeliverySettings({
  deliveryMode,
  deliveryModes,
  onDeliveryModeChange,
  pollInterval,
  onPollIntervalChange,
  pollIntervalError,
  disabled,
}: Readonly<{
  deliveryMode: IntegrationDeliveryMode;
  deliveryModes: IntegrationDeliveryMode[];
  onDeliveryModeChange: (mode: IntegrationDeliveryMode) => void;
  pollInterval: string;
  onPollIntervalChange: (value: string) => void;
  pollIntervalError: string | undefined;
  disabled: boolean;
}>) {
  return (
    <div className="space-y-4 rounded-lg border p-3">
      <div className="space-y-2">
        <Label htmlFor="integration-connection-delivery-mode">
          Inbound events
        </Label>
        <Select
          disabled={disabled}
          onValueChange={(value) =>
            onDeliveryModeChange(parseDeliveryMode(value))
          }
          value={deliveryMode}
        >
          <SelectTrigger
            className="w-full"
            id="integration-connection-delivery-mode"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {deliveryModes.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {DELIVERY_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {DELIVERY_MODE_DESCRIPTIONS[deliveryMode]}
        </p>
      </div>
      {deliveryMode === IntegrationDeliveryMode.Poll ? (
        <div className="space-y-2">
          <Label htmlFor="integration-connection-poll-interval">
            Poll interval (seconds)
          </Label>
          <Input
            aria-describedby={
              pollIntervalError
                ? "integration-connection-poll-interval-error"
                : undefined
            }
            aria-invalid={pollIntervalError ? true : undefined}
            disabled={disabled}
            id="integration-connection-poll-interval"
            inputMode="numeric"
            max={INTEGRATION_POLL_INTERVAL_MAX_SECONDS}
            min={INTEGRATION_POLL_INTERVAL_MIN_SECONDS}
            onChange={(event) => onPollIntervalChange(event.target.value)}
            type="number"
            value={pollInterval}
          />
          {pollIntervalError ? (
            <p
              className="text-destructive text-sm"
              id="integration-connection-poll-interval-error"
            >
              {pollIntervalError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const deliveryModeSchema = z.enum(IntegrationDeliveryMode);

const pollIntervalSchema = z.coerce
  .number()
  .int()
  .min(INTEGRATION_POLL_INTERVAL_MIN_SECONDS)
  .max(INTEGRATION_POLL_INTERVAL_MAX_SECONDS);

export const POLL_INTERVAL_ERROR = `Enter a whole number of seconds between ${INTEGRATION_POLL_INTERVAL_MIN_SECONDS} and ${INTEGRATION_POLL_INTERVAL_MAX_SECONDS}`;
export const CONNECTION_NAME_REQUIRED_ERROR = "Name is required";

function parseDeliveryMode(value: string): IntegrationDeliveryMode {
  const parsed = deliveryModeSchema.safeParse(value);
  return parsed.success ? parsed.data : IntegrationDeliveryMode.None;
}

/**
 * The poll interval sent to the API. A blank or invalid value only matters in
 * poll mode (where validation blocks the save); otherwise the default is sent.
 */
function parsePollInterval(value: string): number {
  const parsed = pollIntervalSchema.safeParse(value.trim());
  return parsed.success
    ? parsed.data
    : INTEGRATION_POLL_INTERVAL_DEFAULT_SECONDS;
}

function validateConnectionForm({
  name,
  pollInterval,
  deliveryMode,
  fieldErrors,
}: {
  name: string;
  pollInterval: string;
  deliveryMode: IntegrationDeliveryMode;
  fieldErrors: IntegrationFieldErrors;
}): ConnectionFormErrors {
  const errors: ConnectionFormErrors = { fields: fieldErrors };
  if (name.trim() === "") {
    errors.name = CONNECTION_NAME_REQUIRED_ERROR;
  }
  if (
    deliveryMode === IntegrationDeliveryMode.Poll &&
    (pollInterval.trim() === "" ||
      !pollIntervalSchema.safeParse(pollInterval.trim()).success)
  ) {
    errors.pollIntervalSeconds = POLL_INTERVAL_ERROR;
  }
  return errors;
}

function hasConnectionFormErrors(errors: ConnectionFormErrors): boolean {
  return (
    Boolean(errors.name) ||
    Boolean(errors.pollIntervalSeconds) ||
    hasFieldErrors(errors.fields)
  );
}

/**
 * The status to send with an update: only when the admin flipped the enabled
 * switch. Re-sending "active" for a connection in the "error" state would
 * claim the error was fixed; the server re-validates instead.
 */
function statusChange(
  connection: IntegrationConnection,
  enabled: boolean
): Pick<UpdateIntegrationConnectionInput, "status"> {
  const wasEnabled = connection.status !== IntegrationConnectionStatus.Disabled;
  if (enabled === wasEnabled) {
    return {};
  }
  return {
    status: enabled
      ? IntegrationConnectionStatus.Active
      : IntegrationConnectionStatus.Disabled,
  };
}

/**
 * The secrets to re-enter before an edit can be saved (none on create: every
 * secret is typed there anyway).
 */
function getConnectionSecretReentry(
  provider: IntegrationProviderSummary,
  connection: IntegrationConnection | undefined,
  values: IntegrationFieldValues
): SecretReentry {
  if (!connection) {
    return {
      fields: provider.connectionFields,
      secretFields: {},
      hints: {},
    };
  }
  return getSecretReentry({
    fields: provider.connectionFields,
    values,
    storedConfig: connection.config,
    secretFields: connection.secretFields,
    credentialOriginFields: provider.credentialOriginFields,
  });
}

function defaultConnectionName(provider: IntegrationProviderSummary): string {
  return provider.displayName;
}

function getSubmitLabel(isEdit: boolean, isPending: boolean): string {
  if (isPending) {
    return "Saving...";
  }
  return isEdit ? "Save changes" : "Create connection";
}
