# Todo list: add, complete, edit, delete and filter

## Summary

Build the first version of the Todo App: a to-do list in the browser that
keeps its items between visits. The repository has no app code yet (only
documentation such as `README.md`), so this PRD also sets the app up
(React + TypeScript + Vite, tests). A later PRD adds due dates, priorities
and search to this app.

## Users and goal

One person managing their own tasks on one device. They want to write a task
down in a second, tick it off when it is done, and see what is left. No
account, no server: the list lives in the browser.

## Functional requirements

### FR-1 App setup

- A Vite + React + TypeScript (strict) app at the repository root.
- npm scripts: `dev`, `build` (type check, then production build), `test`
  (Vitest, runs once), `typecheck`.
- Vitest with jsdom, @testing-library/react and @testing-library/user-event.
- `README.md` explains what the app does and how to install, run, build and
  test it. Keep the sections it already has (for example Contributing).

### FR-2 Adding a todo

- A text field with the placeholder "What needs to be done?" and an "Add"
  button at the top of the page.
- Enter in the field, or the Add button, adds the text as a new active todo
  and empties the field.
- Leading and trailing spaces are removed. Empty text (also only spaces) adds
  nothing.
- A todo has at most 200 characters; the field does not accept more.

### FR-3 Completing a todo

- Each todo has a checkbox. Checking it marks the todo completed: its text is
  struck through and dimmed. Unchecking makes it active again.
- A "Mark all as completed" checkbox above the list completes every todo;
  when all todos are completed, unchecking it makes them all active.

### FR-4 Editing a todo

- Double-clicking a todo's text, or its "Edit" button, turns the text into a
  field with the current text selected.
- Enter or leaving the field saves the trimmed text. Escape cancels and keeps
  the old text.
- Saving empty text deletes the todo.

### FR-5 Deleting a todo

- Each todo has a "Delete" button (visible on hover and on keyboard focus,
  always visible on touch screens). It deletes the todo at once, without a
  confirmation.

### FR-6 Filtering and the footer

- Three filters below the list: All (default), Active, Completed. The chosen
  filter is highlighted and kept in the URL hash (`#/`, `#/active`,
  `#/completed`), so a reload or a shared link shows the same filter.
- The footer shows the number of active todos: "1 item left" or "N items
  left" (also "0 items left").
- "Clear completed" deletes every completed todo. It is shown only when at
  least one todo is completed.
- The footer and the filters are hidden while the list is empty.

### FR-7 Keeping the list

- The todos (text, completed, creation time) are kept in the browser's
  localStorage and are back after a reload.

### FR-8 Accessibility

- Every control has an accessible name ("Add", "Delete: Buy milk",
  "Edit: Buy milk", "Mark all as completed").
- Everything works with the keyboard alone: Tab to every control, Space on
  checkboxes, Enter and Escape in fields.
- The list is a `<ul>`; the number of items left is announced politely
  (`aria-live="polite"`).

## Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | an empty list | the user types "Buy milk" and presses Enter | the list shows "Buy milk" (active), the field is empty, the footer says "1 item left" |
| AC-2 | an empty list | the user types three spaces and presses Enter | nothing is added |
| AC-3 | "Buy milk" active | the user checks its checkbox | it is struck through, the footer says "0 items left", "Clear completed" appears |
| AC-4 | "Buy milk" | the user double-clicks it, types "Buy oat milk", presses Enter | the todo reads "Buy oat milk" |
| AC-5 | "Buy milk" being edited | the user clears the text and presses Enter | the todo is deleted |
| AC-6 | "Buy milk" being edited | the user types "x" and presses Escape | the todo still reads "Buy milk" |
| AC-7 | "A" active, "B" completed | the user picks Active | only "A" is listed; the URL ends with `#/active` |
| AC-8 | "A" active, "B" completed | the user clicks "Clear completed" | only "A" remains, "Clear completed" disappears |
| AC-9 | two todos, one completed | the user reloads the page | both todos are back with their state |
| AC-10 | three active todos | the user checks "Mark all as completed" | all three are completed, "0 items left" |
| AC-11 | any list | the user uses only the keyboard | every action of AC-1 to AC-10 can be done |
| AC-12 | a 360 px wide screen | the page loads | nothing scrolls sideways, every button can be tapped |

## Out of scope

- Due dates, priorities, sorting and search (next PRD).
- Accounts, sync between devices, sharing.
- Reordering by drag and drop.
- Undo.
