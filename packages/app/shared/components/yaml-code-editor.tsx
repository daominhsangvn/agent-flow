"use client";

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  completionKeymap,
  snippetCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import {
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { type Diagnostic, linter, lintGutter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import {
  type YamlCompletion,
  YamlCompletionKind,
  type YamlCompletionResult,
} from "../lib/yaml-completion";
import type { YamlProblem } from "../lib/yaml-problems";

export type YamlCodeEditorProps = {
  value: string;
  onChange: (text: string) => void;
  /** Suggestions at `pos` of `text`; read on every popup. */
  complete: (text: string, pos: number) => YamlCompletionResult | null;
  /** Problems of `text`, underlined as you type. */
  lint: (text: string) => readonly YamlProblem[];
  /** Accessible name of the editable content. */
  ariaLabel: string;
  /** `<testIdPrefix>-editor` on the frame, `<testIdPrefix>-content` on the content. */
  testIdPrefix: string;
  readOnly?: boolean;
  /** Height of the empty editor, e.g. `18rem`. */
  minHeight?: string;
};

/**
 * YAML in a code editor: syntax colors, line numbers, the suggestion popup
 * (what `complete` offers; Ctrl+Space opens it anywhere, a new line or a
 * fresh "- " item opens it on its own) and the problems `lint` finds,
 * underlined as you type. The editor owns its text; `value` replaces it only
 * when it changes from outside (a preset, a restored version, a reset).
 */
export function YamlCodeEditor({
  value,
  onChange,
  complete,
  lint,
  ariaLabel,
  testIdPrefix,
  readOnly = false,
  minHeight = DEFAULT_MIN_HEIGHT,
}: Readonly<YamlCodeEditorProps>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const completeRef = useRef(complete);
  completeRef.current = complete;
  const lintRef = useRef(lint);
  lintRef.current = lint;
  const initialValue = useRef(value);
  const settings = useRef({ ariaLabel, testIdPrefix, minHeight });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: viewRef.current?.state.doc.toString() ?? initialValue.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          indentUnit.of("  "),
          EditorState.tabSize.of(2),
          yaml(),
          syntaxHighlighting(YAML_HIGHLIGHT),
          autocompletion({
            override: [
              (context) => completionSource(context, completeRef.current),
            ],
            activateOnTyping: true,
            icons: false,
          }),
          linter(
            (editor) =>
              diagnosticsOf(editor.state.doc.toString(), lintRef.current),
            { delay: 250 }
          ),
          lintGutter(),
          keymap.of([
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({
            "aria-label": settings.current.ariaLabel,
            "data-testid": `${settings.current.testIdPrefix}-content`,
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
            // A new line, a fresh "- " list item or a "key: " waiting for its
            // value: show what fits there (after this update: an update
            // cannot start another one).
            if (update.docChanged && insertedLineStart(update.state)) {
              setTimeout(() => startCompletion(update.view), 0);
            }
          }),
          editorTheme(settings.current.minHeight),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
    };
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      className="overflow-hidden rounded-md border"
      data-testid={`${testIdPrefix}-editor`}
      ref={hostRef}
    />
  );
}

function completionSource(
  context: CompletionContext,
  complete: YamlCodeEditorProps["complete"]
): CompletionResult | null {
  const result = complete(context.state.doc.toString(), context.pos);
  if (!result || result.options.length === 0) {
    return null;
  }
  return {
    from: result.from,
    options: result.options.map(toCodeMirrorCompletion),
    validFor: result.variable ? VARIABLE_WORD_RE : WORD_RE,
  };
}

function toCodeMirrorCompletion(completion: YamlCompletion): Completion {
  const base: Completion = {
    label: completion.label,
    detail: completion.detail,
    info: completion.info,
    type: completion.kind,
    boost: completion.kind === YamlCompletionKind.Snippet ? 10 : 0,
  };
  if (completion.kind === YamlCompletionKind.Snippet) {
    return snippetCompletion(completion.insert, base);
  }
  return { ...base, apply: indentedApply(completion.insert) };
}

/** Inserts `insert`, indenting its later lines like the line it lands on. */
function indentedApply(insert: string): Completion["apply"] {
  if (!insert.includes("\n")) {
    return insert;
  }
  return (view, _completion, from, to) => {
    const line = view.state.doc.lineAt(from);
    const lineIndent = LEADING_SPACE_RE.exec(line.text)?.[0] ?? "";
    const itemIndent = ITEM_PREFIX_RE.exec(line.text) ? "  " : "";
    const text = insert.replaceAll("\n", `\n${lineIndent}${itemIndent}`);
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
  };
}

function diagnosticsOf(
  text: string,
  lint: YamlCodeEditorProps["lint"]
): Diagnostic[] {
  return lint(text).map((problem) => ({
    from: Math.min(problem.from, text.length),
    to: Math.min(problem.to, text.length),
    severity: problem.severity,
    message: problem.message,
  }));
}

/** The cursor sits at the start of a fresh line, right after "- " or after "key: ". */
function insertedLineStart(state: EditorState): boolean {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from);
  return FRESH_LINE_RE.test(before) && before.length > 0;
}

const DEFAULT_MIN_HEIGHT = "18rem";
const WORD_RE = /^[\w./@-]*$/;
const VARIABLE_WORD_RE = /^[\w.]*$/;
const LEADING_SPACE_RE = /^\s*/;
const ITEM_PREFIX_RE = /^\s*-\s/;
const FRESH_LINE_RE = /^\s+$|^\s*-\s$|^\s*(?:-\s+)?[A-Za-z][\w-]*:\s$/;

function editorTheme(minHeight: string) {
  return EditorView.theme({
    "&": {
      fontSize: "13px",
      backgroundColor: "var(--background)",
      color: "var(--foreground)",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      minHeight,
      caretColor: "var(--foreground)",
    },
    ".cm-scroller": { maxHeight: "36rem", overflow: "auto" },
    "&.cm-focused": {
      outline: "2px solid var(--ring)",
      outlineOffset: "-1px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--muted)",
      color: "var(--muted-foreground)",
      borderRight: "1px solid var(--border)",
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "color-mix(in srgb, var(--accent) 45%, transparent)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--popover)",
      color: "var(--popover-foreground)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--accent)",
      color: "var(--accent-foreground)",
    },
    ".cm-completionDetail": {
      color: "var(--muted-foreground)",
      fontStyle: "normal",
      marginLeft: "0.75em",
    },
    ".cm-completionInfo": { maxWidth: "24rem", padding: "6px 8px" },
    ".cm-diagnostic-error": { borderLeftColor: "var(--destructive)" },
    ".cm-diagnostic-warning": { borderLeftColor: "var(--warning)" },
  });
}

/**
 * Token colours from the design system's text tokens, so keys, comments and
 * strings stay readable on the light and the dark background alike
 * (CodeMirror's default style is made for a light one).
 */
const YAML_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.definition(tags.propertyName), color: "var(--link)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: tags.separator, color: "var(--muted-foreground)" },
  { tag: tags.string, color: "var(--success-foreground)" },
  { tag: tags.special(tags.string), color: "var(--warning-foreground)" },
  {
    tag: [tags.labelName, tags.typeName, tags.keyword, tags.meta],
    color: "var(--ai-foreground)",
  },
  { tag: tags.invalid, color: "var(--destructive)" },
]);
