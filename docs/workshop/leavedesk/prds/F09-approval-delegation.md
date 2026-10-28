# PRD: Approval delegation

| | |
|---|---|
| Ticket | F09 |
| Status | Reference |
| Policy | leave-policy-v3.1 §6.5 |
| Related | D-005, F03 |

## 1. Background
Nobody approves while Minh visits clients; the policy says the manager names a
substitute (§6.5).

## 2. Goals
A manager names a delegate for a date range; the delegate decides the team's
requests meanwhile; the record shows who decided on whose behalf.

## 3. Non-goals
Delegating HR's own approvals; chains of delegation.

## 4. Users and roles
Managers create delegations for themselves. Delegates must be another manager
or an HR admin.

## 5. Functional requirements
- FR-1 Table `delegations` (id, manager_id, delegate_id, start_date, end_date,
  created_at, revoked_at). `GET/POST /api/delegations`,
  `POST /api/delegations/:id/revoke`.
- FR-2 While a delegation is active (start ≤ today ≤ end, not revoked), the
  delegate's Approvals list also holds the manager's team's requests, marked
  "on behalf of <manager>"; the manager still sees and may decide them.
- FR-3 Decisions record `decided_by` (the delegate) and `on_behalf_of` (the
  manager); My requests shows "Approved by Lan Vo on behalf of Minh Tran".
- FR-4 Page "Delegation" (`/delegation`) for managers: current and upcoming
  delegations, a form, revoke.

## 6. Business rules
- BR-1 Delegate ≠ the manager; delegate is a manager or HR admin.
- BR-2 End ≥ start ≥ today; at most 30 days.
- BR-3 A manager's delegations may not overlap (409).
- BR-4 A delegate never decides their own request (the delegate's request goes
  to their own approver).

## 7. Acceptance criteria
- AC-1 Minh delegates to Lan 2026-10-19..2026-10-23; with
  `LEAVEDESK_TODAY=2026-10-20`, An's pending request is in Lan's list "on behalf
  of Minh Tran".
- AC-2 Lan approves it → An sees "Approved by Lan Vo on behalf of Minh Tran".
- AC-3 On 2026-10-24 the request of Binh is no longer in Lan's list.
- AC-4 Minh can still approve during the delegation.
- AC-5 Delegating to An (an employee) or to himself is refused; an overlapping
  second delegation answers 409.
- AC-6 After revoking, Lan no longer sees Minh's team.

## 8. UI
`/delegation`: `delegation-form` (`delegation-delegate`, `delegation-start`,
`delegation-end`, `delegation-submit`), table `delegations-table`, rows
`delegation-row-<id>`, `delegation-revoke-<id>`; Approvals rows show
`approval-on-behalf-<id>`.

## 10. Out of scope / later
Automatic delegation from the manager's own approved leave.
