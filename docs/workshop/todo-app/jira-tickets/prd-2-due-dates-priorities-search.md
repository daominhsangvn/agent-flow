# Due dates, priorities, sorting and search

## Summary

Extend the Todo App (PRD "Todo list: add, complete, edit, delete and
filter", already on `main`) so people can plan their tasks: an optional due
date, a priority, sorting by either, and a search box. Todos saved by the
first version must still load, with the new fields at their defaults.

## Users and goal

The same person, now with more tasks than fit on one screen. They want to see
what is late or important first and to find a task by a word in it.

## Functional requirements

### FR-1 Due date

- When adding a todo, an optional date field next to the text field ("Due
  date"). Editing a todo (FR-4 of the first PRD) also edits its due date;
  the date can be cleared.
- A todo with a due date shows it after its text: "Today", "Tomorrow",
  "Yesterday", else the date as "Mon 20 Oct" (weekday, day, short month; the
  year only when it is not the current year: "Wed 20 Oct 2027").
- An active todo whose due date is before today is overdue: the date is shown
  in red with the word "Overdue" before it. Completed todos are never
  overdue. "Today" is the device's local date.

### FR-2 Priority

- Three priorities: High, Normal (default), Low. A select next to the text
  field when adding; editing a todo also edits its priority.
- High shows a red "High" badge before the text, Low a grey "Low" badge,
  Normal no badge.

### FR-3 Sorting

- A "Sort by" select above the list: "Created" (default: the order of the
  first version), "Due date", "Priority".
- Due date: earliest first; todos without a due date last; ties in "Created"
  order.
- Priority: High, Normal, Low; ties by due date as above.
- The choice is kept in localStorage and applies to every filter.

### FR-4 Search

- A search field above the list ("Search todos"). As the user types, the list
  shows only the todos whose text contains the search text, ignoring case and
  accents ("cafe" finds "Café").
- Search combines with the filter (All / Active / Completed) and the sort.
- The footer count stays the number of active todos of the whole list.
- When nothing matches: "No todos match "<search text>"." with a "Clear
  search" button.

### FR-5 Saved todos of the first version

- Todos saved by the first version load with no due date and Normal
  priority. Nothing a user saved is lost.

## Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | today is Wed 15 Oct 2025 | the user adds "Pay rent" due 14 Oct 2025 | it shows "Overdue · Yesterday" in red |
| AC-2 | "Pay rent" overdue | the user completes it | the date is no longer red and "Overdue" disappears |
| AC-3 | an empty list | the user adds "Call mum" with priority High | it shows a red "High" badge |
| AC-4 | "A" due 20 Oct, "B" without date, "C" due 16 Oct | the user sorts by Due date | the order is C, A, B |
| AC-5 | "A" Low, "B" High, "C" Normal | the user sorts by Priority | the order is B, C, A |
| AC-6 | sort "Priority" chosen | the user reloads the page | the sort is still "Priority" |
| AC-7 | "Café order", "Buy milk" | the user searches "cafe" | only "Café order" is listed |
| AC-8 | "Buy milk" (active), "Buy bread" (completed) | the user searches "buy" with filter Active | only "Buy milk" is listed; the footer still says "1 item left" |
| AC-9 | no todo contains "xyz" | the user searches "xyz" | the list says No todos match "xyz". and "Clear search" empties the search |
| AC-10 | localStorage holds todos saved by the first version | the page loads | every todo is listed with no due date and Normal priority |
| AC-11 | any list | the user uses only the keyboard | due date, priority, sort and search can all be used |

## Out of scope

- Reminders and notifications.
- Times of day (dates only).
- Recurring todos.
