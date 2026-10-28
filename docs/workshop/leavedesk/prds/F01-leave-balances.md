# PRD: Leave balances

| | |
|---|---|
| Ticket | F01 (Jira LD-1) |
| Status | Reference |
| Policy | leave-policy-v3.1 §2, §3 |
| Related | D-003 (ledger), meeting 2026-09-15 |

## 1. Background
Employees ask HR about 40 times a month how many days they have left; the leave
sheet is updated once a month (kickoff 2026-09-08). LeaveDesk must show every
employee their balance per leave type, and HR everyone's.

## 2. Goals
- An employee sees their balance for the current leave year on the dashboard.
- HR sees every employee's balances on one page.
- Balances are computed from a ledger (D-003), ready for requests (F02) and
  approvals (F03).

## 3. Non-goals
Requesting leave (F02), carry-over (F08), adjustments (F12), monthly accrual
(policy §3.5, not decided).

## 4. Users and roles
Every role sees their own balances. HR admins also see everyone's. Managers do
not get a team balance page here (F03 shows the balance next to each request).

## 5. Functional requirements
- FR-1 Leave types are stored: `annual`, `sick`, `unpaid`, `wedding`,
  `bereavement` with name, paid flag and rules of §2.
- FR-2 A `leave_ledger` table records every balance change (D-003): user,
  leave type, leave year, days (REAL, multiple of 0.5), kind (`grant`,
  `deduction`, `restore`, `carry_over`, `forfeit`, `adjustment`), request id
  (nullable), note, created_by (nullable for the system), created_at.
- FR-3 On server start, each employee who has none gets the `grant` rows of
  the leave year of `today()`: annual (BR-1/BR-2) and sick (5). Running it
  again adds nothing.
- FR-4 `GET /api/balances/me?year=YYYY` (default: year of `today()`) returns the
  current user's balances (BR-4).
- FR-5 `GET /api/balances?year=YYYY` (HR only) returns every employee with their
  annual and sick balances.
- FR-6 Dashboard card "My leave balance"; HR page "Balances" (`/balances`).

## 6. Business rules
- BR-1 Annual entitlement of a full year = 12 + floor(full years of service on
  1 January of the year / 5) (§3.1, §3.2).
- BR-2 Joined during the year: 1 day per month from the joining month (counted
  only when joined on or before the 15th) to December (§3.3). Seniority does not
  apply in the joining year.
- BR-3 Sick: 5 days per year. Unpaid: no entitlement, at most 30 days per year.
  Wedding (3 per event) and bereavement (3 per event): no yearly balance.
- BR-4 For annual and sick, per leave year: `entitlement` = sum of `grant`
  rows, `carriedOver` = sum of `carry_over` rows, `used` = minus the sum of
  `deduction`, `restore`, `forfeit` and `adjustment` rows, `pending` = days of
  the user's pending requests of the type (0 until F02), and
  `available` = sum of all ledger rows − `pending`. Unpaid: `used` and
  `limit: 30`. Wedding and bereavement are listed with their per-event days
  (`perEvent: 3`) and no balance.
- Worked examples, leave year 2026 (`LEAVEDESK_TODAY=2026-10-19`):

| Person | Joined | Service on 2026-01-01 | Annual 2026 |
|---|---|---|---|
| Minh Tran | 2018-07-16 | 7 years | 13 |
| Hoa Nguyen | 2019-03-04 | 6 years | 13 |
| Lan Vo | 2020-01-06 | 5 years | 13 |
| An Le | 2021-09-01 | 4 years | 12 (13 from 2027) |
| Binh Pham | 2024-05-13 | 1 year | 12 |
| Chi Do | 2022-02-14 | 3 years | 12 |
| Duc Hoang | 2023-11-20 | 2 years | 12 |
| Khoa Dang | 2026-08-03 | joined this year | 5 (Aug–Dec) |

## 7. Acceptance criteria
- AC-1 Given An Le signed in on 2026-10-19, when the dashboard opens, then
  "My leave balance" shows Annual 12 available of 12 and Sick 5 of 5.
- AC-2 Given Khoa Dang, then Annual shows 5 of 5.
- AC-3 Given Minh Tran, then Annual shows 13 of 13.
- AC-4 Given Lan Vo (joined 2020-01-06), then Annual shows 13.
- AC-5 Unpaid shows "0 used of 30"; Wedding and Bereavement show "3 days per
  event" and no balance.
- AC-6 Given Hoa Nguyen (HR), when she opens Balances, then all 8 employees are
  listed with annual and sick entitlement and available days.
- AC-7 Given An Le, when he calls `GET /api/balances` or opens `/balances`, then
  he gets 403 / the page is not in his navigation.
- AC-8 Restarting the server does not add grants twice (balances unchanged).
- AC-9 `GET /api/balances/me?year=2027` before 2027 grants exist returns
  entitlement 0 for every type (no error).

## 8. UI
- Dashboard card `data-testid="balance-card"`, one row per type
  `balance-row-<code>` with `balance-available-<code>`,
  `balance-entitlement-<code>`, `balance-pending-<code>`.
- HR page `/balances` (nav "Balances", HR only): table `hr-balances-table`, rows
  `hr-balance-row-<userId>`, year select `balance-year-select`.

## 9. Data and API
Tables `leave_types`, `leave_ledger` (FR-1, FR-2). Responses:
`{ year, balances: [{ type, name, entitlement, carriedOver, used, pending, available, limit?, perEvent? }] }`.

## 10. Out of scope / later
Monthly accrual, advance leave (CR-003), carry-over (F08).

## 11. Open questions and answers
- Seniority date → 1 January (meeting 2026-09-15, Hoa).
- How to show unpaid / wedding / bereavement → BR-3 (**Assumption**, confirm
  with HR).
