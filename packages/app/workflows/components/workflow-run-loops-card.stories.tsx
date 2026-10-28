import { LoopCommand, LoopStatus } from "@agentflow-ai/loops-api/commands";
import type { WorkflowRunLoopRef } from "@repo/api/src/types/workflow";
import type { Meta, StoryObj } from "@storybook/react";
import { WorkflowRunLoopsCard } from "./workflow-run-loops-card";

const LOOPS: WorkflowRunLoopRef[] = [
  {
    loopId: "loop-1",
    command: LoopCommand.Plan,
    status: LoopStatus.Completed,
    adopted: false,
    stepId: null,
    prUrl: null,
    startedAt: new Date("2026-10-13T10:00:00.000Z"),
    completedAt: new Date("2026-10-13T10:12:00.000Z"),
  },
  {
    loopId: "loop-2",
    command: "ba-prd",
    status: LoopStatus.Completed,
    adopted: false,
    stepId: null,
    prUrl: "https://example.test/pr/1",
    startedAt: new Date("2026-10-13T10:15:00.000Z"),
    completedAt: new Date("2026-10-13T10:40:00.000Z"),
  },
  {
    loopId: "loop-3",
    command: LoopCommand.Step,
    status: LoopStatus.Running,
    adopted: true,
    stepId: "triage",
    prUrl: null,
    startedAt: new Date("2026-10-13T11:00:00.000Z"),
    completedAt: null,
  },
];

const meta = {
  title: "App Core/Workflows/Run Loops Card",
  component: WorkflowRunLoopsCard,
  args: {
    loops: LOOPS,
    stepName: (stepId: string) => (stepId === "triage" ? "Triage" : stepId),
  },
} satisfies Meta<typeof WorkflowRunLoopsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { loops: [], emptyText: "No task has launched a loop yet." },
};
