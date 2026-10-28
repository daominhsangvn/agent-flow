# Add an EditorConfig file and a contributing guide

The repository only has a `README.md`. Before the app is built, add the files
that keep everyone's changes consistent:

- `.editorconfig` at the repository root: UTF-8, LF line endings, a final
  newline, trimmed trailing whitespace, 2-space indentation; Markdown keeps
  trailing whitespace (hard line breaks).
- `CONTRIBUTING.md`: how to propose a change (a branch per Jira issue, named
  after the issue key, e.g. `TODO-12-short-title`), that every pull request
  needs one approving review, and that commit messages start with the issue
  key.
- A "Contributing" section at the end of `README.md` that links to
  `CONTRIBUTING.md`.

No application code, no package files.
