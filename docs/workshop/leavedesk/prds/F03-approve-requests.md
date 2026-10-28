# PRD: Approve or reject leave requests

| | |
|---|---|
| Ticket | F03 (Jira LD-3) |
| Status | Reference |
| Policy | leave-policy-v3.1 §6 |
| Related | D-003, D-005, F01, F02 |

## 1. Background
Approvals are emails that HR re-types (kickoff). Minh wants one list with the
balance next to each request (interviews 2026-09-22).

## 2. Goals
Approvers decide in one place; an approval updates the balance immediately
through the ledger.

## 3. Non-goals
Delegation (F09), notifications (F07), cancellations (F05).

## 4. Users and roles
- Manager: decides pending requests of their direct reports.
- HR admin: decides pending requests of people without a manager, and the HR
  step of unpaid leave over 5 days (D-005).
- Nobody decides their own request.

## 5. Functional requirements
- FR-1 `GET /api/approvals`: the requests waiting for the current user, oldest
  first, with employee, type, dates, days, reason, late-notice flag, and the
  employee's available balance of that type before and after the request.
- FR-2 `POST /api/approvals/:id/approve` and `/reject` (`{ reason }`, required
  for reject, 3–500 characters).
- FR-3 Approval of the final step sets `approved` and adds a ledger `deduction`
  of −days for the request's type and year (all types, so unpaid/wedding/
  bereavement usage is recorded too).
- FR-4 Unpaid leave of more than 5 days approved by the manager becomes
  `pending_hr`; an HR admin then approves (→ `approved` + deduction) or rejects.
- FR-5 The employee sees the status, who decided, when, and the reason in My
  requests.
- FR-6 Page "Approvals" (`/approvals`) for managers and HR.

## 6. Business rules
- BR-1 Only the request's current approver may decide (403 otherwise); a
  request no longer waiting answers 409.
- BR-2 Approving re-checks the balance; if it is no longer enough, 409 "Not
  enough balance".
- BR-3 Rejecting adds nothing to the ledger.

## 7. Acceptance criteria
- AC-1 Given An Le has a pending annual request of 5 days, when Minh opens
  Approvals, then it is listed with "12 available → 7 after".
- AC-2 When Minh approves it, then An's request is `approved`, decided by Minh
  Tran, and An's annual balance is 7 available, 0 pending.
- AC-3 When Minh rejects a request without a reason, he gets an error; with a
  reason, the request is `rejected` and An sees the reason; the balance is
  unchanged.
- AC-4 Lan Vo does not see An's request and gets 403 when she tries to approve
  it.
- AC-5 Minh Tran's own request is in Hoa's (HR) list, not in his.
- AC-6 Chi Do's unpaid leave of 6 days: Lan approves → `pending_hr`, in Hoa's
  list; Hoa approves → `approved`.
- AC-7 Deciding an already decided request answers 409.
- AC-8 An employee does not see "Approvals" in the navigation and gets 403 on
  the API.

## 8. UI
`/approvals`: table `approvals-table`, rows `approval-row-<id>`, balance
`approval-balance-<id>`, late flag `approval-late-<id>`, buttons
`approve-<id>`, `reject-<id>`; reject dialog with `reject-reason`,
`reject-confirm`; empty state `approvals-empty`.

## 9. Data and API
`leave_requests`: statuses `pending`, `pending_hr`, `approved`, `rejected`;
`decided_by`, `decided_at`, `decision_reason`, `manager_decided_by` (unpaid
two-step).

## 10. Out of scope / later
Bulk approval, delegation, notifications.

## 11. Open questions and answers
- Who approves people without a manager → HR (D-005).
