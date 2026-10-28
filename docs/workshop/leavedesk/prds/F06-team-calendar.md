# PRD: Who is off — team calendar

| | |
|---|---|
| Ticket | F06 |
| Status | Reference |
| Policy | leave-policy-v3.1 §9 (context) |
| Related | meeting 2026-09-22, roles-and-permissions.md, F02, F03 |

## 1. Background
Managers check who is off before sprint planning (Minh); Lan needs the whole
Sales department; HR needs everyone (interviews 2026-09-22).

## 2. Goals
A month calendar showing approved and pending leave of the people the viewer
may see, without leaking reasons.

## 3. Non-goals
Coverage rule warnings (F11), editing leave from the calendar.

## 4. Users and roles (scope)
- Employee: their team (people with the same manager, and the manager).
- Manager: their department (decision for Lan's question: a manager sees the
  whole department they belong to — **Assumption**, confirm with Hoa).
- HR admin: everyone, filterable by department.

## 5. Functional requirements
- FR-1 `GET /api/calendar?month=YYYY-MM[&departmentId=]` returns the visible
  people and, per person, their `approved`, `pending`, `pending_hr` and
  `cancellation_requested` leave intersecting the month, split into days with
  the part (`full`, `am`, `pm`) and the status. Never the reason.
- FR-2 Page "Calendar" (`/calendar`): one row per person, one column per day of
  the month; weekends and holidays shaded; approved solid, pending striped;
  half days shown as half cells; previous/next month.
- FR-3 HR: department filter.

## 6. Business rules
- BR-1 Weekends and public holidays are never shown as leave.
- BR-2 Rejected, withdrawn and cancelled requests are not shown.

## 7. Acceptance criteria
- AC-1 Given An's approved leave 2026-11-02..06 and Binh's pending
  2026-11-05 `pm`, when Minh opens November 2026, then An has 5 solid days and
  Binh a striped afternoon on 5 Nov.
- AC-2 Chi Do (Sales) sees Duc and Lan but not An.
- AC-3 Lan sees all of Sales; Hoa sees everyone and can filter Engineering.
- AC-4 No response contains a reason.
- AC-5 Navigating to December shows December.

## 8. UI
`/calendar`: `calendar-grid`, header `calendar-month-label`, buttons
`calendar-prev`, `calendar-next`, filter `calendar-department` (HR), person
rows `calendar-person-<userId>`, cells `calendar-cell-<userId>-<date>` with
`data-status` (`approved` | `pending`) and `data-part` (`full` | `am` | `pm`).

## 9. Data and API
Read-only over `leave_requests`, `public_holidays`, `users`.

## 10. Out of scope / later
iCal export.

## 11. Open questions and answers
- Department head scope → Assumption above.
- Employees see their team → yes, without reasons (ticket comment).
