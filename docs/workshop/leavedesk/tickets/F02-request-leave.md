# F02 · Request leave

| Jira field | Value |
|---|---|
| Summary | As an employee I want to request leave in LeaveDesk instead of the Google Form |
| Issue type | Story |
| Reporter | Hoa Nguyen (HR) |
| Batch | Trial (run 2) — after F01 is merged |

## Description

Replace the Google Form. An employee picks the leave type, the dates and writes
a reason, and the request goes to their manager (approval comes in another
ticket).

What the form must handle:
- half days (morning or afternoon), also for the first and last day of a longer
  leave
- only working days count — weekends don't (holidays are another ticket)
- you cannot ask for more than you have, except unpaid
- the notice rules in the policy (the 5 working days thing for longer annual
  leave)
- sick leave longer than 2 days needs the certificate
- people should see their own requests and their status

Minh (comment on the ticket): "Please make sure people cannot send the same
days twice, it happens with the form all the time."

Also: should the reason be required? On the Google Form it was optional and
half the requests just say "personal".
