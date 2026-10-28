/** The provider part of a case source key ("jira:LD-5" -> "jira"), or null. */
export function caseSourceProvider(sourceKey: string | null): string | null {
  if (!sourceKey) {
    return null;
  }
  const colon = sourceKey.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  return sourceKey.slice(0, colon);
}
