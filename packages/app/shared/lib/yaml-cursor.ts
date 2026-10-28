/**
 * Where the cursor is in a YAML text being typed: a key or a value, of which
 * mapping (its path of keys, "#" for a list item), and inside which list item.
 * Line based on purpose: the text is mid-edit and rarely parses, while the
 * indentation still says where the cursor is. Shared by the YAML editors
 * (project process, workflow configuration); each adds what fits there.
 */

/** Container path of the cursor: keys, and "#" for a list item. */
export type YamlPath = readonly string[];

export const YamlCursorKind = {
  /** Typing a key of the mapping at `path`. */
  Key: "key",
  /** Typing the value of `key` in the mapping at `path`. */
  Value: "value",
  /** Typing an item of the list of scalars `key` (block or `[a, b]`). */
  Item: "item",
  /** Inside `{{` of a text; `key` is the key the text belongs to. */
  Variable: "variable",
} as const;
export type YamlCursorKind =
  (typeof YamlCursorKind)[keyof typeof YamlCursorKind];

export type YamlCursor = {
  kind: YamlCursorKind;
  path: YamlPath;
  /** The key whose value, item or text is typed. */
  key: string | null;
  /** Offset where the typed word starts (replaced by a suggestion). */
  from: number;
  typed: string;
  /** Keys the mapping already has (not suggested again). */
  existingKeys: readonly string[];
  /** The cursor's line starts a list item ("- "). */
  itemStart: boolean;
  /**
   * `key: value` scalars of the list item (a mapping) the cursor is in, e.g.
   * a step's `type` or a trigger's `connection`; empty outside one.
   */
  itemValues: Readonly<Record<string, string>>;
};

export type YamlCursorOptions = {
  /** Whether `key` (in the mapping at `path`) holds a list of scalars. */
  isScalarList: (path: YamlPath, key: string) => boolean;
};

export function analyzeYamlCursor(
  text: string,
  pos: number,
  options: YamlCursorOptions
): YamlCursor | null {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  const lines = text.split("\n");
  const lineIndex = text.slice(0, lineStart).split("\n").length - 1;
  const infos = lines.map(lineInfo);
  const variable = VARIABLE_RE.exec(before);
  if (variable) {
    return variableCursor(infos, lineIndex, pos, variable[1] ?? "");
  }
  const valueMatch = VALUE_RE.exec(before);
  if (valueMatch) {
    const [, indent = "", dash = "", key = "", typed = ""] = valueMatch;
    const scope = scopeOf(infos, lineIndex, indent.length, dash.length);
    const flow = FLOW_ITEM_RE.exec(typed);
    if (flow) {
      const item = flow[1] ?? "";
      return {
        kind: YamlCursorKind.Item,
        path: scope.path,
        key,
        from: pos - item.length,
        typed: item,
        existingKeys: [],
        itemStart: dash !== "",
        itemValues: itemValuesOf(infos, scope.itemLine),
      };
    }
    return {
      kind: YamlCursorKind.Value,
      path: scope.path,
      key,
      from: pos - typed.length,
      typed,
      existingKeys: scope.keys,
      itemStart: dash !== "",
      itemValues: itemValuesOf(infos, scope.itemLine),
    };
  }
  const keyMatch = KEY_RE.exec(before);
  if (!keyMatch) {
    return null;
  }
  const [, indent = "", dash = "", typed = ""] = keyMatch;
  const scope = scopeOf(infos, lineIndex, indent.length, dash.length);
  const parentPath = scope.path.slice(0, -2);
  const parentKey = scope.path.at(-2) ?? null;
  // "- an" under show: is an item of a list of values, not a key.
  if (dash && parentKey && options.isScalarList(parentPath, parentKey)) {
    return {
      kind: YamlCursorKind.Item,
      path: scope.path,
      key: parentKey,
      from: pos - typed.length,
      typed,
      existingKeys: [],
      itemStart: true,
      itemValues: itemValuesOf(
        infos,
        enclosingItemStart(infos, lineIndex - 1, indent.length)
      ),
    };
  }
  return {
    kind: YamlCursorKind.Key,
    path: scope.path,
    key: null,
    from: pos - typed.length,
    typed,
    existingKeys: scope.keys,
    itemStart: dash !== "",
    itemValues: itemValuesOf(infos, scope.itemLine),
  };
}

/** The line's parts as the scans below read them. */
export type YamlLineInfo = {
  indent: number;
  item: boolean;
  /** Column of the line's key (after "- " for an item start). */
  contentIndent: number;
  key: string | null;
  /** Text after "key:", trimmed ("" for a key that opens a block). */
  value: string;
  blank: boolean;
};

export function lineInfo(line: string): YamlLineInfo {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return {
      indent: 0,
      item: false,
      contentIndent: 0,
      key: null,
      value: "",
      blank: true,
    };
  }
  const match = LINE_RE.exec(line);
  const indent = match?.[1]?.length ?? 0;
  const dash = match?.[2] ?? "";
  return {
    indent,
    item: dash !== "",
    contentIndent: indent + dash.length,
    key: match?.[3] ?? null,
    value: (match?.[4] ?? "").replace(TRAILING_COMMENT_RE, "").trim(),
    blank: false,
  };
}

/** "key:" followed by the cursor's value: `- key: va`, `key: va`. */
const VALUE_RE = /^(\s*)(-\s+)?([A-Za-z][\w-]*):\s+([^\s#][^#]*?|)$/;
/** A key being typed: `  ke`, `- ke`, or an empty line. */
const KEY_RE = /^(\s*)(-\s+)?([A-Za-z][\w-]*|)$/;
const VARIABLE_RE = /\{\{\s*([\w.]*)$/;
/** The item typed in a flow list: `[a, b` → `b`. */
const FLOW_ITEM_RE = /^\[(?:[^\]]*,)?\s*([^,\]\s]*)$/;
const LINE_RE = /^(\s*)(-\s+)?(?:([A-Za-z][\w-]*):(?:\s+|$))?(.*)$/;
const TRAILING_COMMENT_RE = /\s+#.*$/;

type Scope = {
  path: string[];
  /** Keys of the cursor's mapping. */
  keys: string[];
  /** Item start of the list item mapping the cursor is in, if any. */
  itemLine: number | null;
};

/**
 * The containers around a line whose key starts at `indent` (+ the dash):
 * walking up, an item start at the same column opens the mapping, a
 * shallower `key:` opens its parent.
 */
function scopeOf(
  infos: readonly YamlLineInfo[],
  lineIndex: number,
  indent: number,
  dashLength: number
): Scope {
  const itemStart = dashLength > 0;
  const mapLevel = indent + dashLength;
  const climb: Climb = {
    path: itemStart ? ["#"] : [],
    level: itemStart ? indent : mapLevel,
    mapLevel,
    itemLine: itemStart ? lineIndex : null,
  };
  for (let index = lineIndex - 1; index >= 0; index--) {
    const line = infos[index];
    if (line && !climbLine(climb, line, index)) {
      break;
    }
  }
  return {
    path: climb.path,
    keys: mappingKeys(infos, lineIndex, mapLevel, itemStart),
    itemLine: climb.itemLine ?? enclosingItemStart(infos, lineIndex, mapLevel),
  };
}

type Climb = {
  /** Containers found so far, outermost first. */
  path: string[];
  /** Column a line must be left of to contain the ones found so far. */
  level: number;
  /** Column of the cursor's mapping keys. */
  mapLevel: number;
  /** Item start of the cursor's mapping, when it is a list item. */
  itemLine: number | null;
};

/** Takes one line of the upward scan into account; false ends the scan. */
function climbLine(climb: Climb, line: YamlLineInfo, index: number): boolean {
  if (line.blank || !isLeftOf(line, climb.level)) {
    return true;
  }
  if (line.item && line.contentIndent === climb.level) {
    // The item start of the mapping the scan is in.
    climb.path.unshift("#");
    if (climb.itemLine === null && climb.level === climb.mapLevel) {
      climb.itemLine = index;
    }
    climb.level = line.indent;
    return true;
  }
  if (line.key && line.value === "") {
    climb.path.unshift(line.key);
    climb.level = line.contentIndent;
    if (line.item) {
      climb.path.unshift("#");
      climb.level = line.indent;
    }
    return true;
  }
  return false;
}

function isLeftOf(line: YamlLineInfo, level: number): boolean {
  return line.contentIndent < level || (line.item && line.indent < level);
}

/** Keys of the mapping whose keys sit at column `level` around `lineIndex`. */
function mappingKeys(
  infos: readonly YamlLineInfo[],
  lineIndex: number,
  level: number,
  itemStart: boolean
): string[] {
  const above = itemStart ? [] : keysAbove(infos, lineIndex, level);
  return [...above, ...keysBelow(infos, lineIndex, level)];
}

/** Keys of the mapping above the line, up to its item start (included). */
function keysAbove(
  infos: readonly YamlLineInfo[],
  lineIndex: number,
  level: number
): string[] {
  const keys: string[] = [];
  for (let index = lineIndex - 1; index >= 0; index--) {
    const line = infos[index];
    if (!line || line.blank) {
      continue;
    }
    if (line.contentIndent < level) {
      break;
    }
    if (line.contentIndent === level && line.key) {
      keys.push(line.key);
    }
    if (line.item && line.contentIndent === level) {
      break;
    }
  }
  return keys;
}

/** Keys of the mapping below the line, up to the next item of its list. */
function keysBelow(
  infos: readonly YamlLineInfo[],
  lineIndex: number,
  level: number
): string[] {
  const keys: string[] = [];
  for (let index = lineIndex + 1; index < infos.length; index++) {
    const line = infos[index];
    if (!line || line.blank) {
      continue;
    }
    if (endsItem(line, level)) {
      break;
    }
    if (line.contentIndent === level && line.key) {
      keys.push(line.key);
    }
  }
  return keys;
}

/**
 * The item start of the list item mapping a nested line belongs to (e.g. a
 * step, from inside its document): the closest item start above whose keys
 * are not right of `mapLevel`.
 */
function enclosingItemStart(
  infos: readonly YamlLineInfo[],
  lineIndex: number,
  mapLevel: number
): number | null {
  for (let index = lineIndex; index >= 0; index--) {
    const line = infos[index];
    if (line?.item && line.key && line.contentIndent <= mapLevel) {
      return index;
    }
  }
  return null;
}

/** The `key: value` scalars of the list item starting at `start`. */
function itemValuesOf(
  infos: readonly YamlLineInfo[],
  start: number | null
): Record<string, string> {
  const values: Record<string, string> = {};
  if (start === null) {
    return values;
  }
  const itemLevel = infos[start]?.contentIndent ?? 0;
  for (let index = start; index < infos.length; index++) {
    const line = infos[index];
    if (!line || line.blank) {
      continue;
    }
    if (index > start && endsItem(line, itemLevel)) {
      break;
    }
    if (line.contentIndent === itemLevel && line.key && line.value) {
      values[line.key] = unquote(line.value);
    }
  }
  return values;
}

/** The line starts the next item of the list, or leaves it. */
function endsItem(line: YamlLineInfo, itemLevel: number): boolean {
  return (
    line.contentIndent < itemLevel ||
    (line.item && line.contentIndent === itemLevel)
  );
}

/**
 * `{{` typed in a text: the key the text belongs to is the one on the line,
 * or, for a line of a block (`instruction: |`), the closest less indented key
 * above it.
 */
function variableCursor(
  infos: readonly YamlLineInfo[],
  lineIndex: number,
  pos: number,
  typed: string
): YamlCursor {
  const owner = variableOwnerLine(infos, lineIndex);
  const ownerInfo = owner === null ? null : infos[owner];
  const scope =
    owner === null || !ownerInfo
      ? null
      : scopeOf(
          infos,
          owner,
          ownerInfo.indent,
          ownerInfo.contentIndent - ownerInfo.indent
        );
  return {
    kind: YamlCursorKind.Variable,
    path: scope?.path ?? [],
    key: ownerInfo?.key ?? null,
    from: pos - typed.length,
    typed,
    existingKeys: [],
    itemStart: false,
    itemValues: scope ? itemValuesOf(infos, scope.itemLine) : {},
  };
}

function variableOwnerLine(
  infos: readonly YamlLineInfo[],
  lineIndex: number
): number | null {
  const line = infos[lineIndex];
  if (line?.key) {
    return lineIndex;
  }
  const indent = line?.indent ?? 0;
  for (let index = lineIndex - 1; index >= 0; index--) {
    const above = infos[index];
    if (above && !above.blank && above.key && above.contentIndent < indent) {
      return index;
    }
  }
  return null;
}

function unquote(value: string): string {
  const quoted = QUOTED_RE.exec(value);
  return quoted ? (quoted[2] ?? "") : value;
}

const QUOTED_RE = /^(["'])(.*)\1$/;
