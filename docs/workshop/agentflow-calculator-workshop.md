# Workshop AgentFlow: từ ticket Jira đến pull request (ứng dụng Calculator bằng React)

Tài liệu cho người dẫn workshop. Đội sẽ thấy một BA tạo ticket trên Jira và
assign cho bot của AgentFlow; AgentFlow tự nhập ticket (là PRD hay Issue do AI
phân loại), lập kế hoạch, hỏi lại trên Jira khi chưa rõ, chờ người duyệt kế
hoạch, viết code React có test, mở pull request trên Local Git, viết release
notes, và báo từng bước lên chính ticket đó. Sau đó cả đội xem lại mọi dữ liệu
AgentFlow ghi nhận: document, loop, session, agent, action và các lời gọi tới
Jira của agent.

Các file đi kèm, cùng thư mục `docs/workshop/`:

| File | Dùng để |
|---|---|
| `jira-tickets/smoke-1-contributing-guide.md` | Ticket thử 1: đi hết luồng tới pull request |
| `jira-tickets/smoke-2-license.md` | Ticket thử 2: từ chối kế hoạch → `workflow.failed` |
| `jira-tickets/prd-1-basic-calculator.md` | PRD 1: máy tính cơ bản (dựng app) |
| `jira-tickets/prd-2-keyboard-and-history.md` | PRD 2: bàn phím và lịch sử phép tính |
| `jira-tickets/prd-3-memory-percent-dark-mode.md` | PRD 3: phím nhớ, %, ±, √ và dark mode |
| `calculator-process.yaml` | Process của project (Project → Process) |
| `calculator-workflow.yaml` | Workflow (Workflows → New workflow) |
| `event-feed.py` | Màn hình sự kiện: in mỗi event workflow gửi tới bằng HTTP |
| `monitor.sh` | In dữ liệu AgentFlow đã ghi cho project (đọc Postgres) |
| `v1-http/` | Phiên bản trước của workshop (PRD gửi bằng HTTP trigger) |
| `todo-app/` | **Workshop 2** (Todo App): review kế hoạch trên Confluence, review code trên Bitbucket, quyết định bằng label/mention trên Jira |

Trong file ticket: dòng đầu (`# ...`) là **Summary** của ticket, phần còn lại
là **Description**. Dán **toàn bộ** phần Description vào Jira: agent chỉ biết
những gì có trong ticket.

---

## 1. Mục tiêu và thông điệp chính

Sau buổi workshop, người tham dự nắm được:

1. **AgentFlow là gì:** nền tảng giao phần mềm do AI thực hiện nhưng con người
   kiểm soát. AI tạo ra artifact (PRD/Issue → kế hoạch → code → pull request →
   release notes), con người quyết ở các mốc.
2. **Một workflow chạy thế nào:** `trigger → nhập ticket (PRD hay Issue) →
   action trước agent team → process (plan → duyệt → implement → release
   notes) → action trên từng event`. Engine không tự ghi vào Jira; mọi thay
   đổi bên ngoài là một **action** admin cấu hình, chạy trên một **event** của
   run.
3. **Con người ở đâu trong vòng lặp:** trả lời câu hỏi của kế hoạch ngay trên
   Jira (comment có @bot), duyệt kế hoạch trong AgentFlow, review và merge
   pull request trên Local Git.
4. **Dữ liệu nào được ghi lại:** PRD/Issue, Implementation Plan và Release
   notes là document của project; mỗi lần agent chạy là một Loop có Session
   (transcript, token, chi phí) và danh sách Agent đã gọi; mỗi action có kết
   quả, và mọi lần agent đọc/ghi Jira đều được ghi lại.
5. **Agent không giữ credential:** agent chạy trên runner, nhưng mọi thao tác
   với Jira đi qua AgentFlow (MCP → API), được kiểm theo quyền admin cấp.

Câu chốt cho người nghe: *"BA assign ticket cho bot. Từ đó mọi bước đều hiện
trên ticket: AgentFlow hỏi khi chưa rõ, chờ người duyệt, rồi trả về một pull
request có test và release notes."*

## 2. Agenda gợi ý (khoảng 2 giờ 30)

| Thời lượng | Phần | Nội dung |
|---|---|---|
| 10' | Mở đầu | Vấn đề AgentFlow giải quyết, thông điệp chính (mục 1) |
| 15' | Khái niệm và kiến trúc | Mục 3, 4 |
| 25' | Setup | Mục 6: connection, project, process, workflow (đi qua môi trường đã chuẩn bị) |
| 15' | Ticket thử | Mục 7.1, 7.2: một ticket đi hết luồng, một ticket bị từ chối |
| 40' | Demo PRD | Mục 7.3: tạo PRD trên Jira, trả lời câu hỏi, duyệt kế hoạch, xem run |
| 20' | Review, merge, chạy app | Pull request trên Local Git, `npm test`, `npm run dev` |
| 15' | Dữ liệu | Mục 8, 9: Sessions, Agents, action, tool call |
| 10' | Hỏi đáp | |

PRD 1 (dựng cả app) chạy hết process mất **86 phút** và khoảng **19 USD**
(số liệu ở mục 7.3), nên **chạy trước PRD 1 trước buổi workshop**, trình chiếu
kết quả của nó và chỉ chạy live một ticket nhỏ (ticket thử 1).

## 3. Khái niệm chính

| Khái niệm | Trong demo |
|---|---|
| Connection | Tài khoản đã xác thực với hệ thống ngoài: **Jira** (site + tài khoản bot + API token) và **Local Git** (Gitea trong Docker, server cấp sẵn). Credential chỉ nằm ở connection. |
| Project connection | Project dùng một connection của org dưới một **key**: `jira`, chỉ nhận ticket của Jira project `CALC`. Workflow và process gọi connection bằng key này. |
| Project | **Calculator**: repository, runner, agent instructions, process và các document. |
| Project repository | `workshop/calculator-app` trên Local Git. Agent clone và push bằng credential cấp riêng cho từng loop. |
| Runner | `runner-1`: headless runner trong Docker, chạy Claude Code với các plugin của AgentFlow. |
| Process | Các bước của agent team: **Plan → Approve the plan → Implement → Release notes**. |
| Workflow | **Calculator delivery (Jira CALC)**: trigger Jira, cách phân loại PRD/Issue, và các action trên từng event. |
| Trigger | `jira.issue_conditions`: ticket CALC được **assign cho bot**, hoặc có comment **@mention bot**. |
| PRD hay Issue | `agent.prd.instruction`: runner đọc instruction và ticket, quyết định một lần cho mỗi run, ghi lý do. |
| Action | Một việc chạy `on` một event: **instruction** (agent làm theo lời) hoặc **type** (`jira.add_comment`, `local_git.create_pull_request`, ...). |
| Event | `workflow.triggered`, `workflow.started`, `plan.started`, `plan.completed`, `input.needed`, `execute.started`, `execute.completed`, `workflow.completed`, `workflow.failed`. |
| Run | Một lần xử lý một ticket. Trạng thái: `received → ingesting → pre_actions → planning → needs_input/needs_approval → executing → running → succeeded/failed`. |
| Loop | Một lần agent chạy trên runner: `PLAN`, `EXECUTE`, `STEP` (bước agent của process). |
| Session | Phiên Claude Code của một loop: transcript, model, token, chi phí, số tool call. |
| Agent | Các subagent/skill được gọi trong session (pre-explorer, plan-writer, implementation-subagent, ...). |
| Integration tools | Công cụ MCP `agentflow_integrations` cho agent đọc/ghi ticket; AgentFlow kiểm quyền và thực hiện. |

## 4. Kiến trúc của buổi demo

```
 BA (Jira, tài khoản riêng) ── assign / @mention bot ──► Jira Cloud
                                                          │ webhook (secret, qua cloudflared)
                                                          ▼
 Web app :3000 ◄── đọc ── AgentFlow API :3002 ── engine (tick 10 s): run, action, process
                              │   ▲      │  gọi Jira / Local Git bằng credential của connection
                              │   │      └──────────────► Jira, Local Git (Gitea :3300)
                 lệnh (relay) │   │ tool call (MCP :3010 → API, kiểm grant)
                              ▼   │
                      runner-1 (Docker): Claude Code + agent-plugins
                      ├─ quyết định PRD/Issue (không tool)
                      ├─ PLAN / EXECUTE / STEP loop (clone, code, test, push)
                      └─ agent của instruction action (chỉ đọc; ghi qua MCP)
 event-feed.py :4545 ◄── HTTP action (webhook.post) mỗi event
```

Ai gọi Jira:

| Ai | Việc | Đường đi |
|---|---|---|
| **API (server)** | Nhập ticket; action có `type:` (`jira.transition_issue`, `jira.add_comment`, `local_git.create_pull_request`, `webhook.post`) | API gọi thẳng bằng credential của connection; runner không tham gia |
| **Agent trên runner** (instruction action, agent step có `connections:`) | Đọc ticket (`source_item_get`), comment (`source_item_comment`), chuyển trạng thái (`source_item_transition`) | Agent → MCP `agentflow_integrations` (token phiên `ist_…`, chỉ nằm trong env của agent) → API kiểm grant → API gọi Jira. Runner không bao giờ giữ token Jira |
| PLAN, EXECUTE, quyết định PRD/Issue | Không gọi Jira | Nội dung ticket do API đưa vào (document, prompt) |

## 5. Chuẩn bị trước buổi workshop (người dẫn)

### 5.1 Máy và dịch vụ

```bash
cd ~/Projects/agentflow
nvm use                                   # Node 24
docker compose up -d                      # postgres, rustfs, mailpit, local-git
pnpm turbo dev --filter=app --filter=api --filter=mcp
curl -s http://localhost:3002/health      # OK
curl -s http://localhost:3010/health      # OK (MCP: agent dùng integration tools qua đây)
```

### 5.2 Runner

- `docker ps` thấy `agentflow-runner-1` ở trạng thái `healthy`; Settings →
  Compute & Integrations → Local Compute Targets: **runner-1 online**.
- **Model provider** đã cấu hình (proxy hoặc API key), cùng **Claude Code
  version** nếu proxy chỉ nhận một phiên bản.
- File env của runner (`~/.agentflow/runner-1.env`) có
  `AGENTFLOW_MCP_URL=http://host.docker.internal:3010/mcp`, để agent của
  instruction action gọi được integration tools.

### 5.3 Jira

1. **Project CALC** với các status **To Do**, **In Progress**, **In Review**,
   **Done** (workflow chuyển ticket bằng đúng các tên này). Project Jira mới
   chỉ có To Do / In Progress / Done: thêm **In Review** vào workflow của
   project (team-managed: thêm status/cột trên board; company-managed: Project
   settings → Workflows). Thiếu nó thì instruction tóm tắt ở
   `execute.completed` comment được nhưng fail ở bước chuyển trạng thái.
2. **Tài khoản bot riêng.** Kết nối Jira trong AgentFlow dùng một tài khoản
   làm bot (ở đây là "Nobody"). Người tạo và assign ticket phải là **tài
   khoản khác**: AgentFlow bỏ qua mọi event do chính bot gây ra để tránh vòng
   lặp (delivery `ignored`, lý do `caused_by_bot`).
3. **API token của bot**, tạo khi đăng nhập bằng tài khoản bot
   (id.atlassian.com → Security → API tokens): token không có scope, hoặc
   token có scope cho app Jira với đủ `read:jira-user`, `read:jira-work`,
   `write:jira-work`. Thiếu `read:jira-work` thì AgentFlow comment được nhưng
   không đọc được ticket (run fail `source_fetch_failed`, HTTP 401).
4. **Webhook** (Jira Settings ⚙ → System → WebHooks → Create): URL và secret
   lấy ở AgentFlow → Connections → Jira → **Inbound setup**; Events: Issue
   **created**, **updated**, Comment **created**, **updated** (mention bot cần
   event comment); JQL: `project = CALC`.
5. Jira Cloud chỉ gọi URL HTTPS công khai: chạy tunnel
   (`cloudflared tunnel --url http://localhost:3002`) và đặt
   `PUBLIC_WEBHOOK_BASE_URL` trong `apps/api/.env.local` bằng URL tunnel. Quick
   tunnel đổi URL mỗi lần chạy lại: khi đó sửa URL webhook trong Jira.

### 5.4 Tài khoản

| Ở đâu | Tài khoản | Ghi chú |
|---|---|---|
| AgentFlow http://localhost:3000 | owner của org (`admin@agentflow.local`) | Tạo connection, project, workflow; duyệt kế hoạch |
| Jira | BA (tài khoản của người dẫn) | Tạo ticket, assign cho bot, trả lời câu hỏi |
| Jira | bot ("Nobody") | Chỉ dùng cho API token của connection |
| Local Git http://localhost:3300 | `agentflow` | Mật khẩu: `jq -r .password ~/.agentflow/local-git.json` |

### 5.5 Màn hình sự kiện

```bash
python3 docs/workshop/event-feed.py        # nghe ở http://localhost:4545/agentflow
```

Workflow gửi mọi event (trừ `workflow.triggered`) tới đây bằng action HTTP;
mỗi event in một khối: tên event, ticket, trạng thái run, bước, link plan, PR,
lỗi. Để chạy suốt buổi trên một màn hình riêng.

## 6. Setup từng bước

Các đoạn YAML dưới đây đã được kiểm bằng chính parser của trình soạn thảo
trong app (không có lỗi, không có cảnh báo).

### 6.1 Connections

- **Local Git**: server cấp sẵn cho mọi org khi API có `LOCAL_GIT_TOKEN`
  (`pnpm local-git:init --org workshop`); không cần thêm.
- **Jira**: Settings → Compute & Integrations → Connections → **Add
  connection** → Jira:

  ```yaml
  name: Jira
  config:
    deployment: cloud
    siteUrl: https://<site>.atlassian.net
    email: <email của tài khoản bot>
  inbound:
    mode: webhook
  ```

  Nhập **API token** của bot vào ô mật khẩu dưới editor (secret không bao giờ
  nằm trong YAML), Save, rồi **Test**. Connection hiện tên bot (ở đây
  "Nobody"). Sau đó cấu hình webhook như mục 5.3.

### 6.2 Project "Calculator"

1. Tạo project **Calculator** trong team (Teams → team → Projects → **Create
   Project**).
2. Tab **Repositories** → **Add repository** → Local Git → **Create and add**
   → tên `calculator-app`. Repository mới có commit đầu tiên (README) trên
   `main`. Cùng tab, phần **Runners** → chọn `runner-1`.
3. Tab **Overview** → **Agent instructions** (bối cảnh chung cho mọi agent):

   ```markdown
   # Calculator

   A calculator web app that runs in the browser. It is built one PRD at a time: every PRD extends the app that is already on `main` of `workshop/calculator-app`.

   ## Stack (do not change it)

   - React 19 + TypeScript (strict mode) + Vite, current stable versions from npm.
   - Tests: Vitest + @testing-library/react + @testing-library/user-event + jsdom.
   - npm is the package manager: commit `package-lock.json`. No pnpm or yarn.
   - No UI kit, CSS framework or state library: React state/hooks and plain CSS.

   ## Conventions

   - Calculator logic is pure TypeScript under `src/calculator/` (no React imports) and is unit-tested there; React components live under `src/components/`.
   - Scripts: `npm run dev`, `npm run build` (type check + production build), `npm test` (runs once, not watch mode), `npm run typecheck`.
   - Every change keeps `npm run build` and `npm test` passing.
   - Accessibility: every button has an accessible name; the display is an `aria-live="polite"` region.
   - Keep `README.md` current: what the app does and how to install, run, build and test it.
   ```

4. Tab **Integrations** → **Add** → connection Jira, key **`jira`**, name
   "Jira CALC", settings:

   ```yaml
   projectKeys: [CALC]
   ```

   Một Jira project chỉ thuộc một project connection của org: ticket CALC luôn
   đi tới project Calculator.

### 6.3 Process

Project → **Process** → **Edit** → dán `calculator-process.yaml` → Save
(version 1):

```yaml
steps:
  - type: agentflow.plan
    id: plan
    name: Plan
    questions: ask              # open questions stop the run (needs input)
    recommendations: suggest    # keep recommended answers as suggestions
  - type: approval
    id: approve-plan
    name: Approve the plan
  - type: agentflow.execute
    id: implement
    name: Implement
    review: full                # full review; fast skips it (~15 min faster)
  - type: agent
    id: release-notes
    name: Release notes
    instruction: |
      Write short release notes for {{issue.key}} "{{issue.title}}" for the people who use the Calculator app (not for developers).
      ... (đầy đủ trong file)
    reply: .agentflow-ai/work/release-notes.md
    artifacts: [.agentflow-ai/work/release-notes.md]
    document:
      type: DOC
      path: .agentflow-ai/work/release-notes.md
      title: "Release notes: {{issue.key}} {{issue.title}}"
```

Giải thích cho người nghe:

- **Plan** (`agentflow.plan`): các agent lập kế hoạch khám phá repository, viết
  plan (task, câu hỏi mở, khuyến nghị). `questions: ask` +
  `recommendations: suggest`: câu hỏi mở nào cũng dừng run để **người** quyết
  (khuyến nghị chỉ là gợi ý); plan không có câu hỏi thì đi tiếp.
- **Approve the plan** (`approval`): run dừng ở `needs_approval`, admin duyệt
  hoặc từ chối trong AgentFlow (từ chối → run `failed`, lý do
  `approval_rejected`).
- **Implement** (`agentflow.execute`, `review: full`): đánh giá lại plan,
  critic, chốt decision table, implement từng task kèm test, đối chiếu kết
  quả với decision table, review vòng cuối, commit và push branch. Pull
  request do workflow mở.
- **Release notes** (`agent`): một agent đọc yêu cầu, plan và thay đổi trên
  branch, viết release notes cho người dùng app. `reply` → workflow lấy nội
  dung qua `{{steps.release-notes.reply}}`; `document` → thành một document
  DOC của project, link từ trang run.

### 6.4 Workflow

Workflows → **New workflow** → dán `calculator-workflow.yaml` → Save. Tóm tắt:

```yaml
name: Calculator delivery (Jira CALC)
project: Calculator
triggers:
  - connection: jira
    type: jira.issue_conditions
    config:
      match: any            # assigned to the bot OR the bot is mentioned
      assigned: true
      mentioned: true
      projectKeys: [CALC]
agent:
  runAs: admin@agentflow.local
  runner: runner-1
  prd:
    instruction: >-
      PRD when the issue has the label "prd", or when its description is a
      product requirements document: it states goals, functional requirements
      and acceptance criteria. A bug report, a small task or a question is an
      Issue.
actions:   # 10 action, đầy đủ trong file
```

| # | `on` | Action | Làm gì |
|---|---|---|---|
| 1 | `workflow.triggered` | `jira.transition_issue` (`continueOnError`) | Chuyển ticket sang **In Progress** |
| 2 | `workflow.triggered` | instruction, `source: [comment]` (`continueOnError`) | Triage: comment PRD hay Issue và tối đa 3 điểm chưa rõ; lần resume thì chỉ báo "tiếp tục" |
| 3 | 8 event còn lại | `webhook.post` (`connection: http`) | Gửi event tới `event-feed.py` |
| 4 | `plan.completed` | `jira.add_comment` | Comment link plan và trích đoạn (`{{summary}}`) |
| 5 | `input.needed` | instruction, `source: [comment]` | Comment các câu hỏi đánh số kèm khuyến nghị và nhờ trả lời bằng một comment có @bot; hoặc báo plan chờ duyệt |
| 6 | `execute.completed` | `local_git.create_pull_request` | Mở pull request trên Local Git |
| 7 | `execute.completed` | instruction, `source: [comment, transition]` | Comment tóm tắt (file, test, link PR), chuyển sang **In Review** |
| 8 | `workflow.completed` | `jira.add_comment` | Comment release notes (`{{steps.release-notes.reply}}`) và link PR |
| 9 | `workflow.failed` | `jira.add_comment` | Comment lý do và link run (`{{summary}}`) |
| 10 | `workflow.failed` | `jira.transition_issue` | Trả ticket về **To Do** |

Điểm nhấn khi trình bày:

- **Trigger `match: any`**: assign cho bot bắt đầu run; khi run chờ câu hỏi,
  một comment có @bot là câu trả lời và tiếp tục run (cycle mới, kế hoạch
  được sửa lại theo câu trả lời).
- **Action có `type:`** do API thực hiện, luôn trên chính ticket của run
  (không cần chỉ connection). **Instruction** do agent thực hiện; mặc định
  chỉ đọc, `connections:` cấp quyền ghi (`source: [comment, transition]`), và
  mọi lần đọc/ghi hiện trong **Integration tool calls** của run.
- Thứ tự trong danh sách là thứ tự chạy trong cùng một event: action PR (6)
  đứng trước instruction tóm tắt (7) nên instruction thấy `{{pr.url}}`.
- Action 1, 2 chạy trước agent team và chặn nó; lỗi của chúng chỉ không dừng
  run vì có `continueOnError`.
- Phía trên editor, **Configuration guide** liệt kê event, key, template
  variable và ví dụ; phía dưới, **Actions in run order** cho thấy event nào
  chạy action nào, trên connection nào, trước khi lưu.

## 7. Kịch bản chạy

Theo dõi song song: trang run (Workflows → workflow → Runs), ticket Jira,
`event-feed.py`, và `bash docs/workshop/monitor.sh`.

### 7.1 Ticket thử 1: Add a contributing guide

Tạo ticket **Task** trong CALC: Summary và Description từ
`jira-tickets/smoke-1-contributing-guide.md`, **Assignee: bot**.

Diễn biến mong đợi (số liệu thật từ lần chạy thử 13/10, CALC-1):

| Bước | Trạng thái run | Chuyện gì xảy ra | Thấy ở đâu |
|---|---|---|---|
| 1 | `received → ingesting` | Webhook `jira:issue_updated` (assign) → delivery `accepted`, "1 run started". Runner phân loại: **Issue** ("a small Task with no prd label"), khoảng 40 giây. Tạo **ISS-1** và **PLN-1** | Trang run (Work items, lý do phân loại dưới Issue), monitor.sh |
| 2 | `pre_actions` | Ticket → **In Progress**; agent triage đọc ticket và comment (0,23 USD) | Jira, Actions card (Before agents), Integration tool calls |
| 3 | `planning` | Loop PLAN (khoảng 10 phút, 2,03 USD); event feed: `workflow.started`, `plan.started` | Agent loops, Sessions, event feed |
| 4 | `needs_approval` | Plan không có câu hỏi mở → bước **Approve the plan**; Jira: comment plan + comment "chờ duyệt" | Card Process (Approve/Reject), Jira |
| 5 | `executing` | Admin **Approve** (sau khoảng 5 phút) → cycle 2, loop EXECUTE (13 phút, 2,64 USD, 16 agent, 140 tool call), push `symphony/pln-1` | Process card, Agent loops, Sessions |
| 6 | `running` | `execute.completed`: pull request **#1** trên Local Git (`CONTRIBUTING.md`, `README.md`); agent comment tóm tắt lên ticket rồi chuyển **In Review**. Bước **Release notes** (loop STEP, 2,5 phút, 0,29 USD) → **DOC-1** | Local Git, Jira, Actions card, Work items |
| 7 | `succeeded` | `workflow.completed`: comment release notes + link PR; event feed 🎉 | Jira, event feed |

Tổng cộng CALC-1: **33 phút** từ lúc assign tới lúc xong (gồm khoảng 5 phút
chờ duyệt) và khoảng **5,8 USD**: phân loại 0,11 + ba instruction 0,24 mỗi cái
+ PLAN 2,03 + EXECUTE 2,64 + release notes 0,29.

> Lần chạy thử này lộ ra ba lỗi, đã sửa. Vì vậy các comment cũ trên CALC-1
> khác với một lần chạy bây giờ: comment triage ghi "the run did not report
> whether this was imported as a PRD or an Issue", comment tóm tắt ghi "no PR
> link was available", comment release notes thiếu link PR. CALC-2 (mục 7.2)
> xác nhận các bản sửa: PR do action tự tạo, link PR có trong comment tóm tắt
> và comment release notes, loop release notes ghi đúng chi phí của chính nó.
> Sau khi thêm In Review, action tóm tắt của CALC-1 được **Retry**: agent
> comment lại kèm link PR #1 và chuyển ticket sang In Review. Muốn có một
> ticket mẫu sạch để trình chiếu thì tạo lại ticket thử 1.

### 7.2 Ticket thử 2: Add an MIT license (từ chối)

Tạo **Task** từ `jira-tickets/smoke-2-license.md`, assign cho bot. Nếu plan có
câu hỏi (ví dụ năm bản quyền), trả lời bằng comment @bot như mục 7.3 trước:
run sửa lại plan rồi mới tới bước duyệt. Khi run tới **Approve the plan**, bấm
**Reject** kèm lý do (ví dụ "Not now: legal decides the license"). Mong đợi:
run `failed` (`approval_rejected`), event `workflow.failed`: comment lý do lên
ticket, ticket về **To Do**, event feed hiện ⚠️.

Lần chạy thử 13/10 cần hai ticket và cho thấy thêm vài điều nên kể:

- **CALC-2: lỡ bấm Approve.** Không sao: run chạy tiếp như ticket thử 1 và
  thành công (PLAN 7,7 phút 1,78 USD; EXECUTE 12,9 phút 2,96 USD; release
  notes 0,26 USD; pull request #2). Process chỉ có một bước duyệt, nên muốn
  thử nhánh từ chối thì tạo ticket mới cùng nội dung. Đừng merge PR của ticket
  trước: nếu `LICENSE` đã có trên main, plan có thể hỏi lại thay vì tới bước
  duyệt.
- **Cancel không thay được Reject.** Cancel (trang run) đưa run sang
  `cancelled` mà không phát event nào: không có comment lỗi, ticket không về
  To Do.
- **CALC-3: cùng nội dung nhưng plan có câu hỏi**, CALC-2 thì không: agent
  không trả lời y hệt nhau giữa các lần chạy. Bot comment câu hỏi kèm gợi ý
  (năm 2026) và mention người tạo ticket.
- **Trả lời qua Jira:** comment "@Nobody 1. Use 2026" (mention chọn từ danh
  sách) → delivery `accepted`, "1 run resumed" → cycle 2: action 1-2 chạy lại
  (triage comment "resuming work… The answer "Use 2026" sets the copyright
  year"), plan được sửa (7 phút, 2,10 USD; lần lập đầu 10,6 phút, 2,21 USD),
  rồi tới bước duyệt.
- **Reject** kèm lý do → run `failed` ngay với lỗi `"Approve the plan" was
  rejected: <lý do>`; comment "⚠️ AgentFlow could not complete CALC-3: …
  Details: <link run>", ticket về **To Do**, event feed ⚠️ kèm lỗi. Event feed
  của CALC-3 có 8 event: 🚀 🧭 📝 ❓ (câu hỏi), 🧭 📝 ❓ (chờ duyệt), ⚠️.
- Bị từ chối không đổi document: Issue vẫn `IN_PROGRESS`, plan vẫn `DRAFT`.

### 7.3 Các PRD của Calculator

Ba PRD xây dần một ứng dụng: chạy theo thứ tự và **merge pull request của PRD
trước rồi mới tạo PRD sau**.

| PRD | Nội dung chính | Phụ thuộc |
|---|---|---|
| Basic calculator | Dựng app React + TypeScript + Vite + Vitest; bàn phím 4 cột; + − × ÷ kiểu máy tính bỏ túi; chia cho 0; 12 chữ số; C và ⌫; accessibility | Không |
| Keyboard input and calculation history | Gõ phím (numpad, Enter, Esc, Backspace); lịch sử 20 phép gần nhất, bấm để dùng lại; `localStorage` | Basic calculator đã merge |
| Memory, percent, sign, square root and dark mode | MC/MR/M+/M−, %, ±, √; bố cục 4×7; dark mode theo hệ điều hành và nhớ lựa chọn | Basic calculator đã merge |

Tạo mỗi PRD: Jira → Create → loại **Story**, Summary = dòng đầu file,
Description = phần còn lại, **Label: `prd`**, **Assignee: bot**.

Khi plan có câu hỏi (thường gặp với PRD lớn): bot comment danh sách câu hỏi
đánh số. Trả lời **tất cả trong một comment có @bot**, ví dụ:

```
@Nobody
1. Yes, keep the result when an operator follows `=`.
2. Use the recommendation.
```

Run tiếp tục ở cycle mới: action 1-2 chạy lại (triage chỉ báo "tiếp tục"),
PRD được nhập lại kèm comment trả lời, kế hoạch được **sửa lại** (không lập
lại từ đầu) theo câu trả lời, rồi tới bước duyệt.

Vì sao các PRD viết như vậy: hành vi được mô tả bằng ví dụ cụ thể (bảng
acceptance criteria), có các quy tắc "khó" để thấy cách xử lý tình huống biên
(`2 + 3 × 4 = 20`, `0.1 + 0.2 = 0.3`, chia cho 0), phạm vi rõ ràng (Out of
scope), và stack chung nằm ở agent instructions của project.

Khi viết ticket: đừng để inline code dính liền chữ (`` `9`s ``). Jira không
hiển thị được kiểu đó và gửi nguyên `{{9}}s` cho AgentFlow.

#### Kết quả PRD 1: Basic calculator (CALC-4, 14/10)

| Bước | Giờ (UTC+7) | Chuyện gì xảy ra | Thời gian, chi phí |
|---|---|---|---|
| 1 | 08:28 | Assign cho bot → run; runner phân loại **PRD** ("has the label PRD, and its description is a full product requirements document") → **PRD-1**, **PLN-4** | 26 giây, 0,12 USD |
| 2 | 08:29 | In Progress; triage comment "picked up CALC-4 … imported as a PRD" kèm 3 điểm chưa rõ | 42 giây, 0,24 USD |
| 3 | 08:29 | Loop PLAN lần 1 → plan có **1 câu hỏi** (AC-10) kèm câu trả lời gợi ý; Jira: comment plan + comment câu hỏi | 16,6 phút, 3,05 USD |
| 4 | 08:48 | Người tạo ticket trả lời "@Nobody 1: as suggested" → "1 run resumed", cycle 2; triage chỉ báo "work resumes" | 1,5 phút chờ người |
| 5 | 08:49 | Loop PLAN lần 2 sửa plan theo câu trả lời → bước **Approve the plan**; Jira: comment plan + comment chờ duyệt | 11,0 phút, 3,14 USD |
| 6 | 09:02 | Admin **Approve** → loop EXECUTE: 333 lượt, 466 tool call, 51 subagent (implement từng task, verify, behavior-verifier, build-validator) | 3 phút chờ người; 50 phút, 11,45 USD |
| 7 | 09:53 | Pull request **#3** (20 file, +3.463 dòng, trong đó 2.284 là `package-lock.json`); comment tóm tắt (87 test: 68 logic, 11 định dạng, 8 giao diện) + **In Review** | 50 giây, 0,25 USD |
| 8 | 09:54 | Release notes (loop STEP) → **DOC-3**; comment release notes; event feed 🎉 | 1,3 phút, 0,38 USD |

Tổng: **86 phút** từ lúc assign tới lúc xong (4,5 phút trong đó là chờ người),
**19,2 USD** (4 loop 18,02 + 5 instruction 1,10 + phân loại 0,12). Event feed có
10 event: 🚀 🧭 📝 ❓ (câu hỏi), 🧭 📝 ❓ (chờ duyệt), 🛠️ ✅ 🎉. Trên Jira có 8
comment của bot. Pull request #3 mergeable; `npm ci`, `npm test` (87 test),
`npm run typecheck`, `npm run build` đều qua.

Hai điều nên kể từ lần chạy này:

- **Câu hỏi đến từ chính PRD.** Dòng AC-10 viết "17 × `9` → sixteen `9`s":
  dấu × đọc như phép nhân, còn `` `9`s `` thì Jira không hiển thị được (xem lưu
  ý ở trên). Triage và plan đều phát hiện chỗ này và hỏi lại kèm gợi ý; người
  tạo ticket chỉ cần trả lời "1: as suggested". File PRD đã viết lại dòng này
  (`` `9` `` bấm 17 lần → `9999999999999999`), nên lần chạy sau có thể không có
  câu hỏi.
- **Bản nhập PRD-1 mất định dạng code** (lỗi đã sửa ngày 14/10, sau lần chạy
  này): inline code thành chữ thường, `<button>` biến mất, sơ đồ bàn phím không
  còn là khối code. Nguyên nhân: Jira trả về HTML có `<tt>` và `<pre>`, bộ
  chuyển sang markdown không giữ hai thẻ này. Agent vẫn làm đúng, nhưng muốn
  trình chiếu trang PRD-1 đẹp thì tạo lại PRD 1.

#### Kết quả PRD 2: Keyboard input and calculation history (CALC-5, 14/10)

Lần chạy đầu (10:44) **thất bại** ở loop PLAN với `PLAN_MISSING_AT_COMPLETION`
sau 16 phút và 5,36 USD: bản nháp plan cần hơn 10 phút, Claude Code dừng nó, và
`run-loop.sh` vẫn coi lượt đó là xong (mục 10). Các action `workflow.failed`
chạy đúng cấu hình: comment lỗi, ticket về To Do, event feed ⚠️. Sau khi sửa
runner, bỏ assign rồi assign lại cho bot tạo **run mới với document mới**
(PRD-3, PLN-6); PRD-2 và PLN-5 của lần đầu giữ nguyên.

| Bước | Giờ (UTC+7) | Chuyện gì xảy ra | Thời gian, chi phí |
|---|---|---|---|
| 1 | 14:05 | Assign lại → run mới; phân loại **PRD** ("has the label PRD and its description states goals, functional requirements and acceptance criteria") → **PRD-3**, **PLN-6** | 19 giây, 0,11 USD |
| 2 | 14:06 | In Progress; instruction thấy ticket đã được triage ở lần trước nên chỉ comment "work picks up again" | 42 giây, 0,22 USD |
| 3 | 14:06 | Loop PLAN lần 1: `plan-draft-writer` chạy nền **26 phút** (trước đây bị cắt ở phút 10) → plan có **3 câu hỏi** kèm gợi ý; Jira: comment plan + comment câu hỏi | 40,5 phút, 5,09 USD |
| 4 | 14:52 | Người tạo ticket trả lời 3 câu → cycle 2. Một câu trả lời khác gợi ý (Enter trên nút đang focus: vừa bấm nút vừa chạy `=`), instruction nêu rõ điểm này trong comment | 4 phút chờ người |
| 5 | 14:52 | Loop PLAN lần 2 sửa plan theo câu trả lời → **Approve the plan**; Jira: comment plan + comment chờ duyệt | 18,5 phút, 3,28 USD |
| 6 | 15:37 | Admin **Approve** → loop EXECUTE (58 agent, 16 component) | 25 phút chờ người; 57 phút, 13,86 USD |
| 7 | 16:35 | Pull request **#4** (17 file, +1.683 / −10 dòng); comment tóm tắt (`keymap.ts`, `history.ts`, `History.tsx`, test) + **In Review** | 50 giây, 0,28 USD |
| 8 | 16:35 | Release notes → **DOC-4**; comment release notes; event feed 🎉 | 1,2 phút, 0,42 USD |

Tổng: **2 giờ 31 phút** từ lúc assign tới lúc xong (29 phút trong đó là chờ
người), **23,9 USD** (4 loop 22,65 + 5 instruction 1,11 + phân loại 0,11). 21
action đều `succeeded`, 10 event trên event feed, 8 comment của bot. Pull
request #4 tạo từ `main` đã merge PR #3; `npm ci`, `npm test` (**235 test**, từ
87), `npm run typecheck`, `npm run build` đều qua.

Session: SES-16 và SES-17 (hai lần PLAN, 9 và 5 agent), SES-18 (EXECUTE: 58
agent, +1.693 dòng, PR #4, 122 LOC/$), SES-19 (release notes). Không còn
"agent" là lệnh shell chạy nền.

Điều nên kể từ PRD 2: **câu trả lời của người có thể khác gợi ý của agent**, và
plan được sửa theo người (Enter trên nút đang focus). Workflow cũng cho thấy
cách phục hồi: run lỗi không hỏng ticket, chỉ cần assign lại.

### 7.4 Event nào, action nào, thấy ở đâu

| Event | Khi nào | Trên Jira | Event feed |
|---|---|---|---|
| `workflow.triggered` | Ticket được nhập, trước agent team | In Progress + comment triage | (không gửi) |
| `workflow.started` | Bước đầu tiên bắt đầu (một lần mỗi run) | | 🚀 |
| `plan.started` | Loop PLAN bắt đầu | | 🧭 |
| `plan.completed` | Kế hoạch xong | Comment link plan + trích đoạn | 📝 |
| `input.needed` | Kế hoạch có câu hỏi, hoặc chờ duyệt | Comment câu hỏi / "chờ duyệt" | ❓ |
| `execute.started` | Loop EXECUTE bắt đầu | | 🛠️ |
| `execute.completed` | Push xong | PR + comment tóm tắt + In Review | ✅ |
| `workflow.completed` | Release notes xong, run thành công | Comment release notes | 🎉 |
| `workflow.failed` | Run dừng vì lỗi hoặc bị từ chối | Comment lý do + To Do | ⚠️ |

## 8. Xem dữ liệu

| Màn hình | Chỉ cho người nghe |
|---|---|
| Workflow → Runs → run | Stepper (Received → Importing → Triggered actions → Planning → Implementing → Done); card **Process** (bước hiện tại, câu hỏi, Approve/Reject, file của bước); **Work items** (Issue/PRD kèm lý do phân loại, plan, release notes, PR); **Agent loops**; **Actions** (mỗi action trên mỗi event, note của instruction, retry); **Integration tool calls** |
| Issue / PRD | Nội dung nhập từ Jira (cả comment), trạng thái |
| Implementation Plan | Task, câu hỏi mở và khuyến nghị, decision table, phiên bản. Checklist task vẫn là `[ ]` sau khi implement: document giữ bản kế hoạch đã duyệt (version của loop PLAN), loop EXECUTE không ghi đè. Tiến độ xem ở loop EXECUTE, PR, comment tóm tắt |
| Agent Evaluation (PRD, Plan, Issue) | **Actions → Evaluate PRD / Evaluate Plan / Evaluate Issue**: một loop trên runner chạy plugin `judges`, mỗi "giám khảo" (agent) chấm một khía cạnh theo vài tiêu chí, điểm 0-1 so với ngưỡng, kèm giải thích; kết quả từng giám khảo là Passed / Needs improvement / Failed. Chỉ để tham khảo, không chặn workflow. PRD-1: 5 giám khảo, 7 phút, 1,38 USD. PLN-4: 16 giám khảo, 12 phút, 3,33 USD |
| Release notes (DOC) | Document do bước agent xuất ra |
| Sessions | Mỗi loop một session: transcript, model, token, chi phí, agent. Session EXECUTE: **Lines changed** (số dòng agent sửa, hoặc tổng của branch so với main), **LOC / $** (số dòng đó chia chi phí) và **Pull requests** (link tới PR trên Local Git). Session EXECUTE của PRD 1 (SES-11): +3.463 dòng "branch total", 11,45 USD, LOC/$ 302, PR #3, 52 agent |
| Agents | Danh mục subagent/skill/command của các plugin, với số lần gọi và số session dùng (ví dụ sau PRD 1: `code:implementation-subagent` 19 lần, `code:plan-validate` 18 lần) |
| Local Git | Branch `symphony/<plan>`, Pull requests |

```bash
bash docs/workshop/monitor.sh       # delivery, run, action, tool call, loop, document, session, agent
```

## 9. Checklist kiểm tra dữ liệu

Sau mỗi run, `bash docs/workshop/monitor.sh` phải cho thấy:

| Phần | Đúng khi |
|---|---|
| Jira deliveries | Event assign/mention: `accepted`, `run_count` 1. Event do bot gây ra (comment của AgentFlow): `ignored` `caused_by_bot` là đúng |
| Runs | `imported_as` FEATURE (Issue) hoặc PRD kèm lý do; `status` succeeded; `pr_url` có giá trị; `source_doc` (ISS-n/PRD-n) và `plan` (PLN-n) có |
| Action runs | Mỗi event có đủ action: `workflow.triggered` 2, `workflow.started` 1, `plan.started` 1, `plan.completed` 2, `input.needed` 2, `execute.started` 1, `execute.completed` 3, `workflow.completed` 2. Mỗi vòng hỏi đáp thêm một lượt `workflow.triggered`, `plan.started`, `plan.completed`, `input.needed` (PRD 1: 21 action run). Không có `skipped`; `failed` chỉ khi có lý do (ví dụ thiếu In Review) |
| Integration tool calls | `source_item_get`, `source_item_comment` (có `external_ref` là id comment Jira), `source_item_transition` succeeded. Khi Retry một action, lời gọi có input giống hệt lần trước (ví dụ chuyển In Review) dùng lại dòng cũ: giờ tạo là của lần đầu, trạng thái là của lần Retry |
| Loops | PLAN, EXECUTE, STEP `COMPLETED`, cùng branch `symphony/pln-n`; mỗi loop có token và cost riêng |
| Documents | Issue `IN_REVIEW` hoặc PRD `EXECUTED` (đã giao để review), plan `APPROVED`, DOC release notes; link `PRODUCES` từ Issue/PRD tới plan và DOC. Run bị từ chối không đổi document (Issue `IN_PROGRESS`, plan `DRAFT`) |
| Sessions | Mỗi loop một session: model, số agent, số tool, token, cost, repo `workshop/calculator-app` và branch `symphony/pln-n`. Session EXECUTE có `lines_added`/`files_changed` (dòng agent sửa) và `branch_lines_added` (diff của branch, nguồn `git`) và PR trong `pull_requests` (kèm URL). Session PLAN và release notes không có số dòng: chúng chỉ sửa file làm việc của AgentFlow |
| Agents | PLAN: `code:pre-explorer`, `code:plan-draft-writer`, `code:plan-validator`; EXECUTE: `code:plan-evaluator`, `code:implementation-subagent`, `code:verification-subagent`, `code:build-validator`; EXECUTE của một PRD thêm `code:plan-writer`, `code:cross-repo-coordinator`, `code:behavior-verifier`, `code:dev-environment`; các skill `code:*`. Chỉ subagent mới được liệt kê: lệnh shell chạy nền không phải agent |

Ngoài monitor: trên Jira có comment triage, comment plan, comment chờ duyệt
(hoặc câu hỏi), comment tóm tắt, comment release notes, và ticket ở **In
Review**; trên Local Git có pull request mở, mergeable; event feed có đủ 7 event
của một run thành công (từ 🚀 tới 🎉; mỗi vòng hỏi đáp thêm 🧭 📝 ❓).

## 10. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Có delivery nhưng `ignored`, lý do `caused_by_bot` | Người tạo/assign ticket chính là tài khoản bot của connection | Thao tác bằng tài khoản khác (mục 5.3) |
| Delivery `ignored`, `no_relevant_change` | Thay đổi không liên quan tới trigger (sửa field khác) | Assign cho bot hoặc comment có @bot |
| Run `failed` ngay, `source_fetch_failed`, HTTP 401; comment lỗi vẫn đăng được | API token có scope nhưng thiếu `read:jira-work` | Tạo lại token (mục 5.3), dán vào connection Jira |
| Không có delivery nào | Sai URL/secret webhook, tunnel đổi URL, JQL không khớp | Inbound setup của connection; sửa webhook trong Jira |
| Transition fail "not found" | Workflow Jira không có transition tên đó, hoặc ticket đã ở trạng thái đó | Thêm status/transition, hoặc sửa tên trong YAML; action trước agent team có `continueOnError` nên run vẫn chạy |
| Instruction tóm tắt `failed`: `No transition "In Review" is available` | Workflow Jira của CALC thiếu status In Review (comment tóm tắt vẫn đã đăng) | Thêm In Review (mục 5.3), rồi Actions card → **Retry** action đó: agent comment lại (kèm link PR) và chuyển ticket. Nếu comment cũ đã đủ thì kéo tay ticket sang In Review: đổi status bằng tay không tạo run mới (`no_relevant_change`) |
| Tool call `source_item_get` failed "Could not reach Jira" | Mạng từ API tới Atlassian chập chờn | Agent tự gọi lại; xem Integration tool calls |
| Run kẹt ở `needs_input` | Câu hỏi chưa được trả lời | Comment trả lời có @bot (mục 7.3) |
| Comment trả lời nhưng run không chạy tiếp (delivery `ignored`, `no_relevant_change`) | Gõ chữ "@Nobody" mà không chọn bot trong danh sách gợi ý, nên Jira không tạo mention | Gõ `@` rồi chọn bot trong danh sách |
| Run kẹt ở `needs_approval` | Chưa ai duyệt | Card Process → Approve/Reject (admin) |
| Lỡ bấm **Approve** thay vì Reject | Process chỉ có một bước duyệt | Để run chạy tiếp; thử từ chối bằng ticket mới (mục 7.2). Cancel không thay được: run `cancelled`, không có `workflow.failed` |
| PRD/Issue nhập vào mất định dạng: inline code thành chữ thường, `<placeholder>` biến mất, sơ đồ thành các dòng rời; mã ticket trong comment hiện `![](…avatar…)CALC-4 In Progress`; mention là link dài | Bản API trước 14/10 không giữ `<tt>`/`<pre>` trong HTML Jira trả về, và chuyển nguyên khối mã ticket (icon, link, trạng thái) của Jira | Đã sửa (`apps/api/lib/integrations/markdown.ts`): code giữ nguyên, mã ticket thành `[CALC-4](link)`, mention thành `@Tên`. Document nhập trước đó giữ nội dung cũ |
| PRD hiện `{{9}}s` hoặc dấu ngoặc nhọn lạ | Inline code dính liền chữ trong ticket; Jira không hiển thị được | Viết tách ra (mục 7.3) |
| Danh sách agent của session có một "agent" tên là một lệnh shell | Runner trước 14/10 coi lệnh Bash chạy nền là subagent | Đã sửa trong runner (rebuild image); session cũ vẫn giữ dòng đó |
| Agent Evaluation: một giám khảo `Failed`, điểm 0, giải thích "Judge execution failed … safeguards flagged the request" | API của model chặn request của giám khảo đó. Plugin báo lỗi, nhưng AgentFlow chỉ có ba trạng thái nên ghi là Failed | Không phải nhận xét về document: chạy lại Evaluate |
| Evaluate Plan chấm plan so với chính nó (`prd.md` trong thư mục làm việc của loop là plan) | Runner trước 14/10 lấy document chính (plan) cho cả `prd.md` | Đã sửa trong runner; chạy lại Evaluate Plan |
| Session vẫn hiện PR "Open" sau khi merge trên Local Git | Trạng thái PR được ghi lúc action mở PR; AgentFlow không theo dõi PR của Local Git sau đó | Xem trạng thái thật trên Local Git |
| Run `failed` `plan_failed`, loop PLAN lỗi `PLAN_MISSING_AT_COMPLETION` ("no plan.json was ever written") | Agent điều phối chạy `plan-draft-writer` ở chế độ nền rồi kết thúc lượt; Claude Code ở chế độ `-p` chỉ chờ task nền 10 phút sau lượt cuối rồi dừng nó (PRD 2: bản nháp cần hơn 10 phút) | Đã sửa (14/10): loop đặt `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` để chờ tới khi subagent xong; `run-loop.sh` chỉ coi là xong khi chính agent viết `<promise>COMPLETE</promise>` (trước đó chuỗi này trong file hướng dẫn agent đọc cũng được tính), nên một lượt dừng sớm sẽ chạy tiếp lượt sau. Chạy lại ticket: bỏ assign rồi assign lại cho bot |
| Trang chi tiết run (và mọi URL lồng nhiều cấp như `teams/…/projects/…`) hiện "Page not found", dù run vẫn chạy | Cache dev của Next (`apps/app/.next/dev`) hỏng, URL rơi vào trang catch-all 404 | Dừng dev server, xoá `apps/app/.next/dev`, chạy lại `pnpm turbo dev --filter=app --filter=api --filter=mcp` |
| Run `failed` `execute_failed` (hoặc `plan_failed`), loop lỗi `CLAUDE_AUTH_CHALLENGE`: "401 OAuth access token has expired" | Thông tin đăng nhập Claude mà runner dùng đã hết hạn (với Model provider kiểu proxy: token phía sau proxy) | Làm mới token của provider. Rồi: chạy lại cả ticket (bỏ assign, assign lại bot; run mới lập plan lại từ đầu), hoặc bấm **Retry Implement** trên trang run để chỉ chạy lại bước đó (xem "Chạy lại bước bị lỗi hoặc bị cancel" dưới bảng) |
| Run `failed` `compute_target_unavailable` | runner-1 offline | `docker ps`, `docker logs agentflow-runner-1` |
| Loop lỗi `426 Outdated Claude Code version` | Proxy chỉ nhận một phiên bản | Model provider → Claude Code version |

### Chạy lại bước bị lỗi hoặc bị cancel

Khi run `failed` vì nguyên nhân bên ngoài (token model hết hạn, runner tắt)
hoặc bạn đã **Cancel run** lúc đang Planning/Implementing, admin bấm
**Retry <tên bước>** (ví dụ **Retry Implement**) trên header trang run. Bước đó
chạy lại trong một loop mới, ở cycle mới; run giữ PRD, plan đã duyệt và các câu
trả lời, không lập plan lại. Các action của bước (`execute.started`, ...) chạy
lại; action `workflow.failed` đã chạy (comment lỗi, To Do) vẫn giữ nguyên. Sửa
nguyên nhân trước khi bấm. Không có nút Retry khi run lỗi trước khi lập plan
(assign lại ticket) hoặc khi plan bị Reject.

## 11. Vì sao một ticket nhỏ mất 30 phút và vài USD

Câu hỏi hay gặp. Với CALC-1 (thêm một file tài liệu):

- **PLAN** và **EXECUTE** không phải một lời gọi model mà là một đội agent:
  PLAN 123 lượt, 5 agent; EXECUTE 199 lượt, 16 agent (đánh giá plan,
  implement, kiểm chứng, build, review). `review: full` thêm các vòng đánh giá
  và kiểm chứng đó.
- Mỗi lượt đọc lại toàn bộ ngữ cảnh: phần lớn token là **cache read** (PLAN
  1,6 triệu, EXECUTE 3,0 triệu), giá chỉ khoảng 10% token input thường. Token
  output chỉ khoảng 30 nghìn mỗi loop. Vì vậy "hơn 1 triệu token" phần lớn là
  cache, và cost (2-3 USD mỗi loop) mới là con số đáng nhìn.
- Mỗi instruction action là một phiên Claude Code ngắn (khoảng 0,24 USD,
  chủ yếu là system prompt và công cụ được cache).

CALC-2 (thêm `LICENSE` và một đoạn README) cũng vậy: PLAN 1,78 + EXECUTE 2,96
+ release notes 0,26 USD, khoảng 21 phút agent chạy. Mỗi câu hỏi làm plan chạy
thêm một lần: CALC-3 tốn 4,31 USD cho hai lần lập plan (2,21 + 2,10) dù cuối
cùng bị từ chối.

PRD 1 (dựng cả app, 20 file, 87 test) lớn hơn hẳn: **19,2 USD** và 86 phút.
EXECUTE chiếm 11,45 USD và 50 phút (333 lượt, 466 tool call, 51 subagent, 18,4
triệu token mà phần lớn là cache read). Hai lần lập plan (một câu hỏi) tốn 6,19
USD, các instruction action 1,10 USD, release notes 0,38 USD.

PRD 2 (bàn phím và lịch sử, 17 file, 235 test) tốn **23,9 USD**: hai lần lập
plan (3 câu hỏi) 8,37 USD, EXECUTE 13,86 USD và 57 phút. Lần chạy đầu bị lỗi
runner đã tốn thêm 5,36 USD (mục 10).

Cách giảm khi cần: `review: fast` ở bước Implement (bỏ vòng review, nhanh hơn
khoảng 15 phút); một workflow riêng cho Task nhỏ với process gọn hơn (ví dụ chỉ
một bước `agent` có `finish: push`); model rẻ hơn cho runner.

## 12. Chạy lại workshop từ đầu

- Cách nhanh: tạo repository mới (Project → Integrations → Create and add),
  gỡ repository cũ, rồi tạo lại ticket.
- Cách sạch: project mới + workflow mới trỏ tới project đó (một Jira project
  chỉ thuộc một project connection, nên dùng Jira project khác hoặc gỡ
  project connection cũ).
