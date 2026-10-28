# PRD: Request leave

| | |
|---|---|
| Ticket | F02 (Jira LD-2) |
| Status | Reference |
| Policy | leave-policy-v3.1 §2, §4 |
| Related | D-003, D-004, D-005, F01 |

## 1. Background
Leave is requested with a Google Form and approved by email; duplicates and
wrong day counts are common (Minh). LeaveDesk replaces the form.

## 2. Goals
An employee requests leave in under a minute with the right day count, and the
request waits for the right approver.

## 3. Non-goals
Approving (F03), cancelling (F05), public holidays (F04: until then only
weekends are excluded), notifications (F07).

## 4. Users and roles
Every role can request leave for themselves; nobody requests for someone else.

## 5. Functional requirements
- FR-1 Form: leave type, first day, last day, first-day part (`full` | `pm`),
  last-day part (`full` | `am`) — for a one-day request a single part (`full` |
  `am` | `pm`) —, reason (required, 3–500 characters), and for sick leave over 2
  working days the checkbox "I will hand in a medical certificate" (required).
- FR-2 While filling in, the form shows the number of working days
  (`POST /api/requests/preview`) and any warning.
- FR-3 `POST /api/requests` validates (BR-2..BR-7) and stores a `pending`
  request with its day count and its approver (BR-8).
- FR-4 "My requests" (`/requests`): the user's requests newest first, with type,
  dates, days, status, approver and, when decided, the decision reason.
- FR-5 The dashboard balance shows pending days (F01 `pending`).

## 6. Business rules
- BR-1 Days = working days (Mon–Fri) from first to last day, minus 0.5 when the
  first day is `pm`, minus 0.5 when the last day is `am`. A one-day `am`/`pm`
  request is 0.5 (§4.1, §4.5, D-004). Weekends at the edges are allowed but not
  counted; a request with 0 days is refused.
- BR-2 First day ≤ last day, both in the same leave year ("Split the request at
  the end of the year").
- BR-3 No overlap with the user's pending or approved requests, at half-day
  precision (a morning and an afternoon of the same day do not overlap) (§4.4).
- BR-4 Annual and sick: days ≤ available (F01: ledger − pending). Unpaid: used +
  pending + days ≤ 30. Wedding, bereavement: days ≤ 3 per request. No negative
  balance (CR-003 undecided).
- BR-5 Annual leave cannot start before today. Sick leave may start in the past
  if its last day is at most 3 working days before today (§4.3). Other types
  cannot start in the past.
- BR-6 Notice (§4.2): annual leave of more than 2 days needs the first day at
  least 5 working days after today; shorter annual leave at least 1 working day
  after today. A late request is **accepted with a warning** and flagged
  `lateNotice` for the approver (managers may still approve).
- BR-7 Sick leave over 2 working days requires the certificate checkbox.
- BR-8 Approver = the user's manager; a user without a manager → HR (D-005).
- Examples (`LEAVEDESK_TODAY=2026-10-19`, Monday): annual 2026-11-02 (Mon) to
  2026-11-06 (Fri) = 5 days, no warning; annual 2026-10-21 to 2026-10-23 = 3
  days with a late-notice warning; 2026-10-30 (Fri) `pm` to 2026-11-02 (Mon)
  `am` = 1 day.

## 7. Acceptance criteria
- AC-1 Given An Le on 2026-10-19, when he requests annual leave 2026-11-02 to
  2026-11-06 with reason "Family trip", then a pending request of 5 days appears
  in My requests with approver Minh Tran, and his annual balance shows 5
  pending, 7 available.
- AC-2 The preview for 2026-10-30 (`pm`) to 2026-11-02 (`am`) shows 1 day.
- AC-3 A request on Saturday 2026-10-24 only is refused ("no working days").
- AC-4 A request overlapping AC-1's dates is refused; a morning request on a day
  where only the afternoon is taken is accepted.
- AC-5 Annual leave of 13 days for An Le (12 available) is refused; unpaid leave
  of 13 days is accepted.
- AC-6 Annual leave 2026-10-21 to 2026-10-23 is accepted with the warning
  "less than 5 working days' notice".
- AC-7 Sick leave 2026-10-14 to 2026-10-16 (past, within 3 working days) is
  accepted only with the certificate checkbox; sick leave ending 2026-10-09 is
  refused.
- AC-8 Annual leave starting 2026-10-16 (past) is refused.
- AC-9 A request without a reason is refused.
- AC-10 Minh Tran's request has approver HR (he has no manager).
- AC-11 A request from 2026-12-30 to 2027-01-04 is refused (year boundary).

## 8. UI
- `/requests/new` (nav "Request leave"): form `leave-request-form`, fields
  `request-type`, `request-start`, `request-end`, `request-start-part`,
  `request-end-part`, `request-day-part` (one-day requests), `request-reason`,
  `request-certificate`, preview `request-days-preview`, warning
  `request-warning`, error `request-error`, submit `request-submit`.
- `/requests` (nav "My requests"): table `my-requests-table`, rows
  `request-row-<id>`, status badge `request-status-<id>`, empty state
  `my-requests-empty`.

## 9. Data and API
Table `leave_requests`: id, user_id, leave_type, start_date, end_date,
start_part, end_part, days, reason, certificate, late_notice, status
(`pending`, later `approved`, `rejected`, …), approver_id (nullable = HR),
created_at, decided_by, decided_at, decision_reason.
`POST /api/requests/preview` → `{ days, warnings: [] }`; `POST /api/requests` →
201 `{ request }`; 400 with `{ error }`; `GET /api/requests/mine`.

## 10. Out of scope / later
Holidays (F04), attachments for certificates, requests on behalf of others.

## 11. Open questions and answers
- Reason required? → yes, 3–500 characters (**Assumption**, Hoa to confirm).
- Notice rule: block or warn? → warn (§4.2 "managers may still approve").
