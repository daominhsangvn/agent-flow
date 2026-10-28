# PRD: HR reports and payroll export

| | |
|---|---|
| Ticket | F10 |
| Status | Reference |
| Related | meeting 2026-09-15 (payroll), D-003, F03, F05 |

## 1. Background
HR wants trends per department; payroll (Mai Ly) needs unpaid leave per person
per month by the 25th, today done by hand.

## 2. Goals
A yearly report per department, month and leave type, and a monthly unpaid CSV.

## 3. Non-goals
Charts beyond a table, scheduled emails.

## 4. Users and roles
HR admins only.

## 5. Functional requirements
- FR-1 `GET /api/reports/leave-by-department?year=YYYY`: for each department,
  month (1–12) and leave type, the days taken: approved requests (including
  `cancellation_requested`), cancelled ones excluded, each request's working
  days split into the month they fall in.
- FR-2 `GET /api/reports/unpaid.csv?month=YYYY-MM`: one line per employee with
  unpaid leave in that month: `email,name,department,days`, UTF-8 with BOM
  (Excel shows Vietnamese names), sorted by department then name; header line
  always present.
- FR-3 Page "Reports" (`/reports`): year select, the table (departments × months,
  a type filter, row and column totals), month select and a "Download unpaid
  CSV" link.

## 6. Business rules
- BR-1 Days in a month = working days of the request inside that month, with the
  first/last day halves (F02 BR-1) and holidays (F04).
- BR-2 Totals add up: the sum of the months equals the request's days.

## 7. Acceptance criteria
- AC-1 Chi Do's approved unpaid leave 2026-11-30 to 2026-12-04 (5 days): the
  November CSV has Chi with 1, December with 4.
- AC-2 The CSV starts with the UTF-8 BOM and the header `email,name,department,days`.
- AC-3 An's approved annual 2026-11-02..06 appears as 5 in Engineering,
  November, Annual; his cancelled request does not.
- AC-4 A month without unpaid leave gives a CSV with only the header.
- AC-5 Employees and managers get 403.

## 8. UI
`/reports` (nav "Reports", HR): `report-year-select`, `report-type-filter`,
`report-table`, cells `report-cell-<departmentId>-<month>`, totals
`report-total-<departmentId>`, `unpaid-month-select`, `unpaid-csv-link`.

## 10. Out of scope / later
PDF, charts, payroll system integration.
