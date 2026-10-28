# PRD: Year-end close and carry-over

| | |
|---|---|
| Ticket | F08 |
| Status | Reference |
| Policy | leave-policy-v3.1 §3, §5 |
| Related | D-002, D-003, CR-002, meeting 2026-09-15 |

## 1. Background
31 December is HR's worst day with the Excel file. The cap may change (CR-002),
so it must be a setting.

## 2. Goals
HR previews and closes a leave year once: carry-over within the cap, forfeits,
next year's grants; and expires unused carried-over days after 31 March.

## 3. Non-goals
Monthly accrual (§3.5, undecided), payout for leavers.

## 4. Users and roles
HR admins only.

## 5. Functional requirements
- FR-1 Settings (HR): `carryOverCap` (days, default 5, 0–15, multiples of 0.5)
  and `carryOverExpiry` (`MM-DD`, default `03-31`). `GET/PUT /api/settings/leave`.
- FR-2 `GET /api/year-end/:year/preview`: per employee — annual available in
  the year (approved leave counted, pending ignored), carried over =
  min(available, cap), forfeited = available − carried, next year's entitlement
  (F01 BR-1/BR-2 for year+1).
- FR-3 `POST /api/year-end/:year/close` (`{ confirm: true }`), allowed from 1
  December of the year: in one transaction per employee, a `forfeit` row (year
  Y, −forfeited), a `carry_over` row (year Y+1, +carried) and the year Y+1
  annual and sick `grant`s unless they already exist (F01's start-up grant).
  Records the close (who, when, cap used). A second close answers 409.
- FR-4 `POST /api/year-end/:year/expire-carry-over` (Y = the year the days were
  carried into), allowed after the expiry date: forfeits the carried-over days
  not used by then, days being taken from carried-over first (§5.3), i.e.
  `unused = max(0, carriedOver − annual days approved with a first day on or
  before the expiry date)`. Once only (409).
- FR-5 Page "Year end" (`/year-end`): the settings, the preview table, a Close
  button with a confirmation, the result, and the expiry action.
- FR-6 Forfeited days are listed for payroll (preview and result, CSV link).

## 6. Business rules
- BR-1 Pending requests at close time keep their year; they are not carried.
- BR-2 The cap used is stored with the close; changing the setting later does
  not change a closed year.

## 7. Acceptance criteria
Seed for the tests: An has 4 approved annual days in 2026 (8 left), Binh 10
(2 left), Khoa none (5 left), cap 5.
- AC-1 With `LEAVEDESK_TODAY=2026-12-31`, the preview shows An: 8 available, 5
  carried, 3 forfeited, 13 for 2027 (seniority); Binh: 2, 2, 0, 12; Khoa: 5, 5,
  0, 12.
- AC-2 With cap 7, An carries 7, forfeits 1.
- AC-3 Close 2026 → An's 2027 balance is 13 + 5 carried = 18 available; the
  ledger has the forfeit (2026), carry_over and grant (2027) rows.
- AC-4 Closing 2026 again answers 409; on 2026-11-30 the close answers 409
  ("from 1 December").
- AC-5 With `LEAVEDESK_TODAY=2027-04-01`, after An took 2 annual days in
  February 2027, expiring forfeits 3 of his 5 carried days: 13 entitlement + 5
  carried − 2 used − 3 forfeited = 13 available.
- AC-6 An employee gets 403 on every year-end endpoint.

## 8. UI
`/year-end` (nav "Year end", HR): `carry-over-cap`, `carry-over-expiry`,
`settings-save`, `year-end-preview-table`, rows `year-end-row-<userId>`,
`year-end-close`, `year-end-confirm`, `year-end-result`, `expire-carry-over`.

## 10. Out of scope / later
Automatic close (D-002: no scheduler).

## 11. Open questions and answers
- Cap 5 or 7 → a setting (CR-002 open).
- Can HR close before 31 December? → from 1 December (**Assumption**).
