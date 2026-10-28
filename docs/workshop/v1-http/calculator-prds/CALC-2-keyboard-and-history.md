# CALC-2: Keyboard input and calculation history

## Summary

Make the calculator faster to use: type calculations on the keyboard and see
the calculations made so far, reusing any earlier result with one click. The
history survives a page reload.

Builds on CALC-1 (basic calculator), which is on `main`. Keep its behaviour
and its tests unchanged.

## Users and goal

People who do several calculations in a row. They want to type instead of
clicking, and to look back at what they computed.

## Functional requirements

### FR-1 Keyboard input

Keys act exactly like clicking the matching on-screen button:

| Keyboard key | Button |
|---|---|
| `0`–`9` (main row and numpad) | the digit |
| `.` and `,` | `.` |
| `+` | `+` |
| `-` | `−` |
| `*` and `x` | `×` |
| `/` | `÷` |
| `Enter` and `=` | `=` |
| `Backspace` | `⌫` |
| `Escape` and `Delete` | `C` |

- The matching button shows its pressed style for about 150 ms, so keyboard
  users see what was registered.
- Keys pressed while focus is in an input or textarea, or with Ctrl, Alt or
  Meta held, are not handled by the calculator (browser shortcuts keep
  working). `/` must not open the browser's quick find.

### FR-2 History list

- Every calculation completed with `=` is added to a **History** panel as
  `<expression> = <result>`, for example `12 + 7 = 19` or `2 + 3 × 4 = 20`,
  using the same operator symbols and number formatting as the display.
- Newest first, at most 20 entries (the oldest one is dropped).
- A calculation that ends in an error (`Cannot divide by zero`) is not added.
- With no entries the panel shows `No calculations yet`.

### FR-3 Reusing a result

- Clicking an entry (or pressing Enter on it when focused) puts its result in
  the display as a new calculation, as if it had been typed.

### FR-4 Clearing the history

- A `Clear history` button empties the list. It is disabled when the list is
  empty. `C` does not touch the history.

### FR-5 Persistence

- The history is stored in `localStorage` under `calculator.history.v1` and
  restored when the page loads.
- Missing, unreadable or invalid stored data is treated as an empty history:
  the app never crashes because of it.

### FR-6 Layout

- From 768 px wide, the history sits to the right of the keypad; below that it
  sits under the keypad. Long lists scroll inside the panel.

## Non-functional requirements

- Keyboard mapping and history rules live in pure TypeScript under
  `src/calculator/` with unit tests; components only wire them up.
- Component tests drive the app with `user-event` keyboard input.
- `npm run build` and `npm test` pass; all CALC-1 tests still pass.

## Acceptance criteria

| # | Steps | Expected |
|---|---|---|
| AC-1 | Type `12+7` then `Enter` | Display `19`; history first entry `12 + 7 = 19` |
| AC-2 | Type `9/3=` | Display `3`; `/` did not open quick find |
| AC-3 | Type `5*2` then `Backspace` then `3=` | Display `15` |
| AC-4 | Type `8+2` then `Escape` | Display `0`, nothing pending, history unchanged |
| AC-5 | Make 21 calculations | History holds the 20 newest |
| AC-6 | `9 ÷ 0 =` | Error shown; history unchanged |
| AC-7 | Click the entry `12 + 7 = 19`, then `+ 1 =` | Display `20` |
| AC-8 | Reload the page | History is still there |
| AC-9 | Put `not json` in `calculator.history.v1`, reload | App loads with `No calculations yet` |
| AC-10 | Click `Clear history` | `No calculations yet`; button disabled |

## Out of scope

Memory keys, percent, sign change, square root and themes (CALC-3); editing or
deleting single history entries; syncing history between devices.
