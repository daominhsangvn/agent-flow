import { getErrorMessage } from "@repo/app/shared/api/api-error";
import { toast } from "@repo/design-system/components/ui/sonner";

/**
 * Error handling of the integrations and workflows mutations (shared by both
 * slices).
 *
 * Their API routes answer a failure with the service's own message and no
 * friendly-error code ("Invalid configuration: siteUrl: ...", "PROJ-7 already
 * has an active run"). The shared default mutation toast resolves errors by
 * code, so for these it would only say "Operation failed". These options turn
 * that default off (`meta.suppressDefaultErrorToast`) and toast a title for
 * the operation with the server's message instead. Surfaces where the user is
 * looking (a dialog, the editor footer) also show the message inline with
 * `MutationErrorMessage`.
 */
export function mutationErrorOptions(title: string) {
  return {
    meta: { suppressDefaultErrorToast: true },
    onError: (error: Error) => {
      toastMutationServerError(title, error);
    },
  };
}

/** Toasts `title` with the server's message as the description. */
export function toastMutationServerError(title: string, error: unknown): void {
  toast.error(title, { description: getErrorMessage(error) });
}

/** Titles of the failed integration connection operations. */
export const IntegrationMutationErrorTitle = {
  CreateConnection: "Couldn't create the connection",
  UpdateConnection: "Couldn't save the connection",
  DeleteConnection: "Couldn't delete the connection",
  TestConnection: "Couldn't test the connection",
  RotateInbound: "Couldn't rotate the inbound URL and secret",
} as const;
export type IntegrationMutationErrorTitle =
  (typeof IntegrationMutationErrorTitle)[keyof typeof IntegrationMutationErrorTitle];
