# Basic calculator

## Summary

Build the first version of the Calculator web app: a pocket calculator in the
browser with the four basic operations. The repository has no app code yet
(only documentation such as `README.md`), so this PRD also sets the app up
(React + TypeScript + Vite, tests).
Later PRDs (keyboard and history, memory and themes) extend this app.

## Users and goal

Anyone who needs a quick calculation in the browser. They click the on-screen
keys and read the result; the behaviour must match a basic pocket calculator
so it holds no surprises.

## Functional requirements

### FR-1 App setup

- A Vite + React + TypeScript (strict) app at the repository root.
- npm scripts: `dev`, `build` (type check, then production build), `test`
  (Vitest, runs once), `typecheck`.
- Vitest with jsdom, @testing-library/react and @testing-library/user-event.
- `README.md` explains what the app does and how to install, run, build and
  test it. Keep the sections it already has (for example Contributing and
  License).

### FR-2 Layout

- A display at the top: the current entry or result in large text, and above
  it a smaller line with the pending calculation (for example `12 +`).
- A 4-column keypad below it, in this order (`=` is two rows tall, `0` two
  columns wide, so there is no empty cell):

  ```
  ┌───┬───┬───┬───┐
  │ C │ ⌫ │ ÷ │ × │
  ├───┼───┼───┼───┤
  │ 7 │ 8 │ 9 │ − │
  ├───┼───┼───┼───┤
  │ 4 │ 5 │ 6 │ + │
  ├───┼───┼───┼───┤
  │ 1 │ 2 │ 3 │   │
  ├───┴───┼───┤ = │
  │   0   │ . │   │
  └───────┴───┴───┘
  ```

- Usable from a 360 px wide screen up; the keypad never scrolls sideways.

### FR-3 Entering numbers

- A digit is appended to the current entry. The display starts at `0`; a digit
  typed on a lone `0` replaces it (`0`, `5` → `5`).
- `.` adds a decimal point once per number; on an empty entry it gives `0.`.
- An entry holds at most 16 digits; further digits are ignored.

### FR-4 Operations

- `+`, `−`, `×`, `÷` use immediate execution, left to right, like a pocket
  calculator: `2 + 3 × 4 =` shows `20` (not 14).
- Choosing an operator right after another one replaces it: `5 + × 2 =` shows
  `10`.
- `=` shows the result and clears the pending line. Pressing `=` again without
  new input changes nothing.
- After a result, a digit starts a new calculation; an operator continues from
  the result (`5 + 2 =`, `× 3 =` shows `21`).

### FR-5 Division by zero

- Dividing by zero shows `Cannot divide by zero`. The next digit starts a new
  calculation; `C` clears it; an operator is ignored until then.

### FR-6 Number formatting

- Results are rounded to 12 significant digits and trailing zeros are dropped,
  so `0.1 + 0.2 =` shows `0.3`.
- Numbers whose absolute value is 1e16 or more, or below 1e-9 (except 0), are
  shown in exponential notation, for example `1.5e+20`.
- No thousands separators.

### FR-7 Clearing

- `C` clears everything: entry, pending calculation and error.
- `⌫` removes the last character of the current entry (an entry of one digit
  becomes `0`). It does nothing on a result or an error.

### FR-8 Accessibility

- Every key is a `<button>` with an accessible name: digits by their value,
  and `plus`, `minus`, `multiply`, `divide`, `equals`, `clear`, `backspace`,
  `decimal point`.
- The display is an `aria-live="polite"` region.

## Non-functional requirements

- The calculator logic is pure TypeScript in `src/calculator/` with no React
  imports (for example a reducer: state + key → state), and every acceptance
  criterion below has a unit test there.
- At least one component test clicks keys and reads the display.
- `npm run build` and `npm test` pass; no errors in the browser console.

## Acceptance criteria

| # | Keys pressed | Display shows |
|---|---|---|
| AC-1 | `7` `+` `8` `=` | `15` |
| AC-2 | `2` `+` `3` `×` `4` `=` | `20` |
| AC-3 | `0` `.` `1` `+` `0` `.` `2` `=` | `0.3` |
| AC-4 | `9` `÷` `0` `=` | `Cannot divide by zero` |
| AC-5 | `9` `÷` `0` `=` `4` | `4` |
| AC-6 | `5` `+` `×` `2` `=` | `10` |
| AC-7 | `5` `+` `2` `=` `×` `3` `=` | `21` |
| AC-8 | `1` `2` `3` `⌫` | `12` |
| AC-9 | `1` `.` `.` `5` | `1.5` |
| AC-10 | `9` pressed 17 times | `9999999999999999` (16 digits) |
| AC-11 | `8` `+` `2` `C` | `0`, no pending calculation |
| AC-12 | `9` `9` `9` `9` `9` `9` `9` `9` `×` `9` `9` `9` `9` `9` `9` `9` `9` `×` `1` `0` `0` `=` | `9.9999998e+17` |

## Out of scope

Keyboard input, calculation history, memory keys, percent, sign change, square
root and themes: the next PRDs add them.
