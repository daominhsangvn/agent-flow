import { LOOP_STEP_INPUTS_MAX } from "@agentflow-ai/loops-api/loop-step";
import type { IntegrationToolDescriptor } from "@repo/api/src/types/integration-tools";
import {
  OrchestratorToolName,
  OrchestratorWaitKind,
} from "@repo/api/src/types/orchestrator";
import { RunnerCommandMode } from "@repo/api/src/types/runner-capabilities";
import {
  KEEPS,
  NO_ARGUMENTS,
  POSTS,
  READS,
  STOPS,
  TASK_FILE_REF,
} from "./annotations";
import { REPLY_ATTACHMENTS_MAX } from "./attachments";
import {
  NOTES_MAX,
  REPLY_MAX,
  TASK_PROMPT_MAX,
  WAIT_TASKS_MAX,
  WAIT_TIMEOUT_MAX_MINUTES,
} from "./limits";

export const INSTRUCTIONS =
  "Tools of the project orchestrator for one turn of one conversation. reply posts in the conversation's thread; case_get and case_update_notes read and keep the case; runners_list shows what each runner can do; source_item_get reads the conversation's item; task_run sends a runner one of its commands, task_get reads a task and task_cancel stops one, only in a turn that handles a ticket change the workflow's cancelOn lists. A task's files come back with its result; reply attaches them (attachments) and task_run hands them to a later task (files). End the turn with wait_for (the tasks you started), wait_human or close_case. A write refused as superseded means a newer message arrived: end the turn with wait_human and a one-line note; the next turn answers both. Refused calls are recorded on the case.";

export const TOOLS: IntegrationToolDescriptor[] = [
  {
    name: OrchestratorToolName.CaseGet,
    title: "Read the case",
    description:
      "The case as AgentFlow records it (CASE.md): its notes, conversations with their latest messages, tasks and decisions.",
    inputSchema: NO_ARGUMENTS,
    annotations: READS,
  },
  {
    name: OrchestratorToolName.CaseUpdateNotes,
    title: "Save the case's notes",
    description:
      "Replaces the case's notes: what later turns must know (decisions, open questions, who was asked what). Read them with case_get first and keep what still holds.",
    inputSchema: {
      type: "object",
      properties: { notes: { type: "string", maxLength: NOTES_MAX } },
      required: ["notes"],
      additionalProperties: false,
    },
    annotations: KEEPS,
  },
  {
    name: OrchestratorToolName.RunnersList,
    title: "List the runners",
    description:
      "Each runner of the project with its AGENTFLOW.md: the commands it declares (mode read or write, what each produces and needs), its skills and whether it is online.",
    inputSchema: NO_ARGUMENTS,
    annotations: READS,
  },
  {
    name: OrchestratorToolName.SourceItemGet,
    title: "Read the item",
    description:
      "The conversation's source item (the ticket, the Teams thread): title, status, description, latest comments, attachment names.",
    inputSchema: NO_ARGUMENTS,
    annotations: READS,
  },
  {
    name: OrchestratorToolName.Reply,
    title: "Reply in the thread",
    description:
      "Posts a markdown message in this conversation's thread (a comment on the ticket, a Teams reply). A reply to it comes back to this conversation. replyTo: the ref of the <message> you answer, so the answer lands in that comment's thread (answer each comment in its own thread; omit it for a ticket change, which is answered with a new comment). attachments: files of this case's tasks (task_get, wait results) to attach to the item first and show under the message (Jira); refused where the thread takes no files (Teams).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: REPLY_MAX },
        replyTo: { type: "string", minLength: 1, maxLength: 255 },
        attachments: {
          type: "array",
          maxItems: REPLY_ATTACHMENTS_MAX,
          items: TASK_FILE_REF,
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: POSTS,
  },
  {
    name: OrchestratorToolName.TaskRun,
    title: "Run a command on a runner",
    description:
      "Starts one of a runner's declared commands as a task (runners_list). The runner works on the case in its own workspace; the task's answer, questions and files come back when it ends (wait_for). A task resumes an earlier task's session on the same runner with resumeTaskId (fork: in a copy, leaving that session as it was), e.g. to answer the questions it asked or to ask about its plan. It is refused when the runner does not declare the command, when write mode is asked for a read command, or when a file the command needs (its needs, produced by another command's attach) is neither in files nor attached to the ticket.",
    inputSchema: {
      type: "object",
      properties: {
        runner: { type: "string", description: "The runner's name." },
        command: {
          type: "string",
          description:
            "A slash command the runner declares, e.g. /writing-plans.",
        },
        args: {
          type: "string",
          description: "Its arguments, e.g. the ticket key.",
        },
        prompt: {
          type: "string",
          maxLength: TASK_PROMPT_MAX,
          description:
            "What you want from this task and the context it needs (the request, decisions, earlier answers): the runner sees only this and the case.",
        },
        mode: {
          type: "string",
          enum: Object.values(RunnerCommandMode),
          description:
            "read (changes nothing) or write; default: what the command declares.",
        },
        resumeTaskId: { type: "string" },
        fork: { type: "boolean" },
        files: {
          type: "array",
          maxItems: LOOP_STEP_INPUTS_MAX,
          items: TASK_FILE_REF,
          description:
            "Text files of earlier tasks of this case (e.g. PRD-LD-5.md) the runner finds in its work directory's inputs/.",
        },
        replyTo: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description:
            "The ref of the <message> (comment) this task answers: it comes back with the task's result (task_get, wait results) so the answer goes in that comment's thread with reply replyTo.",
        },
      },
      required: ["runner", "command"],
      additionalProperties: false,
    },
    annotations: POSTS,
  },
  {
    name: OrchestratorToolName.TaskGet,
    title: "Read a task",
    description:
      "A task of this case: its status (queued, running, succeeded, failed, cancelled), its answer, the questions it asks, its error and its files.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: OrchestratorToolName.TaskCancel,
    title: "Cancel a task",
    description:
      "Stops a task that belongs to the status or label the ticket left: a running task's loop is stopped, a queued one never starts, a finished one can no longer be resumed. Only in a turn that handles a ticket change the workflow's cancelOn lists (status_changed, label_removed by default); a comment, question or reply never cancels a task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        reason: { type: "string", maxLength: 500 },
      },
      required: ["taskId", "reason"],
      additionalProperties: false,
    },
    annotations: STOPS,
  },
  {
    name: OrchestratorToolName.WaitFor,
    title: "Wait for tasks",
    description:
      "Ends the turn waiting for tasks: all of them (default) or the first (kind any). A failed task wakes you at once unless wakeOnFailure is false; timeoutMinutes wakes you with where they are.",
    inputSchema: {
      type: "object",
      properties: {
        taskIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: WAIT_TASKS_MAX,
        },
        kind: { type: "string", enum: Object.values(OrchestratorWaitKind) },
        timeoutMinutes: {
          type: "integer",
          minimum: 1,
          maximum: WAIT_TIMEOUT_MAX_MINUTES,
        },
        wakeOnFailure: { type: "boolean" },
      },
      required: ["taskIds"],
      additionalProperties: false,
    },
    annotations: KEEPS,
  },
  {
    name: OrchestratorToolName.RequestDecision,
    title: "Ask people to decide",
    description:
      "Asks for an approval (a plan, a go to implement): posts the question in the thread with the case's link, where an admin approves or rejects. Someone may also answer in the thread: record_decision then. End the turn with wait_human.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 4000 },
      },
      required: ["question"],
      additionalProperties: false,
    },
    annotations: POSTS,
  },
  {
    name: OrchestratorToolName.RecordDecision,
    title: "Record a decision",
    description:
      "Records the decision someone gave in the thread on a pending decision (request_decision): who, approved or not, and what they said.",
    inputSchema: {
      type: "object",
      properties: {
        decisionId: { type: "string" },
        approved: { type: "boolean" },
        decidedBy: { type: "string" },
        comment: { type: "string", maxLength: 4000 },
      },
      required: ["decisionId", "approved", "decidedBy"],
      additionalProperties: false,
    },
    annotations: KEEPS,
  },
  {
    name: OrchestratorToolName.EditReply,
    title: "Edit a posted message",
    description:
      "Replaces the text of a message this conversation posted (its reference from reply), e.g. the summary of a plan once a new version is out; version records which version it shows. It takes no files: post a new reply for a new version of a file.",
    inputSchema: {
      type: "object",
      properties: {
        reference: { type: "string" },
        text: { type: "string", minLength: 1, maxLength: REPLY_MAX },
        version: { type: "integer", minimum: 1 },
      },
      required: ["reference", "text"],
      additionalProperties: false,
    },
    annotations: POSTS,
  },
  {
    name: OrchestratorToolName.WaitHuman,
    title: "Wait for people",
    description:
      "Ends the turn waiting for people: an answer, a decision or the next request wakes the conversation.",
    inputSchema: NO_ARGUMENTS,
    annotations: KEEPS,
  },
  {
    name: OrchestratorToolName.CloseCase,
    title: "Close the case",
    description:
      "Ends the turn and closes the case: the work is done. A new message reopens it.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", maxLength: 2000 } },
      additionalProperties: false,
    },
    annotations: KEEPS,
  },
];
