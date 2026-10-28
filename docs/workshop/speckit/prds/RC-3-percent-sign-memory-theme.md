# RC-3: Percent, sign, memory keys and a light theme

## Background

The calculator (RC-1, and RC-2 when merged) covers the four operations. Users ask for the keys of a typical pocket calculator and for a light theme in bright rooms.

## Goal

Add percent, sign change and memory keys, and let users switch between the current dark theme and a new light theme.

## Functional requirements

1. **New keys.** Add `%`, `±`, `MC`, `MR`, `M+`, `M-`. The keypad keeps 4 columns: a new first row `MC MR M+ M-`, and `%` and `±` take places in the existing rows next to `DEL` without removing a key. Every key keeps a visible label and an accessible name.
2. **±** changes the sign of the number on the display (also of a result). `0` stays `0`.
3. **%**: after `a + b` or `a - b`, `%` turns `b` into `a × b / 100` (`200 + 10 %` shows `20`, then `=` shows `220`); after `a x b` or `a / b` it turns `b` into `b / 100`; with no pending operation it divides the display by 100.
4. **Memory.** `M+` adds the display value to memory, `M-` subtracts it, `MR` puts the memory value on the display as a new entry, `MC` sets memory to 0. While memory is not 0 a small `M` indicator is shown on the display. Memory is not persisted.
5. **Theme.** A toggle above the display switches between the dark theme (today's colours, the default) and a light theme. The light theme defines the same colour tokens as CSS variables with light values; text keeps a contrast ratio of at least 4.5:1. The choice is saved in `localStorage` and restored on load; without a saved choice the theme follows the operating system (`prefers-color-scheme`).
6. When RC-2's keyboard support is present: `%` types percent and `F9` acts as `±`.

## Non-functional requirements

- Colours come from CSS variables only; no hard-coded colours in components.
- Unit tests cover percent, sign and memory rules; component tests cover the new keys and the theme toggle (with saved, missing and invalid stored values). `npm test` and `npm run build` pass.

## Acceptance criteria

- AC-1: `200`, `+`, `10`, `%`, `=` shows `220`.
- AC-2: `50`, `x`, `20`, `%`, `=` shows `10`.
- AC-3: `5`, `±` shows `-5`; `±` again shows `5`.
- AC-4: `9`, `M+`, `RESET`, `MR` shows `9` and the `M` indicator is visible; `MC` hides it.
- AC-5: `9`, `M+`, `3`, `M-`, `MR` shows `6`.
- AC-6: Switching to the light theme changes the page colours, and the theme is still light after a reload.

## Out of scope

Scientific functions, persistent memory, more than two themes.
