export type UploadedPlanArtifact = {
  content: string;
  raw?: Record<string, unknown>;
};

export const IMPORTED_PLAN_MARKDOWN_FILE = "imported-plan.md";
export const PLAN_SOURCE_MARKDOWN_FILE = "plan-source.md";

export function isRawPlanArtifact(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toUploadedPlanArtifact(
  plan: unknown
): UploadedPlanArtifact | undefined {
  if (isRawPlanArtifact(plan)) {
    return {
      content:
        typeof plan.content === "string"
          ? plan.content
          : JSON.stringify(plan, null, 2),
      raw: plan,
    };
  }

  if (typeof plan === "string") {
    return { content: plan };
  }

  return undefined;
}

const HTML_ENTITY_RE = /&(amp|lt|gt|quot|#39|#x27);/g;
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
};

/**
 * Whether two texts are the same plan. The API stores documents through an
 * HTML sanitizer that entity-encodes `&`, `<` and `>` in prose
 * (`## API &amp; Data Impacts`), so the hosted plan can differ from the
 * plan.json it was made from by those encodings alone.
 */
export function isSamePlan(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (a == null || b == null) {
    return false;
  }
  return a === b || decodeBasicEntities(a) === decodeBasicEntities(b);
}

function decodeBasicEntities(value: string): string {
  return value.replaceAll(
    HTML_ENTITY_RE,
    (_match, name: string) => HTML_ENTITIES[name] ?? _match
  );
}
