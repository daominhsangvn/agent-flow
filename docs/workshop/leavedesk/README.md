# Kịch bản: LeaveDesk — BA, Dev, QC trên AgentFlow

Mô phỏng một team dự án sau khi tích hợp AgentFlow: bốn workflow dùng chung một
bot Jira, mỗi workflow bắt đầu bằng một label; người review ở mỗi lần bàn giao.

```
Jira LD-n (raw requirement)
  │ label ba-analyze
  ▼
① BA analysis ── hỏi trên Jira ─► Reply vào comment câu hỏi ─► PRD ─► review bằng label
  │   (harness BA team, repo knowledge)          prd-approved / prd-revise
  │   archive vào leavedesk-knowledge ─► PR knowledge ─► đính kèm full PRD vào ticket
  │   + comment tóm tắt PRD
  │
  │ người: label ready-for-dev và label qc-design (chạy song song)
  ├──────────────────────────────────────────────┐
  ▼                                              ▼
② Dev implementation                            ③ QC design ─► test case từ PRD-<KEY>.md
  │   hỏi (nếu có) ─► plan ─► implement (TDD)        hỏi trên Jira (nếu có) ─► đính kèm
  │   ─► đính kèm PLAN-<KEY>.md                      TESTCASES-<KEY>.md ─► PR leavedesk-qa
  │   PR leavedesk-app + PR leavedesk-superpowers
  │
  │ người: review + merge các PR vào main, label ready-for-qc
  ▼
④ QC run (runner-qc) ─► tự động hoá TESTCASES bằng Playwright, chạy trên main
      (harness QC team)  ─► comment kết quả + ảnh lên Jira ─► PR leavedesk-qa
                         ─► label qc-passed (→ Done) / qc-failed (→ To Do)
```

## Dự án mô phỏng

**LeaveDesk** — quản lý nghỉ phép cho *Sao Mai Software* (công ty giả lập ~120
người, Hà Nội + TP.HCM). Chọn vì: ai cũng hiểu nghiệp vụ, có luật thật (Bộ luật
Lao động 2019: 12 ngày phép, thâm niên, ngày lễ), đủ quy tắc để BA phải hỏi
(carry-over, nửa ngày, thông báo trước, phê duyệt hai cấp) nhưng app vẫn nhỏ
(Node 24 + Express + SQLite + React, chạy bằng `npm start`, không dịch vụ ngoài).

| Thành phần | Nội dung |
|---|---|
| `workshop/leavedesk-app` | App khởi điểm: đăng nhập, dashboard, danh bạ, 8 tài khoản demo (`Password123!`), `LEAVEDESK_TODAY` để giả lập ngày. 8 test Vitest. |
| `workshop/leavedesk-knowledge` | Knowledge base: chính sách nghỉ phép v3.1 (nguồn sự thật), ghi chú Bộ luật LĐ, ngày lễ 2026/2027, 4 biên bản họp, 5 quyết định D-001..005, 3 change request CR-001..003 (2 cái **chưa chốt** để BA phải hỏi), mô tả hệ thống, template PRD, chỉ mục requirements. `.claude/`: BA agent team do harness sinh. |
| `workshop/leavedesk-superpowers` | Toolkit Dev: 11 skill của obra/superpowers v7.0.0 dạng project skill (bỏ worktree/finishing-branch vì AgentFlow lo branch + PR); `work/<KEY>/` chứa spec, plan, report mỗi ticket. |
| `workshop/leavedesk-qa` | Playwright 1.64.1, script chạy app với DB sạch + ngày giả lập (`scripts/run-e2e.sh`), smoke test, format test case/kết quả. `.claude/`: QC agent team do harness sinh. |
| Project AgentFlow | **LeaveDesk** (`PRO-1`): 4 repo trên, runner `runner-1` + `runner-qc`, agent instructions (`agent-instructions.md`). |
| Workflow | `ba-workflow.yaml`, `dev-workflow.yaml`, `qc-design-workflow.yaml`, `qc-workflow.yaml` (QC run) — mỗi cái có process riêng (`agent.process`) và toolkit riêng. |
| Runner QC | `runner-qc`: image `agentflow-runner:qc` (`runner-qc/Dockerfile`) = image runner + Chromium của Playwright. |
| Ticket | `tickets/F01..F12` (raw requirement, giọng stakeholder, có chỗ mơ hồ có chủ đích); `create-jira-tickets.mjs` tạo chúng trong Jira. |
| PRD tham chiếu | `prds/F01..F10`: PRD "đáp án" để so với PRD BA bot viết, và dùng dán thẳng vào ticket nếu muốn bỏ qua bước BA. |

## Bốn workflow

Cả bốn dùng một connection Jira (key `jira`, một bot, một webhook). Quy ước label
chung:

- Trigger chỉ là **label được thêm** (`jira.issue_conditions` với `labels`); ticket
  không cần assign cho bot.
- BA, Dev và QC design **giữ label** đến khi run xong hoặc lỗi (QC run vẫn gỡ `ready-for-qc` khi bắt đầu).
- Run dừng hỏi → bot comment câu hỏi. Trả lời bằng **một Reply vào chính comment câu hỏi đó** → run
  đó tự chạy tiếp, không cần đụng label. Hệ thống biết reply thuộc run nào qua comment cha, nên Dev
  và QC design chạy song song không lẫn.
- Run xong hoặc lỗi → label bị gỡ, nên gắn lại sau đó là chạy lại từ đầu.
- Thay đổi label do chính bot làm bị bỏ qua, nên workflow này không tự kích hoạt workflow kia.

### ① BA analysis (`ba-workflow.yaml`, label `ba-analyze`, runner-1)

- **Process**: toolkit `leavedesk-knowledge` (mount `.claude/agents`, `.claude/skills`).
  1. `analyze` — `/ba-requirement analyze <KEY>`: đọc ticket + knowledge base + code
     hiện tại, phân tích, `questions: ask` (câu hỏi có lựa chọn + khuyến nghị),
     viết PRD theo template. PRD thành **document PRD** của project; review trên
     Jira: label `prd-approved` → xong, comment + label `prd-revise` → vòng sửa.
  2. `archive` — `/ba-requirement archive <KEY>`: ghi `requirements/<KEY>/`
     (raw, analysis, questions + answers, prd), cập nhật index, quyết định mới;
     `finish: push` → PR vào `leavedesk-knowledge`.
- **Actions**: chuyển In Progress + comment khi nhận; `input.needed` → comment
  câu hỏi (đánh a/b/c, khuyến nghị) hoặc yêu cầu review (kèm link PRD); PR
  knowledge. Cuối step archive, agent upload `PRD-<KEY>.md` (toàn văn PRD) bằng
  `$AGENTFLOW_ATTACH` và đăng **một comment tóm tắt PRD** kèm file đó (`source: [comment]`
  của step; instruction action không chạy được lệnh nên không upload được). Không gắn
  label hay link. Run Dev đọc full PRD từ file đính kèm này bằng tool
  `source_item_attachment_read`.

### ② Dev implementation (`dev-workflow.yaml`, label `ready-for-dev`, runner-1)

- **PRD/Issue**: `agent.prd.instruction` — description tự nó là PRD (FR + AC) thì nhập là PRD;
  ticket đã qua BA (yêu cầu thô + comment tóm tắt PRD) nhập là **Issue**, vì PRD đã có từ run
  BA.
- **Đọc PRD**: do prompt quyết định. Step `plan` và `implement` có `connections: { source: read }`
  nên có tool `source_item_attachment_read`; instruction bảo agent: ticket có file
  `PRD-<KEY>.md` thì đọc nó bằng tool đó (host tải file bằng token Jira, runner không cần),
  không có thì PRD là description. Dev không đọc `leavedesk-knowledge/` (repo đó chỉ để BA
  phân tích và archive).
- **Process**: toolkit `leavedesk-superpowers` (mount `.claude/skills`).
  1. `plan` (`role: plan`, `questions: ask`) — skill `writing-plans` từ PRD →
     `work/<KEY>/spec.md`, `plan.md`; plan thành Implementation Plan của run.
  2. `implement` (`role: implement`) — `subagent-driven-development` + TDD +
     `verification-before-completion`; commit theo task trên branch của run;
     release notes. AgentFlow push **cả hai repo** → 2 PR.
- **Actions**: In Progress; comment khi plan xong; câu hỏi lên Jira; PR; comment
  tóm tắt + `{{pr.urls}}`, label `dev-done`, chuyển In Review.
- **Bàn giao cho QC**: cuối step `implement`, agent upload `PLAN-<KEY>.md` (plan đã tick)
  lên ticket bằng `$AGENTFLOW_ATTACH` (`source: [comment]`); comment tóm tắt nhắc tới file này.
- **Biến thể Personal Runner** (`dev-personal-workflow.yaml`): Dev chạy trên máy Ubuntu của
  dev (`an-PRO-1`) với credential git/Gitea/Jira của dev; agent tự push và mở PR. Xem
  [dev-machine/README.md](dev-machine/README.md).


### ③ QC design (`qc-design-workflow.yaml`, label `qc-design`, runner-1)

- Chạy ngay khi PRD đã duyệt, song song với Dev; code chưa có tính năng nên chỉ dùng app
  để biết quy ước (test id, route, user demo).
- **Process**: toolkit `leavedesk-qa`. Một step `design` (`questions: ask`, `finish: push`,
  grant `source: [comment]`): đọc `PRD-<KEY>.md` bằng `source_item_attachment_read`, chạy
  phase 1 (phân tích), 2 (thiết kế) và phần review test case của skill `qa-test` →
  `test-cases/<KEY>.md`. AC không quyết được → câu hỏi lên Jira (Reply vào comment
  câu hỏi). Hết câu hỏi → đính kèm `TESTCASES-<KEY>.md` + comment tóm tắt.
- **Actions**: comment khi nhận; câu hỏi; PR `leavedesk-qa` (test case); web link tới PR.

### ④ QC run (`qc-workflow.yaml`, label `ready-for-qc`, **runner-qc**)

- Chỉ chạy sau khi các PR Dev đã merge vào `main` (QC test `main`).
- **Process**: toolkit `leavedesk-qa`. Một step `test` (`finish: push`,
  grant `source: [comment]`): lấy test case từ `TESTCASES-<KEY>.md` (không thiết kế lại,
  case không chạy được thì BLOCKED kèm lý do), `/qa-test <KEY>` bỏ phase 2 →
  spec `e2e/<KEY>.spec.ts`, chạy app đã merge + Playwright (`run-e2e.sh`),
  `results/<KEY>/report.md` + ảnh; rồi upload ảnh bằng `$AGENTFLOW_ATTACH` và
  `source_item_comment` kèm attachments — **upload đi qua API trên host**, runner
  không giữ token Jira.
- **Actions**: comment khi nhận; PR `leavedesk-qa`; đọc verdict → label
  `qc-passed` + Done, hoặc `qc-failed` + To Do.
- **Nguồn**: chỉ từ ticket. QC đọc `TESTCASES-<KEY>.md`, `PRD-<KEY>.md` (kết quả mong đợi) và `PLAN-<KEY>.md` (route,
  file, test id) bằng `source_item_attachment_read`, lưu vào `.agentflow-ai/work/qa/`, cộng với
  comment (câu trả lời BA, tóm tắt Dev). Không đọc `leavedesk-knowledge/` hay `leavedesk-superpowers/`.


### Mọi loại action đang dùng được (để trình diễn)

| Action | BA | Dev | QC |
|---|---|---|---|
| `jira.update_labels` | gỡ `ba-analyze` khi xong / lỗi | gỡ `ready-for-dev` khi xong / lỗi | gỡ `ready-for-qc` |
| `jira.transition_issue` | In Progress | In Progress | — |
| `jira.add_link` (URL tĩnh) | repo knowledge | repo app | repo qa |
| `jira.add_comment` | nhận việc, lỗi | nhận việc, plan xong, bắt đầu implement, lỗi | nhận việc, bắt đầu test, lỗi |
| `agentflow.instruction` | câu hỏi / review | câu hỏi; tóm tắt + label + In Review + link từng PR | — (step tự comment kèm ảnh); verdict → label + Done/To Do + link PR |
| `local_git.create_pull_request` | PR knowledge | PR app + PR superpowers | PR qa |
| `webhook.post` (`connection: http`, **đang tắt**) | mọi run event → event feed | như BA | như BA |
| `agentflow.email` | `input.needed`, `workflow.failed` → admin (Mailpit) | như BA | như BA |

Event feed (action đang tắt, bật lại `enabled` của `webhook.post` khi muốn trình diễn): `python3 docs/workshop/event-feed.py` (cổng 4545) in từng sự kiện; email xem ở
http://localhost:8025. Teams, Confluence, Azure DevOps, GitHub, Bitbucket chưa có
connection nên chưa dùng.

### Vì sao chia như vậy (trả lời câu hỏi "upload kết quả nằm ở skill hay step")

- **Toolkit (skill) chỉ làm nghề**: thiết kế test, chạy, viết báo cáo, và *chuẩn
  bị* đầu ra theo một hợp đồng file cố định (`results/<KEY>/jira-comment.md`,
  `evidence.txt`). Skill không biết Jira hay AgentFlow → dùng lại được ở chỗ khác.
- **Process (step instruction) nối với hệ thống**: đọc các file hợp đồng đó và
  gọi tool của AgentFlow (`$AGENTFLOW_ATTACH`, `source_item_comment`) trong phạm vi
  grant của step. Quyền ghi lên Jira nằm ở YAML, người duyệt nhìn thấy.
- **Workflow actions lo phần chung**: chuyển trạng thái, label, PR, comment tóm tắt.

Hợp đồng đầu ra cho skill của team (BA, QC): ghi vào **đường dẫn cố định** (`.agentflow-ai/work/<team>/…` hoặc trong repo của team), câu hỏi vào `.agentflow-ai/work/questions.json`, không tự tạo branch/commit, không tự gọi Jira.

## Thiết lập (đã xong)

| | |
|---|---|
| Jira | Project `LD` trên `shawn-team.atlassian.net`; một bot (connection **Jira**, webhook) |
| Webhook Jira | URL của connection: `https://discount-heaven-horse-suffering.trycloudflare.com/webhooks/integrations/<inbound key>` + secret (Settings → Integrations → Jira), JQL `project = LD`, sự kiện Issue created/updated + Comment created/updated |
| Project connection | LeaveDesk → Integrations: key **`jira`**, project keys `LD` |
| Workflow | 3 workflow tạo từ 3 file YAML (sửa trong Workflows → Configuration, hoặc sửa file rồi lưu lại) |
| Bot | Quyền Browse, comment, sửa issue (label), transition, **đính kèm file** trên `LD` |
| Trạng thái Jira | `To Do`, `In Progress`, `In Review`, `Done` (tên transition giống tên trạng thái) |
| Model provider | Cần cho **cả** `runner-1` và `runner-qc` (Settings → Compute & Integrations) |

Tạo ticket: `JIRA_SITE=https://shawn-team.atlassian.net JIRA_EMAIL=… JIRA_TOKEN=… node create-jira-tickets.mjs --only F01,F02,F03,F04,F05`
(dùng tài khoản của **bạn**, không phải bot: thay đổi do bot làm bị bỏ qua; ticket
tạo ra không có label nên chưa có gì chạy).

## Chạy thử (5 ticket, đảm bảo setup đúng)

Chạy tuần tự từng ticket qua cả 4 workflow, merge PR trước khi sang ticket sau
(F02 dựa trên F01…).

| Lượt | Ticket | Điều cần quan sát |
|---|---|---|
| 1 | F01 Leave balances | BA hỏi về cách hiển thị unpaid/wedding (raw cố ý mơ hồ); PRD có bảng ví dụ thâm niên (Lan 13 ngày, Khoa 5 ngày); Dev tạo `leave_ledger` (D-003); QC cần ngày cố định 2026-10-19. |
| 2 | F02 Request leave | BA phải tìm ra notice rule là *cảnh báo* (§4.2), hỏi "reason có bắt buộc"; Dev xử lý nửa ngày + chồng lấn; QC có nhiều biên (ngày quá khứ, cuối năm). |
| 3 | F03 Approve | Phê duyệt hai cấp unpaid > 5 ngày, người không có manager → HR (D-005). |
| 4 | F04 Public holidays | Raw cố ý "let's discuss" → BA phải hỏi chuyện request đã có khi đổi ngày lễ. |
| 5 | F05 Cancel | Trạng thái cancellation_requested, ledger `restore`; QC cần `@today` khác (2026-11-03). |

Một lượt đầy đủ (mọi thao tác trên Jira bằng tài khoản của bạn):

1. Gắn label `ba-analyze` → run BA (In Progress, comment; label còn đến khi run xong).
2. Bot hỏi → **Reply vào comment câu hỏi** ("1a, 2b") → run tự chạy tiếp. Lặp nếu cần.
3. Bot đăng PRD để review → đọc PRD trong AgentFlow → label `prd-approved`
   (hoặc comment yêu cầu sửa + label `prd-revise`).
4. Archive → bot đính kèm `PRD-<KEY>.md` vào ticket + comment tóm tắt PRD → PR
   `leavedesk-knowledge`.
5. Merge PR knowledge (http://localhost:3300) để archive, rồi gắn **cả hai** label
   `ready-for-dev` (run Dev) và `qc-design` (run QC design), chạy song song.
6. Dev: câu hỏi của plan (nếu có) → Reply vào comment câu hỏi của Dev → implement →
   2 PR + `PLAN-<KEY>.md` → review + merge cả hai vào `main`.
7. QC design: câu hỏi (nếu có) → Reply vào comment câu hỏi của QC design → `TESTCASES-<KEY>.md`
   + PR test case → merge.
8. Khi code đã merge: gắn label `ready-for-qc` → QC run trên runner-qc → comment kết quả kèm
   ảnh → PR `leavedesk-qa` → merge.

Muốn tiết kiệm thời gian ở một lượt: bỏ bước 1–4, dán PRD tham chiếu (`prds/F0n-*.md`)
vào description và đi từ bước 5.


## Workshop (5 ticket còn lại)

F06 Team calendar, F07 Notifications, F08 Year-end carry-over (đinh của buổi:
cap chưa chốt CR-002, ngày 31/12 giả lập), F09 Delegation, F10 Reports & CSV.
Dự phòng: F11 Coverage warning, F12 Balance adjustments.

Gợi ý trình diễn: chạy BA của 2–3 ticket song song (chỉ đọc + 1 PR knowledge mỗi
cái), Dev tuần tự (cùng codebase), QC ngay sau khi merge.

## Chi phí và thời gian (ước lượng, thay bằng số thật sau khi chạy thử)

| Workflow | Thời gian | Ghi chú |
|---|---|---|
| BA | 10–20 phút + thời gian người trả lời/review | đọc ~25 file knowledge |
| Dev | 40–90 phút | subagent-driven-development, mỗi task một subagent |
| QC | 20–40 phút | build app + Playwright |

## Kết quả

(điền sau khi chạy)
