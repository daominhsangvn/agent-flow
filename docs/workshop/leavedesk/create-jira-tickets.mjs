#!/usr/bin/env node
// Creates the LeaveDesk tickets in Jira from tickets/F*.md, as Stories in the
// project LD, WITHOUT labels or assignee: nothing starts until you add the
// label and assign the bot yourself.
//
//   JIRA_SITE=https://<site>.atlassian.net JIRA_EMAIL=<you> JIRA_TOKEN=<api token> \
//     node create-jira-tickets.mjs [--project LD] [--only F01,F02] [--dry-run]
//
// Uses your own account (not a bot): the tickets are created by a person, so
// the bots react to them. Prints "F01 → LD-1" per ticket.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const project = option("--project", "LD");
const only = option("--only", "")?.split(",").filter(Boolean) ?? [];
const dryRun = args.includes("--dry-run");
const { JIRA_SITE, JIRA_EMAIL, JIRA_TOKEN } = process.env;
if (!dryRun && !(JIRA_SITE && JIRA_EMAIL && JIRA_TOKEN)) {
  console.error("Set JIRA_SITE, JIRA_EMAIL and JIRA_TOKEN (or use --dry-run).");
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "tickets");
const files = readdirSync(dir)
  .filter((name) => /^F\d+-.*\.md$/.test(name))
  .filter((name) => only.length === 0 || only.includes(name.slice(0, 3)))
  .sort();

for (const file of files) {
  const text = readFileSync(join(dir, file), "utf8");
  const summary = /\| Summary \| (.+?) \|/.exec(text)?.[1];
  const description = text.split(/^## Description\s*$/m)[1]?.trim();
  if (!(summary && description)) {
    console.error(`${file}: no Summary row or Description section`);
    process.exit(1);
  }
  const fields = {
    project: { key: project },
    issuetype: { name: "Story" },
    summary,
    description: toWiki(description),
  };
  if (dryRun) {
    console.log(`--- ${file}\n${fields.summary}\n\n${fields.description}\n`);
    continue;
  }
  const res = await fetch(`${JIRA_SITE.replace(/\/$/, "")}/rest/api/2/issue`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${file}: ${res.status} ${JSON.stringify(body.errors ?? body)}`);
    process.exit(1);
  }
  console.log(`${file.slice(0, 3)} → ${body.key}`);
}

/** The few markdown forms the tickets use, as Jira wiki markup, paragraphs unwrapped. */
function toWiki(markdown) {
  const lines = [];
  for (const line of markdown.split("\n")) {
    const previous = lines.at(-1);
    const continues = previous && line.trim() && !/^\s*- /.test(line) && /^\s+\S/.test(line) === false;
    if (continues && !/^\s*$/.test(previous)) {
      lines[lines.length - 1] = `${previous} ${line.trim()}`;
    } else if (previous && /^\s{2,}\S/.test(line) && /^\s*[-*] /.test(previous)) {
      lines[lines.length - 1] = `${previous} ${line.trim()}`;
    } else {
      lines.push(line);
    }
  }
  return lines
    .map((line) =>
      line
        .replace(/^(\s*)- /, (_, indent) => `${"*".repeat(indent.length / 2 + 1)} `)
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/`([^`]+)`/g, "{{$1}}")
    )
    .join("\n");
}
