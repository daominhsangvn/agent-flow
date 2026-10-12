"use client";

import { getErrorMessage } from "@repo/app/shared/api/api-error";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { AlertCircleIcon } from "lucide-react";

export type MutationErrorMessageProps = {
  /** What failed, e.g. "Couldn't save the connection". */
  title: string;
  /** The mutation's error; nothing renders while it is null. */
  error: Error | null;
  className?: string;
};

/**
 * Inline error of a failed save or action: says what failed and shows the
 * server's message where the user is, so it stays readable after the toast
 * is gone. Used by the integrations and workflows surfaces.
 */
export function MutationErrorMessage({
  title,
  error,
  className,
}: Readonly<MutationErrorMessageProps>) {
  if (!error) {
    return null;
  }
  return (
    <Alert className={className} variant="error">
      <AlertCircleIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p className="break-words">{getErrorMessage(error)}</p>
      </AlertDescription>
    </Alert>
  );
}
