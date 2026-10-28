export const PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS = [];

export const PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS = [];

export const PREVIEW_SKIP_OPT_OUT_MARKER = "preview-skip: no";

const SQL_LINE_COMMENT_REGEX = /--[^\n]*/g;
const SQL_BLOCK_COMMENT_REGEX = /\/\*[\s\S]*?\*\//g;
const CREATE_INDEX_CONCURRENTLY_REGEX = /create\s+index\s+concurrently/i;
const NON_INDEX_ONLY_DDL_REGEX =
  /\b(?:create\s+unique\s+index|create\s+table|alter\s+table|drop\s+table|drop\s+index|alter\s+index|create\s+type|alter\s+type|drop\s+type|create\s+trigger|create\s+(?:or\s+replace\s+)?function|create\s+(?:materialized\s+)?view|create\s+schema|create\s+sequence|add\s+constraint|insert\s+into|update|delete\s+from)\b/i;
const ANY_CONCURRENT_INDEX_BUILD_REGEX =
  /create\s+(?:unique\s+)?index\s+concurrently/i;

export function isPreviewSkippableConcurrentIndexSql(sql) {
  const code = stripSqlComments(sql);
  if (!CREATE_INDEX_CONCURRENTLY_REGEX.test(code)) {
    return false;
  }
  return !NON_INDEX_ONLY_DDL_REGEX.test(code);
}

export function containsConcurrentIndexBuild(sql) {
  return ANY_CONCURRENT_INDEX_BUILD_REGEX.test(stripSqlComments(sql));
}

function stripSqlComments(sql) {
  return sql
    .replace(SQL_BLOCK_COMMENT_REGEX, " ")
    .replace(SQL_LINE_COMMENT_REGEX, " ");
}
