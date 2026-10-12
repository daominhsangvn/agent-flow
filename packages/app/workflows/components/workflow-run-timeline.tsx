"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  AlertTriangleIcon,
  BanIcon,
  CheckIcon,
  CircleDashedIcon,
  Loader2Icon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import {
  buildRunTimeline,
  type RunTimelineInput,
  RunTimelineStepState,
} from "../lib/workflow-run-timeline";

/** Phase stepper of a run: received, pre actions, importing, planning, implementing, done. */
export function WorkflowRunTimeline({
  run,
}: Readonly<{ run: RunTimelineInput }>) {
  const steps = buildRunTimeline(run);

  return (
    <ol
      aria-label="Run progress"
      className="flex flex-wrap items-center gap-x-2 gap-y-2"
    >
      {steps.map((step, index) => {
        const presentation = STEP_PRESENTATION[step.state];
        const Icon = presentation.icon;
        return (
          <li className="flex items-center gap-2" key={step.key}>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                presentation.className
              )}
              data-state={step.state}
            >
              <Icon
                aria-hidden="true"
                className={cn("size-3.5", presentation.iconClassName)}
              />
              {step.label}
              <span className="sr-only">{`: ${presentation.srLabel}`}</span>
            </span>
            {index < steps.length - 1 ? (
              <span aria-hidden="true" className="h-px w-4 bg-border" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

type StepPresentation = {
  icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
  className: string;
  iconClassName?: string;
  srLabel: string;
};

const STEP_PRESENTATION: Record<RunTimelineStepState, StepPresentation> = {
  [RunTimelineStepState.Done]: {
    icon: CheckIcon,
    className: "border-success/30 bg-success/10 text-success-foreground",
    srLabel: "done",
  },
  [RunTimelineStepState.Current]: {
    icon: Loader2Icon,
    className: "border-info/30 bg-info/10 text-info-foreground",
    iconClassName: "animate-spin",
    srLabel: "in progress",
  },
  [RunTimelineStepState.Attention]: {
    icon: AlertTriangleIcon,
    className: "border-warning/30 bg-warning/10 text-warning-foreground",
    srLabel: "waiting for input",
  },
  [RunTimelineStepState.Upcoming]: {
    icon: CircleDashedIcon,
    className: "border-border text-muted-foreground",
    srLabel: "not started",
  },
  [RunTimelineStepState.Skipped]: {
    icon: MinusIcon,
    className: "border-border text-muted-foreground opacity-70",
    srLabel: "skipped",
  },
  [RunTimelineStepState.Succeeded]: {
    icon: CheckIcon,
    className: "border-success/30 bg-success/15 text-success-foreground",
    srLabel: "succeeded",
  },
  [RunTimelineStepState.Failed]: {
    icon: XIcon,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    srLabel: "failed",
  },
  [RunTimelineStepState.Cancelled]: {
    icon: BanIcon,
    className: "border-border bg-muted text-muted-foreground",
    srLabel: "cancelled",
  },
};
