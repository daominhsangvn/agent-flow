# PRD: Notifications in the app

| | |
|---|---|
| Ticket | F07 |
| Status | Reference |
| Related | D-001, F02, F03, F05 |

## 1. Background
No emails in release 1 (D-001); people must still know when something needs
them or happened to their request.

## 2. Goals
A bell with the unread count and a list; each status change notifies the people
concerned.

## 3. Non-goals
Email, push, preferences.

## 4. Users and roles
Everyone receives their own notifications only.

## 5. Functional requirements
- FR-1 Table `notifications` (id, user_id, kind, request_id, message,
  created_at, read_at).
- FR-2 Events → recipients:

| Event | Recipient | Kind |
|---|---|---|
| Request created | its approver (manager, or every HR admin) | `request_submitted` |
| Approved / rejected | requester | `request_approved` / `request_rejected` |
| Unpaid > 5 days approved by manager | every HR admin | `hr_approval_needed` |
| Cancellation asked | approver | `cancellation_requested` |
| Cancellation confirmed / declined | requester | `cancellation_confirmed` / `cancellation_declined` |

- FR-3 `GET /api/notifications` (latest 50, unread count),
  `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`.
- FR-4 The bell refreshes every 30 seconds and when the page regains focus.
- FR-5 Clicking a notification marks it read and opens the request (approver:
  `/approvals`, requester: `/requests`).

## 6. Business rules
- BR-1 Nobody is notified of their own action.
- BR-2 Messages name the person, type and dates, e.g. "An Le requested Annual
  leave 2 Nov – 6 Nov (5 days)".

## 7. Acceptance criteria
- AC-1 An requests leave → Minh's bell shows 1; the item reads as BR-2.
- AC-2 Minh approves → An's bell shows 1 "approved"; Minh's own count does not
  increase.
- AC-3 Chi's unpaid 6 days approved by Lan → Hoa notified.
- AC-4 Mark all as read → count 0.
- AC-5 A user cannot read or mark another user's notification (404).

## 8. UI
`notification-bell`, `notification-count` (hidden at 0), panel
`notification-list`, items `notification-item-<id>` with `data-read`, button
`notifications-mark-all`, empty `notifications-empty`.

## 10. Out of scope / later
Email digests (D-001).
