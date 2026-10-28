# RC-2: Keyboard input and calculation history

## Background

After RC-1 the calculator works with the mouse only, and a result is lost as soon as the next calculation starts.

## Goal

People can use the calculator from the keyboard and see, reuse and clear their recent calculations, also after reloading the page.

## Functional requirements

1. **Keyboard.** While the page has focus: digits `0`-`9` (also on the numeric keypad), `.` and `,` (decimal point), `+`, `-`, `*` and `x` (multiply), `/` (divide), `Enter` and `=` (equals), `Backspace` (DEL), `Escape` and `Delete` (RESET). Each key does exactly what the on-screen key does.
2. The on-screen key that matches a pressed keyboard key is highlighted briefly (about 150 ms), so the user sees what was entered.
3. Keyboard shortcuts do not fire while the focus is in a text field, and `/` must not open the browser's quick find.
4. **History.** Every completed calculation (`=` with a result, not an error) is added to a History panel below the keypad as `expression = result` (e.g. `2 + 3 x 4 = 20`), newest first, at most 20 entries (the oldest is dropped).
5. Selecting an entry (click, or Enter while it has focus) puts its result on the display as the start of a new calculation.
6. A "Clear history" button empties the history; it is disabled when the history is empty, which shows "No calculations yet".
7. The history is saved in `localStorage` and restored when the page loads. Missing, invalid or unreadable stored data is ignored (the history starts empty) and never breaks the app.

## Non-functional requirements

- The History panel follows the existing visual design (colour tokens, rounded panel like the keypad) and fits below the keypad without changing the keypad's size.
- History entries are keyboard reachable and announced with their text.
- Unit tests cover the key mapping and the history store (including corrupt storage); component tests cover typing and reusing an entry. `npm test` and `npm run build` pass.

## Acceptance criteria

- AC-1: Typing `12*3` then `Enter` shows `36`.
- AC-2: `Backspace` after typing `45` shows `4`; `Escape` shows `0`.
- AC-3: After `2 + 3 =`, the History panel's first entry is `2 + 3 = 5`.
- AC-4: Clicking that entry shows `5`; then `x 2 =` shows `10`.
- AC-5: After 21 calculations the panel shows 20 entries and the first calculation is gone.
- AC-6: Reloading the page keeps the history; with `localStorage` holding `not json` under the history key, the app loads with an empty history.
- AC-7: "Clear history" empties the panel and the stored history.

## Out of scope

Memory keys, percent, themes, editing history entries.
