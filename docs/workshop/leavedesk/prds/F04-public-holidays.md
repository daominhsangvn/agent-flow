# PRD: Public holidays

| | |
|---|---|
| Ticket | F04 (Jira LD-4) |
| Status | Reference |
| Policy | leave-policy-v3.1 §4.5, §8 |
| Related | F02, public-holidays-2026.md, public-holidays-2027.md |

## 1. Background
Holidays change yearly and are announced late (Tet 2027 unconfirmed). Leave
must not count them.

## 2. Goals
HR maintains holidays; requests exclude them; everybody can see the list.

## 3. Non-goals
Regional holidays, working Saturdays (CR-001).

## 4. Users and roles
Everyone views; HR admins add, edit and delete.

## 5. Functional requirements
- FR-1 Table `public_holidays` (date unique, name), seeded with 2026 and the 2027
  draft from the knowledge base.
- FR-2 `GET /api/holidays?year=` (everyone), `POST`, `PUT /:id`, `DELETE /:id`
  (HR).
- FR-3 The day count of F02 (preview and new requests) excludes holidays.
- FR-4 Adding, moving or deleting a holiday recalculates the days of **pending**
  requests covering that date; **approved** requests are not changed, and the
  response lists them (`affectedApprovedRequests`) so HR can correct them later
  (F12).

## 6. Business rules
- BR-1 A holiday on a Saturday or Sunday is refused ("enter the compensatory
  day instead").
- BR-2 Name required (1–100 characters); date unique (409).

## 7. Acceptance criteria
- AC-1 The holidays page for 2026 lists the 11 holidays of
  public-holidays-2026.md; 2027 lists the draft.
- AC-2 Given `LEAVEDESK_TODAY=2026-04-20`, annual leave 2026-04-27 to
  2026-05-01 counts 2 days (27/4, 30/4 and 1/5 are holidays).
- AC-3 Hoa adds 2026-12-24 "Company year-end party"; a pending request of An
  over 2026-12-21..25 goes from 5 to 4 days.
- AC-4 Adding Saturday 2026-12-26 is refused.
- AC-5 Adding an existing date answers 409.
- AC-6 An employee sees the list but no add/edit/delete controls and gets 403
  on POST/PUT/DELETE.
- AC-7 Adding a holiday inside an approved request returns that request in
  `affectedApprovedRequests` and does not change its days or the ledger.

## 8. UI
`/holidays` (nav "Holidays", everyone): year select `holiday-year-select`,
table `holidays-table`, rows `holiday-row-<date>`; HR: form
`holiday-form` (`holiday-date`, `holiday-name`, `holiday-submit`), buttons
`holiday-edit-<id>`, `holiday-delete-<id>`, message `holiday-affected`.

## 9. Data and API
`public_holidays(id, date TEXT UNIQUE, name)`.

## 10. Out of scope / later
Importing from a government feed.

## 11. Open questions and answers
- What happens to requests over a changed holiday → FR-4 (**Assumption**; to
  confirm with Hoa: pending recalculated, approved listed for manual
  correction).
