"use client";

import {
  type IntegrationConnection,
  IntegrationConnectionStatus,
  type IntegrationFieldDescriptor,
  IntegrationFieldKind,
  type IntegrationProviderSummary,
  type UpdateIntegrationConnectionInput,
} from "@repo/api/src/types/integration";
import {
  type YamlProblem,
  YamlProblemSeverity,
} from "@repo/app/shared/lib/yaml-problems";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { ArrowLeftIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { type FormEvent, lazy, Suspense, useMemo, useState } from "react";
import {
  useCreateIntegrationConnection,
  useUpdateIntegrationConnection,
} from "../hooks/use-integrations";
import {
  type ConnectionYamlContext,
  connectionToYaml,
  getSecretSettingFields,
  parseConnectionYaml,
} from "../lib/connection-yaml";
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
} from "../lib/integration-labels";
import { IntegrationMutationErrorTitle } from "../lib/mutation-error";
import { IntegrationConnectionProjects } from "./integration-connection-projects";
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
 * Create is two steps: pick a provider from the catalog, then write the
 * connection as YAML (name, the provider's settings, inbound mode) with
 * suggestions and inline problems; secrets go in the password fields under
 * the editor, never in the YAML. Edit skips the picker; the provider of a
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
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

// The code editor loads with the dialog step that shows it.
const LazyConnectionYamlEditor = lazy(() =>
  import("./connection-yaml-editor").then((module) => ({
    default: module.ConnectionYamlEditor,
  }))
);

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
  const context = useMemo<ConnectionYamlContext>(
    () => ({ provider, isEdit }),
    [provider, isEdit]
  );
  const [text, setText] = useState(() =>
    connectionToYaml(provider, connection)
  );
  const [secretValues, setSecretValues] = useState<IntegrationFieldValues>(() =>
    buildFieldValues(getSecretSettingFields(provider))
  );
  const [secretErrors, setSecretErrors] = useState<IntegrationFieldErrors>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const result = useMemo(
    () => parseConnectionYaml(text, context),
    [text, context]
  );
  const isPending = createConnection.isPending || updateConnection.isPending;
  // While the YAML does not read, the secrets are judged against the stored
  // settings.
  const values: IntegrationFieldValues = {
    ...(result.settings ??
      buildFieldValues(provider.connectionFields, connection?.config)),
    ...secretValues,
  };
  // Changing where the credentials are sent (e.g. the Jira site URL) needs
  // the stored secrets typed again; the API rejects the update otherwise.
  const reentry = getConnectionSecretReentry(provider, connection, values);
  const secretFields = reentry.fields.filter(isSecretField);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitAttempted(true);
    const errors = validateFieldValues(secretFields, values, {
      secretFields: reentry.secretFields,
    });
    setSecretErrors(errors);
    const yaml = result.value;
    if (!yaml || hasFieldErrors(errors)) {
      return;
    }
    const { config, secrets } = collectFieldValues(provider.connectionFields, {
      ...yaml.config,
      ...secretValues,
    });
    const shared = {
      name: yaml.name,
      config,
      secrets,
      deliveryMode: yaml.deliveryMode,
      pollIntervalSeconds: yaml.pollIntervalSeconds,
    };

    if (connection) {
      updateConnection.mutate(
        {
          id: connection.id,
          input: { ...shared, ...statusChange(connection, yaml.enabled) },
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
    <form className="space-y-4" noValidate onSubmit={handleSubmit}>
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

      <p className="text-muted-foreground text-xs">
        Write the connection as YAML. Suggestions appear as you type and
        Ctrl+Space shows them anywhere; problems are underlined.
      </p>
      <Suspense
        fallback={
          <pre className="max-h-[36rem] overflow-auto rounded-md border p-3 font-mono text-xs">
            {text}
          </pre>
        }
      >
        <LazyConnectionYamlEditor
          context={context}
          onChange={setText}
          value={text}
        />
      </Suspense>
      {result.value ? (
        <p className="text-muted-foreground text-xs">
          <span className="font-medium text-foreground">
            Inbound events: {DELIVERY_MODE_LABELS[result.value.deliveryMode]}.
          </span>{" "}
          {DELIVERY_MODE_DESCRIPTIONS[result.value.deliveryMode]}
        </p>
      ) : null}

      {secretFields.length > 0 ? (
        <section
          aria-labelledby="integration-connection-secrets"
          className="space-y-3 rounded-lg border p-3"
        >
          <div className="space-y-0.5">
            <h3
              className="font-medium text-sm"
              id="integration-connection-secrets"
            >
              Secrets
            </h3>
            <p className="text-muted-foreground text-xs">
              Never written in the YAML and never shown again after saving.
            </p>
          </div>
          <IntegrationFieldForm
            disabled={isPending}
            errors={secretErrors}
            fields={secretFields}
            idPrefix="integration-connection-field"
            notices={reentry.hints}
            onChange={(next) => setSecretValues(pickValues(next, secretFields))}
            secretFields={reentry.secretFields}
            values={values}
          />
        </section>
      ) : null}

      {submitAttempted ? (
        <ConnectionYamlProblems problems={result.problems} />
      ) : null}

      {connection ? (
        <IntegrationConnectionProjects connectionId={connection.id} />
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
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {submitAttempted && !result.value ? (
            <p className="text-destructive text-sm" role="alert">
              Fix the problems in the YAML before saving.
            </p>
          ) : null}
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
              {isPending ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : null}
              {getSubmitLabel(isEdit, isPending)}
            </Button>
          </div>
        </div>
      </DialogFooter>
    </form>
  );
}

/** The problems of the YAML by line, errors and warnings, after a save attempt. */
function ConnectionYamlProblems({
  problems,
}: Readonly<{ problems: readonly YamlProblem[] }>) {
  if (problems.length === 0) {
    return null;
  }
  return (
    <ul
      aria-label="Problems"
      className="space-y-1 rounded-md border p-3 text-sm"
      data-testid="connection-yaml-problems"
    >
      {problems.map((problem) => (
        <li
          className={
            problem.severity === YamlProblemSeverity.Error
              ? "text-destructive"
              : "text-muted-foreground"
          }
          key={`${problem.from}-${problem.message}`}
        >
          Line {problem.line}: {problem.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * The status to send with an update: only when the admin flipped
 * `enabled`. Re-sending "active" for a connection in the "error" state would
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

function isSecretField(field: IntegrationFieldDescriptor): boolean {
  return field.kind === IntegrationFieldKind.Secret;
}

/** The values of `fields` only. */
function pickValues(
  values: IntegrationFieldValues,
  fields: readonly IntegrationFieldDescriptor[]
): IntegrationFieldValues {
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(values, field.key))
      .map((field) => [field.key, values[field.key]])
  );
}

function getSubmitLabel(isEdit: boolean, isPending: boolean): string {
  if (isPending) {
    return "Saving...";
  }
  return isEdit ? "Save changes" : "Create connection";
}
