# RC-1: Make the calculator work

## Background

`workshop/react-calculator` renders a calculator (display, keys 0-9, `.`, `+`, `-`, `/`, `x`, `DEL`, `RESET`, `=`), but no key does anything: the click handler in `src/App.jsx` has empty cases and the display always shows `0`. The repository has no tests.

## Goal

Every key works like a simple pocket calculator, and the behaviour is covered by automated tests.

## Users

People who want quick arithmetic in the browser, with a mouse or a touch screen.

## Functional requirements

1. **Number entry.** Digit keys append to the number on the display; a leading `0` is replaced (`0` then `7` shows `7`). `.` adds a decimal point once per number; `.` on an empty entry shows `0.`. At most 12 digits per number; further digits are ignored.
2. **Operators.** `+`, `-`, `x`, `/` work left to right without precedence, like a pocket calculator: `2 + 3 x 4 =` shows `20`. Pressing an operator after a complete `a op b` shows the intermediate result first. Pressing another operator right after an operator replaces it.
3. **Equals.** `=` shows the result. Pressing `=` again repeats the last operation (`2 + 3 = =` shows `8`). A digit typed after a result starts a new calculation; an operator after a result continues from it.
4. **DEL** removes the last character of the number being typed (`0` when nothing is left). After a result, DEL does nothing.
5. **RESET** clears everything back to `0`.
6. **Division by zero** shows `Cannot divide by zero`; the next key starts a new calculation (RESET also clears it).
7. **Precision.** Results are shown without floating-point artefacts: round to at most 10 decimal places and drop trailing zeros (`0.1 + 0.2` shows `0.3`). Numbers whose absolute value is 1e12 or more, or below 1e-10 but not zero, are shown in exponential notation (e.g. `1.2e+12`).
8. **Expression line.** Above the result, a smaller line shows the pending operation (e.g. `12 x`), empty when there is none.
9. **Accessibility.** Keys are buttons with accessible names (`x` is "multiply", `/` "divide", `DEL` "delete", `RESET` "reset"); the display is announced to screen readers when it changes.

## Non-functional requirements

- Keep the existing look (colours, layout, key order); the expression line uses the existing colour tokens.
- Calculation logic is separate from the React component and unit tested; the UI has component tests. `npm test` and `npm run build` pass.

## Acceptance criteria

- AC-1: `7`, `+`, `8`, `=` shows `15`.
- AC-2: `2`, `+`, `3`, `x`, `4`, `=` shows `20`.
- AC-3: `9`, `/`, `0`, `=` shows `Cannot divide by zero`; then `5` shows `5`.
- AC-4: `0`, `.`, `1`, `+`, `0`, `.`, `2`, `=` shows `0.3`.
- AC-5: `1`, `2`, `3`, `DEL` shows `12`; `RESET` shows `0`.
- AC-6: `2`, `+`, `3`, `=`, `=` shows `8`.
- AC-7: `5`, `+`, `-`, `2`, `=` shows `3` (the second operator replaced the first).
- AC-8: Typing 13 digits shows only the first 12.
- AC-9: After `12`, `x` the expression line shows `12 x`.

## Out of scope

Keyboard input, history, memory keys, percent, themes.
