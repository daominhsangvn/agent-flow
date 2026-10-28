import {
  LOOP_STEP_ATTACH_FILES_MAX,
  LOOP_STEP_FILE_BYTES_MAX,
  LOOP_STEP_INPUTS_MAX,
  LOOP_STEP_INPUTS_TOTAL_BYTES_MAX,
  LOOP_STEP_WORK_DIR,
  type LoopStepInputFile,
  type LoopStepResult,
} from "@agentflow-ai/loops-api/loop-step";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { z } from "zod";
import { getLoopAttachment, getLoopPrefix } from "@/lib/loops/loop-state";
import {
  readTaskResult,
  type TaskFile,
  type TaskInputFile,
} from "./task-result";

/**
 * Files an orchestrator task leaves (its command's `attach` globs, collected
 * by the runner and stored by the upload route) and hands to a later task
 * (`task_run files`, written to its `inputs/` directory).
 */

const DOTS_ONLY_RE = /^\.{0,2}$/;
const NOT_STORED = "not stored";
const WORK_DIR_PREFIX = `${LOOP_STEP_WORK_DIR}/`;

/** A file of an earlier task of the case, as `task_run files` and `reply attachments` name it. */
export const taskFileRefSchema = z.object({
  taskId: z.uuid(),
  name: z.string().trim().min(1).max(500),
});
export type TaskFileRef = z.infer<typeof taskFileRefSchema>;

type CaseTaskFile = TaskFile & { taskId: string; storageKey: string };

/** The files a finished step collected, named relative to the task's work dir. */
export function taskFilesFromStep(result: LoopStepResult | null): {
  files: TaskFile[];
  filesOmitted: number;
} {
  const files = (result?.attachments ?? []).map((attachment) => ({
    name: attachment.path.startsWith(WORK_DIR_PREFIX)
      ? attachment.path.slice(WORK_DIR_PREFIX.length)
      : attachment.path,
    size: attachment.size,
    storageKey: attachment.storageKey ?? null,
    skipped: attachment.skipped ?? (attachment.storageKey ? null : NOT_STORED),
  }));
  return { files, filesOmitted: result?.attachmentsOmitted ?? 0 };
}

/** The referenced files, each stored and from a task of this case. */
export async function findCaseTaskFiles(
  caseId: string,
  refs: TaskFileRef[]
): Promise<Result<CaseTaskFile[], string>> {
  const ids = [...new Set(refs.map((ref) => ref.taskId))];
  const tasks = await withDb((db) =>
    db.orchestratorTask.findMany({
      where: { id: { in: ids }, caseId },
      select: { id: true, result: true, organizationId: true, loopId: true },
    })
  );
  const found: CaseTaskFile[] = [];
  for (const ref of refs) {
    const task = tasks.find((candidate) => candidate.id === ref.taskId);
    if (!task) {
      return Result.err(`Task ${ref.taskId} is not a task of this case.`);
    }
    const files = readTaskResult(task.result)?.files ?? [];
    const file = files.find((candidate) => candidate.name === ref.name);
    if (!file) {
      const names = files.map((candidate) => candidate.name).join(", ");
      return Result.err(
        `Task ${ref.taskId} has no file "${ref.name}" (its files: ${names || "none"}).`
      );
    }
    if (!file.storageKey) {
      return Result.err(
        `File "${ref.name}" of task ${ref.taskId} was not collected: ${file.skipped ?? NOT_STORED}.`
      );
    }
    if (
      !(
        task.loopId &&
        file.storageKey.startsWith(
          getLoopPrefix(task.organizationId, task.loopId)
        )
      )
    ) {
      return Result.err(
        `File "${ref.name}" of task ${ref.taskId} is not stored with that task.`
      );
    }
    found.push({ ...file, taskId: ref.taskId, storageKey: file.storageKey });
  }
  return Result.ok(found);
}

/** Checks the files can be handed to a task as inputs: stored text within the limits. */
export async function resolveTaskInputs(
  caseId: string,
  refs: TaskFileRef[]
): Promise<Result<TaskInputFile[], string>> {
  if (refs.length > LOOP_STEP_INPUTS_MAX) {
    return Result.err(
      `A task takes at most ${LOOP_STEP_INPUTS_MAX} files from earlier tasks.`
    );
  }
  const found = await findCaseTaskFiles(caseId, refs);
  if (!found.ok) {
    return found;
  }
  const inputs: TaskInputFile[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const file of found.value) {
    const name = inputFileName(file.name);
    if (names.has(name)) {
      return Result.err(
        `Two files would be named "${name}" in the task's inputs.`
      );
    }
    names.add(name);
    const content = await readInputText(file);
    if (!content.ok) {
      return content;
    }
    total += content.value.bytes;
    if (total > LOOP_STEP_INPUTS_TOTAL_BYTES_MAX) {
      return Result.err(
        `The files are too large to hand to a task: ${LOOP_STEP_INPUTS_TOTAL_BYTES_MAX} bytes at most together.`
      );
    }
    inputs.push({
      taskId: file.taskId,
      name: file.name,
      storageKey: file.storageKey,
      size: content.value.bytes,
    });
  }
  return Result.ok(inputs);
}

/** Reads the stored input files again, as the step's `inputs`. */
export async function loadTaskInputs(
  inputs: TaskInputFile[]
): Promise<Result<LoopStepInputFile[], string>> {
  const loaded: LoopStepInputFile[] = [];
  for (const input of inputs) {
    const content = await readInputText(input);
    if (!content.ok) {
      return Result.err(
        `The input file "${input.name}" of task ${input.taskId} can no longer be read.`
      );
    }
    loaded.push({
      name: inputFileName(input.name),
      content: content.value.text,
    });
  }
  return Result.ok(loaded);
}

/** The POSIX basename with every character outside `[\w.-]` replaced by `_`. */
export function inputFileName(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const cleaned = base.replaceAll(/[^\w.-]/g, "_");
  return DOTS_ONLY_RE.test(cleaned) ? "file" : cleaned.slice(0, 200);
}

async function readInputText(file: {
  name: string;
  storageKey: string;
  size: number;
}): Promise<Result<{ text: string; bytes: number }, string>> {
  if (file.size > LOOP_STEP_FILE_BYTES_MAX) {
    return Result.err(
      `"${file.name}" is too large to hand to a task: ${LOOP_STEP_FILE_BYTES_MAX} bytes at most.`
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await getLoopAttachment(file.storageKey);
  } catch {
    return Result.err(`"${file.name}" can no longer be read from storage.`);
  }
  if (bytes.byteLength > LOOP_STEP_FILE_BYTES_MAX) {
    return Result.err(
      `"${file.name}" is too large to hand to a task: ${LOOP_STEP_FILE_BYTES_MAX} bytes at most.`
    );
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Result.ok({ text, bytes: bytes.byteLength });
  } catch {
    return Result.err(
      `"${file.name}" is not a text file: only text files can be handed to a task.`
    );
  }
}

/** One line listing a task's files with sizes and why some were not collected, or null when there are none. */
export function describeTaskFiles(
  files: TaskFile[],
  omitted: number
): string | null {
  if (files.length === 0 && omitted <= 0) {
    return null;
  }
  const parts = files.map((file) => {
    const note = file.skipped
      ? `not collected: ${file.skipped}`
      : formatFileSize(file.size);
    return `${file.name} (${note})`;
  });
  const more =
    omitted > 0
      ? ` and ${omitted} more not collected (over ${LOOP_STEP_ATTACH_FILES_MAX} files)`
      : "";
  return `Files: ${parts.join(", ")}${more}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
