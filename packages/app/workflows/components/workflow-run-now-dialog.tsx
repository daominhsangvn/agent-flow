"use client";

// Cross-slice: the inline mutation error is owned by the integrations slice.
import { MutationErrorMessage } from "@repo/app/integrations/components/mutation-error-message";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { Loader2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useStartWorkflowRun } from "../hooks/use-workflows";
import type { ManualRunTrigger } from "../lib/workflow-catalog";
import { WorkflowMutationErrorTitle } from "../lib/workflow-labels";

export type WorkflowRunNowDialogProps = {
  workflowId: string;
  /** Enabled triggers that support a manual run; at least one. */
  triggers: readonly ManualRunTrigger[];
  onClose: () => void;
};

export const RUN_NOW_INPUT_REQUIRED = "Enter the item to run on";
export const RUN_NOW_INPUT_MAX = 65_536;

/**
 * Starts a run by hand for one trigger, from the item reference the trigger
 * asks for (a Jira issue key, an Azure DevOps work item id, a JSON body, ...).
 * Trigger filters are not applied: the admin chose the item explicitly. Opens
 * the new run on success; a refusal (unknown item, an active run for it)
 * shows the server's message in the dialog. Mount it only while open.
 */
export function WorkflowRunNowDialog({
  workflowId,
  triggers,
  onClose,
}: Readonly<WorkflowRunNowDialogProps>) {
  const startRun = useStartWorkflowRun();
  const { navigate } = useNavigation();
  const buildOrgPath = useOrgPath();
  const [triggerId, setTriggerId] = useState(triggers[0]?.trigger.id ?? "");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = triggers.find((item) => item.trigger.id === triggerId);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = input.trim();
    if (!(selected && value)) {
      setError(RUN_NOW_INPUT_REQUIRED);
      return;
    }
    setError(null);
    startRun.mutate(
      { workflowId, input: { triggerId: selected.trigger.id, input: value } },
      {
        onSuccess: (run) => {
          onClose();
          navigate(buildOrgPath(`/workflows/${workflowId}/runs/${run.id}`));
        },
      }
    );
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="sm:max-w-lg">
        <form className="space-y-4" noValidate onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Run now</DialogTitle>
            <DialogDescription>
              Start a run for one item. Trigger filters are not applied.
            </DialogDescription>
          </DialogHeader>
          {triggers.length > 1 ? (
            <div className="space-y-2">
              <Label htmlFor="workflow-run-now-trigger">Trigger</Label>
              <Select onValueChange={setTriggerId} value={triggerId}>
                <SelectTrigger className="w-full" id="workflow-run-now-trigger">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {triggers.map((item, index) => (
                    <SelectItem key={item.trigger.id} value={item.trigger.id}>
                      {`${index + 1}. ${item.displayName}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="workflow-run-now-input">
              {selected?.manualRun.label ?? "Item"}
            </Label>
            <Textarea
              aria-describedby={error ? "workflow-run-now-error" : undefined}
              aria-invalid={error ? true : undefined}
              className="font-mono text-sm"
              id="workflow-run-now-input"
              maxLength={RUN_NOW_INPUT_MAX}
              onChange={(event) => setInput(event.target.value)}
              placeholder={selected?.manualRun.placeholder}
              rows={3}
              value={input}
            />
            {error ? (
              <p
                className="text-destructive text-sm"
                id="workflow-run-now-error"
              >
                {error}
              </p>
            ) : null}
          </div>
          <MutationErrorMessage
            error={startRun.error}
            title={WorkflowMutationErrorTitle.StartRun}
          />
          <DialogFooter>
            <Button
              disabled={startRun.isPending}
              onClick={onClose}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={startRun.isPending} type="submit">
              {startRun.isPending ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : null}
              Start run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
