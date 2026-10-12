"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";

export type QueryErrorMessageProps = {
  title: string;
  error: Error | null;
  onRetry?: () => void;
  className?: string;
};

/**
 * Inline error state for a failed read: says what failed, shows the server's
 * message, and offers a retry. Used instead of leaving a skeleton up forever.
 */
export function QueryErrorMessage({
  title,
  error,
  onRetry,
  className,
}: Readonly<QueryErrorMessageProps>) {
  return (
    <Alert className={className} variant="error">
      <AlertCircleIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{error?.message || "Something went wrong."}</span>
          {onRetry ? (
            <Button onClick={onRetry} size="sm" type="button" variant="outline">
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}
