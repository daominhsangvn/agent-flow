# Memory, percent, sign, square root and dark mode

## Summary

Give the calculator the keys people expect from a desk calculator (memory,
percent, sign change, square root) and a dark mode that remembers the choice.

Builds on the basic calculator, which is on `main`; keyboard input and
history (the "Keyboard input and calculation history" PRD) may be there too. Keep the existing behaviour and tests unchanged.

## Functional requirements

### FR-1 Keypad

The keypad becomes 4 columns by 7 rows (it replaces the basic calculator layout; every
existing key keeps its accessible name):

```
┌────┬────┬────┬────┐
│ MC │ MR │ M+ │ M− │
├────┼────┼────┼────┤
│ C  │ ⌫  │ √  │ %  │
├────┼────┼────┼────┤
│ 7  │ 8  │ 9  │ ÷  │
├────┼────┼────┼────┤
│ 4  │ 5  │ 6  │ ×  │
├────┼────┼────┼────┤
│ 1  │ 2  │ 3  │ −  │
├────┼────┼────┼────┤
│ ±  │ 0  │ .  │ +  │
├────┴────┴────┴────┤
│         =         │
└───────────────────┘
```

New accessible names: `memory clear`, `memory recall`, `memory add`,
`memory subtract`, `square root`, `percent`, `change sign`.

### FR-2 Change sign (±)

- Changes the sign of the value in the display (current entry or result).
  `0` stays `0`, never `-0`.
- On an entry, digits typed afterwards continue it: `5 ± 2` shows `-52`.
- On a result, an operator afterwards continues from the changed value.

### FR-3 Percent (%)

Applies to the value in the display at once:

- With a pending `+` or `−`, the value becomes that percentage of the first
  number: `200 + 10 %` shows `20`, and `=` then shows `220`.
- With a pending `×` or `÷`, the value is divided by 100: `50 × 10 %` shows
  `0.1`, and `=` then shows `5`.
- With nothing pending, the value is divided by 100: `25 %` shows `0.25`.

### FR-4 Square root (√)

- Replaces the value in the display with its square root at once: `9 √`
  shows `3`; `2 √` shows `1.41421356237` (the basic calculator's formatting,
  12 significant digits).
- On a negative value it shows `Invalid input`, which behaves like the
  `Cannot divide by zero` error of the basic calculator (next digit starts over, `C`
  clears, operators are ignored).

### FR-5 Memory

- `M+` adds the value in the display to the memory, `M−` subtracts it, `MR`
  puts the memory value in the display, `MC` sets the memory to 0.
- After `%`, `√`, `M+`, `M−` or `MR`, the next digit starts a new entry; an
  operator uses the value shown.
- An `M` indicator is shown in the display while the memory is not 0.
- The memory survives `C` but not a page reload. Memory keys do nothing while
  an error is shown.

### FR-6 Dark mode

- A button in the header switches between a light and a dark theme
  (accessible name `toggle dark mode`, pressed state exposed with
  `aria-pressed`).
- With no saved choice the app follows the operating system
  (`prefers-color-scheme`). The choice is saved in `localStorage` under
  `calculator.theme` (`light` or `dark`) and restored on load; any other stored
  value is ignored.
- Themes are CSS custom properties switched by a `data-theme` attribute on
  the root element. Text and key labels meet WCAG AA contrast in both themes.

### FR-7 History (only when the calculation history is present)

- A calculation that used `%` or `√` is recorded with the values actually
  used, for example `200 + 20 = 220`.

## Non-functional requirements

- The new rules live in the pure calculator logic under `src/calculator/` and
  have unit tests; the theme logic (stored value, OS preference) is a small
  tested module.
- `npm run build` and `npm test` pass; all earlier tests still pass.

## Acceptance criteria

| # | Steps | Expected |
|---|---|---|
| AC-1 | `5` `±` `2` | `-52` |
| AC-2 | `0` `±` | `0` |
| AC-3 | `2` `0` `0` `+` `1` `0` `%` | `20`; then `=` shows `220` |
| AC-4 | `5` `0` `×` `1` `0` `%` `=` | `5` |
| AC-5 | `2` `5` `%` | `0.25` |
| AC-6 | `9` `√` | `3` |
| AC-7 | `2` `√` | `1.41421356237` |
| AC-8 | `4` `±` `√` | `Invalid input`; then `C` shows `0` |
| AC-9 | `7` `M+` `C` `MR` | `7`, `M` indicator visible |
| AC-10 | `7` `M+` `2` `M−` `MR` | `5`; then `MC` hides `M` and `MR` shows `0` |
| AC-11 | Switch to dark mode, reload | Still dark |
| AC-12 | No saved theme, OS in dark mode | App starts dark |

## Out of scope

Scientific functions beyond √ (powers, trigonometry, parentheses), memory that
survives a reload, more themes.
