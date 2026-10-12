"use client";

import type { IntegrationDelivery } from "@repo/api/src/types/integration";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  DELIVERY_OUTCOME_LABELS,
  DELIVERY_OUTCOME_TONES,
  DELIVERY_SOURCE_LABELS,
} from "../lib/integration-labels";
import { QueryErrorMessage } from "./query-error-message";

export type IntegrationDeliveriesTableProps = {
  deliveries: IntegrationDelivery[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
};

/** The latest inbound deliveries of a connection (webhook requests, poll results, manual runs). */
export function IntegrationDeliveriesTable({
  deliveries,
  isLoading,
  error,
  onRetry,
}: Readonly<IntegrationDeliveriesTableProps>) {
  if (isLoading) {
    return (
      <div aria-label="Loading deliveries" className="space-y-2" role="status">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <QueryErrorMessage
        error={error}
        onRetry={onRetry}
        title="Couldn't load deliveries"
      />
    );
  }
  if (!deliveries || deliveries.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-center text-muted-foreground text-sm">
        No deliveries yet. Events appear here as soon as the source system sends
        one.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Received</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead className="text-right">Runs</TableHead>
            <TableHead>Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deliveries.map((delivery) => (
            <TableRow key={delivery.id}>
              <TableCell
                className="whitespace-nowrap"
                title={delivery.deliveryId}
              >
                {formatRelativeTime(delivery.receivedAt)}
              </TableCell>
              <TableCell>{DELIVERY_SOURCE_LABELS[delivery.source]}</TableCell>
              <TableCell className="font-mono text-xs">
                {delivery.eventType ?? "-"}
              </TableCell>
              <TableCell>
                <Badge variant={DELIVERY_OUTCOME_TONES[delivery.outcome]}>
                  {DELIVERY_OUTCOME_LABELS[delivery.outcome]}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {delivery.runCount}
              </TableCell>
              <TableCell className="max-w-[16rem] truncate text-muted-foreground text-xs">
                {delivery.detail ?? ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
