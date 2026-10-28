# PRD: Cancel or withdraw leave

| | |
|---|---|
| Ticket | F05 (Jira LD-5) |
| Status | Reference |
| Policy | leave-policy-v3.1 §7 |
| Related | D-003, F02, F03 |

## 1. Background
Plans change; the policy defines how leave is withdrawn or cancelled (§7).

## 2. Goals
Employees withdraw pending requests and ask to cancel approved future leave;
approvers confirm; days come back through the ledger.

## 3. Non-goals
Changing dates (cancel and request again, §7.4); HR corrections of started
leave (F12).

## 4. Users and roles
The requester withdraws/asks to cancel; the request's approver (manager, or HR
per D-005) confirms or declines.

## 5. Functional requirements
- FR-1 `POST /api/requests/:id/withdraw`: a `pending` or `pending_hr` request
  of the user → `withdrawn`. No ledger change.
- FR-2 `POST /api/requests/:id/cancel` (`{ reason }` optional): an `approved`
  request of the user whose first day is after today →
  `cancellation_requested`.
- FR-3 The approver sees cancellation requests in Approvals and confirms
  (`POST /api/approvals/:id/confirm-cancellation` → `cancelled` + ledger
  `restore` of +days) or declines (`/decline-cancellation`, reason required →
  back to `approved`).
- FR-4 Leave whose first day is today or earlier cannot be cancelled by the
  employee (409, "Ask HR to correct leave that has started").

## 6. Business rules
- BR-1 Only the requester may withdraw or ask to cancel (403).
- BR-2 A `cancellation_requested` request still counts as used until confirmed.

## 7. Acceptance criteria
- AC-1 An Le withdraws a pending request: status `withdrawn`, pending days back
  to 0.
- AC-2 An asks to cancel his approved leave 2026-11-02..06 on 2026-10-19:
  status `cancellation_requested`; balance still 7 available.
- AC-3 Minh confirms: status `cancelled`, An's balance 12 available; the ledger
  has a `restore` of +5 referencing the request.
- AC-4 Minh declines with a reason: status `approved` again, An sees the reason.
- AC-5 With `LEAVEDESK_TODAY=2026-11-03` An cannot cancel that leave (409).
- AC-6 Binh cannot withdraw An's request (403).

## 8. UI
My requests: buttons `withdraw-<id>`, `request-cancel-<id>`; Approvals: rows
`cancellation-row-<id>` with `confirm-cancel-<id>`, `decline-cancel-<id>`,
`decline-reason`, `decline-confirm`.

## 9. Data and API
Statuses `withdrawn`, `cancellation_requested`, `cancelled`;
`cancellation_reason`.

## 10. Out of scope / later
Partial cancellation of a range.

## 11. Open questions and answers
- None open; §7 is explicit.
