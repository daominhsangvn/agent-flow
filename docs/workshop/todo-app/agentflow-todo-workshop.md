# Workshop AgentFlow 2: review plan trên Confluence, review code trên Bitbucket (ứng dụng Todo App)

Tài liệu cho người dẫn workshop. Workshop 1 (Calculator,
`docs/workshop/agentflow-calculator-workshop.md`) cho thấy một ticket Jira đi
tới pull request: duyệt kế hoạch bằng một nút trong AgentFlow, pull request
trên Local Git. Workshop này đi tiếp, đúng quy trình một đội đang làm tay:

1. BA viết PRD trong ticket Jira và assign cho bot.
2. Agent lập kế hoạch, hỏi lại trên Jira khi chưa rõ, rồi **đăng kế hoạch lên
   Confluence** và gắn link vào ticket.
3. Reviewer **comment trên trang Confluence**; người phụ trách gắn label
   `replan` (hoặc comment @bot). Agent đọc comment, sửa kế hoạch, trả lời và
   resolve từng comment. Lặp lại tới khi gắn label `plan-approved`.
4. Agent implement, push, viết release notes; workflow mở **pull request trên
   Bitbucket**.
5. Reviewer **comment trên pull request**; người phụ trách comment @bot trên
   Jira (hoặc gắn `fix-review`). Agent sửa code, trả lời và resolve từng
   thread, push lên cùng branch. Lặp lại tới khi gắn `code-done`.
6. Product owner gắn `ship-it`: release notes lên Jira và thành một trang
   Confluence, ticket sang **Done**.

Mọi quyết định đều làm được ngay trên Jira (label, comment @bot) **hoặc** trên
trang run của AgentFlow (Approve / Replan, Done / Request changes, Reject).

Các file đi kèm, thư mục `docs/workshop/todo-app/`:

| File | Dùng để |
|---|---|
| `jira-tickets/smoke-1-editorconfig.md` | Ticket thử 1: đi hết luồng bằng các nút trong AgentFlow |
| `jira-tickets/smoke-2-changelog.md` | Ticket thử 2: từ chối ở bước review kế hoạch |
| `jira-tickets/prd-1-todo-list.md` | PRD 1: danh sách todo (dựng app). Kịch bản chính, mục 7.3 |
| `jira-tickets/prd-2-due-dates-priorities-search.md` | PRD 2: hạn, độ ưu tiên, sắp xếp, tìm kiếm. Các biến thể, mục 7.4 |
| `todo-process.yaml` | Process của project (Project → Process) |
| `todo-workflow.yaml` | Workflow (Workflows → New workflow) |
| `../event-feed.py`, `../monitor.sh` | Dùng chung với workshop 1 (`monitor.sh "Todo App"`) |

Trong file ticket: dòng đầu (`# ...`) là **Summary**, phần còn lại là
**Description**. Dán **toàn bộ** Description vào Jira: agent chỉ biết những gì
có trong ticket. Các đoạn cần copy-paste trong lúc chạy (câu trả lời, comment
review) nằm ngay trong mục 7.

> Trạng thái: kịch bản và cấu hình đã kiểm bằng parser của editor và
> validation khi lưu của API (không lỗi, không cảnh báo), **chưa chạy thử
> end-to-end**. Thời gian và chi phí trong tài liệu là ước lượng theo số liệu
> workshop 1; ghi số thật vào mục 7 sau lần chạy thử.

---

## 1. Mục tiêu và thông điệp chính

Sau buổi workshop, người tham dự nắm được:

1. **AgentFlow chạy theo quy trình của đội, không bắt đội đổi quy trình.**
   Review kế hoạch vẫn ở Confluence, review code vẫn ở Bitbucket, quyết định
   vẫn ở Jira. AgentFlow cung cấp năng lực (vai trò bước, vòng review, tool,
   quyền) còn *cách làm* nằm trong instruction của process.
2. **Vòng review là vòng lặp thật.** Mỗi lần "yêu cầu sửa" là một **round**:
   cùng bước agent chạy lại, tiếp tục đúng phiên Claude Code trước đó
   (`--resume`), nên agent nhớ mình đã làm gì và chỉ sửa phần được yêu cầu.
3. **Con người quyết ở đâu cũng được:** label và mention trên Jira cho người
   không dùng AgentFlow, nút trên trang run cho người dùng AgentFlow. Cả hai
   ghi vào cùng một lịch sử review.
4. **Agent không giữ credential và chỉ chạm đúng chỗ được phép:** đọc/ghi
   Confluence chỉ trong space của project, trả lời/resolve chỉ trên pull
   request của chính run, label/link chỉ trên ticket của run. Mọi lần gọi đều
   được ghi lại.
5. **Mọi thứ thành dữ liệu:** kế hoạch có một version mỗi round, release notes
   thành document, lịch sử review ghi ai quyết gì qua kênh nào.

Câu chốt: *"Đội review như mọi khi, trên Confluence và Bitbucket. Khác biệt
duy nhất: thay vì tự sửa, họ gắn một label và agent sửa, trả lời từng comment,
rồi chờ họ duyệt lại."*

## 2. Agenda gợi ý (khoảng 3 giờ)

| Thời lượng | Phần | Nội dung |
|---|---|---|
| 10' | Mở đầu | Nhắc lại workshop 1, vấn đề workshop này giải quyết (mục 1) |
| 15' | Tính năng mới và kiến trúc | Mục 3, 4 |
| 25' | Setup | Mục 6: ba connection, project, process, workflow |
| 15' | Ticket thử | Mục 7.1, 7.2: đi hết bằng nút AgentFlow, rồi một lần từ chối |
| 60' | PRD 1, kịch bản chính | Mục 7.3: câu hỏi → review trên Confluence → review trên Bitbucket → ship |
| 20' | PRD 2, biến thể | Mục 7.4: quyết định trong AgentFlow, tín hiệu xếp hàng |
| 20' | Dữ liệu | Mục 8, 9: lịch sử review, version kế hoạch, tool call, session |
| 15' | Hỏi đáp | |

PRD 1 dựng cả app và có hai vòng review, nên chạy hết mất khoảng **2 giờ**
(ước lượng; workshop 1: một PRD tương đương mất 86 phút với một lần duyệt).
**Chạy trước PRD 1 tới hết round 1 của review kế hoạch trước buổi workshop**,
rồi chạy live từ cảnh D (mục 7.3), hoặc chạy trước toàn bộ và trình chiếu.

## 3. Tính năng mới trong workshop này

| Tính năng | Cấu hình | Thấy ở cảnh |
|---|---|---|
| **Vai trò bước** `role: plan` | Bước agent tự lập kế hoạch: AgentFlow buộc ghi kế hoạch vào `.agentflow-ai/work/plan.md`, giữ nó thành Implementation Plan của run, mỗi round một version | 7.3 B, C, E |
| **Vai trò bước** `role: implement` | Nạp kế hoạch đã duyệt trước khi chạy, luôn push, phát `execute.*` | 7.3 G, I |
| **Release notes** | Bước implement tự viết, thành document DOC (version mỗi round); biến `{{releaseNotes}}`, `{{releaseNotes.url}}` | 7.3 G, K |
| **Vòng review** `review:` | Sau bước agent, run chờ: đi tiếp (`approve` / `complete`) hay chạy lại với feedback | 7.3 C–J |
| **Tín hiệu bằng label** | `plan-approved`, `replan`, `code-done`, `fix-review`, `ship-it` gắn trên ticket | 7.3 D, F, J, K |
| **Tín hiệu bằng mention** | Comment @bot khi đang review = feedback; nội dung comment là feedback | 7.3 H |
| **Nút review trong AgentFlow** | Approve / Replan (bước plan), Done / Request changes (bước khác), Reject | 7.1, 7.2, 7.4 |
| **Label cho bước approval** | `approve: { labels: [ship-it] }` | 7.3 K |
| **Tín hiệu xếp hàng** | Label gắn khi bước còn đang chạy được giữ lại, áp dụng khi bước bắt đầu chờ | 7.4 |
| **Label tự gỡ** | Label feedback (`replan`, `fix-review`) được AgentFlow gỡ sau khi dùng, để gắn lại được | 7.3 E, I |
| **Label và link trên ticket** | Action `jira.update_labels`; tool `source_item_link` (agent gắn link trang kế hoạch) | 7.3 A, C |
| **Confluence** | Connection mới; agent đọc trang/comment, tạo/sửa trang, trả lời, resolve, chỉ trong space TODO; action `confluence.create_page` | 7.3 C, E, K |
| **Tool review pull request** | `pull_requests_list`, `pull_request_threads`, `pull_request_reply`, `pull_request_resolve` (Bitbucket Cloud, Azure DevOps) | 7.3 I |
| **Retry bước** | Nút Retry trên run bị lỗi | Mục 10 |

## 4. Kiến trúc của buổi demo

```
 BA / reviewer / PO (tài khoản Atlassian riêng)
   │ assign, label, @mention          │ comment trang kế hoạch     │ comment pull request
   ▼                                  ▼                            ▼
 Jira Cloud (TODO)              Confluence Cloud (space TODO)   Bitbucket Cloud (todo-app)
   │ webhook (qua cloudflared)        ▲                            ▲
   ▼                                  │ REST, credential của connection, chỉ space TODO
 AgentFlow API :3002 ── engine: run, process, review, action ──────┘
   ▲   │ lệnh (relay)
   │   ▼
   │  runner-1 (Docker): Claude Code
   │   ├─ bước Plan (role: plan): kế hoạch → plan.md
   │   ├─ bước Implement (role: implement): code, test, push, release notes
   │   └─ tool call qua MCP :3010 (confluence_*, pull_request_*, source_item_*)
   └─── kiểm grant, rồi API gọi Confluence / Bitbucket / Jira
 event-feed.py :4545 ◄── webhook.post mỗi event
```

Ai gọi hệ thống nào:

| Ai | Việc | Đường đi |
|---|---|---|
| **API (server)** | Nhập ticket; action có `type:` (transition, label, comment, mở PR, trang release notes); **gỡ label feedback** | Gọi thẳng bằng credential của connection |
| **Agent bước Plan** | Đọc/tạo/sửa trang kế hoạch, đọc/trả lời/resolve comment Confluence; gắn link lên ticket | MCP → API kiểm grant (`wiki: [...]`, `source: [comment, link]`) và space TODO |
| **Agent bước Implement** | Đọc thread, trả lời, resolve trên pull request của run | MCP → API kiểm grant (`pull_requests: [reply, resolve]`), chỉ PR của run |
| **Git trên runner** | Clone, push branch | Credential cấp riêng cho từng loop |

Label và mention dùng trong demo:

| Tín hiệu | Khi run chờ ở | Nghĩa | Trong AgentFlow tương đương |
|---|---|---|---|
| comment @bot | Câu hỏi của kế hoạch (`needs_input`) | Câu trả lời | Form trả lời câu hỏi |
| `plan-approved` | Review kế hoạch | Duyệt kế hoạch | **Approve** |
| `replan` hoặc comment @bot | Review kế hoạch | Lập lại theo feedback | **Replan** |
| `code-done` | Review code | Review code xong | **Done** |
| `fix-review` hoặc comment @bot | Review code | Sửa theo review | **Request changes** |
| `ship-it` | Release sign-off | Duyệt phát hành | **Approve** |
| (không có trên Jira) | Bất kỳ review nào | Dừng run (`review_rejected`) | **Reject** |

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

Vai trò bước và release notes cần runner build từ checkout này (runner cũ
không biết hợp đồng `role`, chỉ nhận prompt sửa lỗi). Build lại image và tạo
lại container khi runner rảnh:

```bash
docker buildx build -f deploy/runner/Dockerfile -t agentflow-runner:base .
docker rm -f agentflow-runner-1
# chạy lại container như lúc tạo (env ~/.agentflow/runner-1.env, 5 volume)
```

Kiểm: Settings → Compute & Integrations → **runner-1 online**; file env có
`AGENTFLOW_MCP_URL=http://host.docker.internal:3010/mcp`; model provider đã
cấu hình.

### 5.3 Tài khoản bot Atlassian

Một tài khoản Atlassian riêng làm bot cho cả ba sản phẩm (ở môi trường hiện
tại là "Nobody"; tài liệu này gọi là **AgentFlow Bot**). Người tạo ticket,
comment và gắn label phải là **tài khoản khác**: AgentFlow bỏ qua mọi event do
chính bot gây ra (delivery `ignored`, lý do `caused_by_bot`).

| Sản phẩm | Quyền của bot | Token |
|---|---|---|
| Jira | Browse, Create/Edit issues, Add comments, Transition, Edit labels trong project TODO | API token **không scope** (dùng chung cho Jira và Confluence), hoặc token có scope app Jira: `read:jira-user`, `read:jira-work`, `write:jira-work` |
| Confluence | Space TODO: View, Add pages, Add comments, Resolve comments (Space settings → Permissions) | Cùng token không scope, hoặc token có scope app Confluence: `read:confluence-user`, `read:page:confluence`, `write:page:confluence`, `read:comment:confluence`, `write:comment:confluence`, `read:space:confluence`, `search:confluence` |
| Bitbucket | Member của workspace, quyền Write trên repository `todo-app` | **Token có scope**, app Bitbucket: `read:user`, `read:workspace`, `read:repository`, `write:repository`, `read:pullrequest`, `write:pullrequest` (đều `:bitbucket`). Bitbucket không nhận token không scope |

Tạo token khi đăng nhập bằng tài khoản bot: id.atlassian.com → Security →
API tokens.

### 5.4 Jira

1. Project **TODO** (Scrum hoặc Kanban) với các status **To Do**, **In
   Progress**, **In Review**, **Done**. Project mới chỉ có To Do / In Progress
   / Done: thêm **In Review** (team-managed: thêm cột trên board;
   company-managed: Project settings → Workflows).
2. **Webhook** (Jira Settings ⚙ → System → WebHooks): URL và secret lấy ở
   AgentFlow → Connections → Jira → **Inbound setup**; Events: Issue
   **created**, **updated**, Comment **created**, **updated**; JQL:
   `project = TODO`. Nếu dùng lại webhook của workshop 1, sửa JQL thành
   `project in (CALC, TODO)`.
   - **Issue updated** mang thay đổi label: thiếu nó thì label không phải tín
     hiệu.
   - **Comment created** mang mention: thiếu nó thì @bot không trả lời được
     câu hỏi, không là feedback.
3. Tunnel cho webhook: `cloudflared tunnel --url http://localhost:3002`, đặt
   `PUBLIC_WEBHOOK_BASE_URL` trong `apps/api/.env.local`; quick tunnel đổi URL
   mỗi lần chạy lại, khi đó sửa URL webhook trong Jira.
4. Label không cần tạo trước: Jira tạo khi gắn lần đầu. Nên gắn thử mỗi label
   (`prd`, `plan-approved`, `replan`, `code-done`, `fix-review`, `ship-it`)
   lên một ticket nháp rồi gỡ, để chúng có trong gợi ý.

### 5.5 Confluence

1. Tạo space **Todo App**, key **TODO** (Create → Space → Blank space; key
   đặt ở Space settings nếu Confluence tự sinh key khác).
2. Trong space, tạo trang cha **AgentFlow documents**. Mở trang, lấy **page id**
   trong URL: `.../wiki/spaces/TODO/pages/`**`123456`**`/AgentFlow+documents`.
   Kế hoạch (`TODO-n Implementation plan`) và release notes (`TODO-n Release
   notes`) sẽ nằm dưới trang này.
3. Cấp quyền cho bot trong space (mục 5.3).

Confluence không gửi webhook cho AgentFlow: comment trên trang không tự kích
hoạt gì. Người review comment xong thì báo qua Jira (label `replan` hoặc
@bot). Đó là chủ ý: một người quyết khi nào đủ comment để agent làm một vòng.

### 5.6 Bitbucket

1. Workspace (ví dụ `acme-workshop`), repository **todo-app**, private, có
   `README.md` trên `main` (Create repository → Include a README: Yes).
2. Bot là member của workspace, Write trên repository.
3. Người review dùng tài khoản của mình: comment trên pull request như bình
   thường (comment chung hoặc comment trên dòng code).

Comment trên pull request cũng không tự kích hoạt gì (webhook pull request là
phần sau, Part 7 của plan): người phụ trách báo qua Jira.

### 5.7 Tài khoản trong buổi demo

| Ở đâu | Tài khoản | Vai |
|---|---|---|
| AgentFlow http://localhost:3000 | owner của org (`admin@agentflow.local`) | Setup; nút Approve / Done / Reject |
| Jira | BA (người dẫn) | Tạo ticket, trả lời câu hỏi, gắn label |
| Confluence | reviewer (người dẫn hoặc một người tham dự) | Comment trên trang kế hoạch |
| Bitbucket | reviewer | Comment trên pull request |
| Jira, Confluence, Bitbucket | bot | Chỉ dùng cho token của connection |

Có thể dùng một tài khoản người cho cả ba vai; chỉ cần khác tài khoản bot.

### 5.8 Màn hình sự kiện

```bash
python3 docs/workshop/event-feed.py         # http://localhost:4545/agentflow
bash docs/workshop/monitor.sh "Todo App"     # dữ liệu AgentFlow ghi cho project
```

## 6. Setup từng bước

YAML dưới đây đã kiểm bằng parser của editor trong app và validation khi lưu
của API.

### 6.1 Connections

Settings → Compute & Integrations → Connections → **Add connection**. Secret
không bao giờ nằm trong YAML: nhập vào ô mật khẩu dưới editor, Save, rồi
**Test**; connection hiện tên tài khoản bot.

- **Jira**: dùng lại connection của workshop 1 nếu cùng site. Nếu tạo mới:

  ```yaml
  name: Jira
  config:
    deployment: cloud
    siteUrl: https://<site>.atlassian.net
    email: <email của bot>
  inbound:
    mode: webhook
  ```

- **Confluence** (mới), cùng site và cùng bot:

  ```yaml
  name: Confluence
  config:
    siteUrl: https://<site>.atlassian.net
    email: <email của bot>
  ```

  Secret: **API token**. Token có scope chỉ chạy qua Atlassian API gateway:
  Test thấy site trả 401 thì tự thử qua gateway và lưu `cloudId` (không cần
  làm gì).

- **Bitbucket**:

  ```yaml
  name: Bitbucket
  config:
    workspace: acme-workshop
  ```

  Secret: **token** (Atlassian API token có scope của bot, mục 5.3).

### 6.2 Project "Todo App"

1. Tạo project **Todo App** trong team (Teams → team → Projects → **Create
   Project**).
2. Tab **Repositories** → **Add repository** → connection Bitbucket → chọn
   `acme-workshop/todo-app`. Cùng tab, phần **Runners** → `runner-1`.
3. Tab **Overview** → **Agent instructions**:

   ```markdown
   # Todo App

   A to-do list web app that runs in the browser, without a server. It is built one PRD at a time: every PRD extends the app that is already on `main` of `todo-app`.

   ## Stack (do not change it)

   - React 19 + TypeScript (strict mode) + Vite, current stable versions from npm.
   - Tests: Vitest + @testing-library/react + @testing-library/user-event + jsdom.
   - npm is the package manager: commit `package-lock.json`. No pnpm or yarn.
   - No UI kit, CSS framework or state library (no Redux, Zustand, MobX): React state, context and hooks, and plain CSS.

   ## Conventions

   - Todo logic (adding, editing, filtering, sorting, storage) is pure TypeScript under `src/todos/` (no React imports) and is unit-tested there; React components live under `src/components/`.
   - Scripts: `npm run dev`, `npm run build` (type check + production build), `npm test` (runs once, not watch mode), `npm run typecheck`.
   - Every change keeps `npm run build` and `npm test` passing.
   - Accessibility: every control has an accessible name and works with the keyboard alone.
   - Keep `README.md` current: what the app does and how to install, run, build and test it.

   ## Review

   - Plans are reviewed on Confluence (space TODO), code on the Bitbucket pull request. Reviewers may be wrong: when a comment goes against the requirement or these instructions, say so politely in your reply instead of following it.
   ```

4. Tab **Integrations** → **Add**, hai project connection:

   | Connection | Key | Tên | Settings |
   |---|---|---|---|
   | Jira | **`jira`** | Jira TODO | `projectKeys: [TODO]` |
   | Confluence | **`wiki`** | Confluence TODO | xem dưới |

   ```yaml
   spaceKeys: [TODO]
   parentPageId: "123456"      # page id của "AgentFlow documents" (mục 5.5)
   ```

   Key `wiki` là tên process và workflow dùng để gọi Confluence. Space không
   bị "chiếm" như Jira project: nhiều project có thể dùng chung space TODO.
   Mọi thao tác Confluence (agent hay action) bị từ chối nếu trang nằm ngoài
   `spaceKeys`, kể cả khi link trang nằm trong nội dung ticket.

### 6.3 Process

Project → **Process** → **Edit** → dán `todo-process.yaml` → Save (version 1).
Ba bước:

```yaml
steps:
  - type: agent
    id: plan
    name: Plan
    role: plan                    # writes the run's Implementation Plan (versions per round)
    questions: ask                # open questions stop the run; answer on Jira with @bot
    instruction: |
      Plan {{issue.key}} ... publish it to Confluence ... (đầy đủ trong file)
    review:
      approve: { labels: [plan-approved] }
      feedback: { labels: [replan], mention: true }
      instruction: |
        Apply the review of the plan: read the open comments of the Confluence page,
        change the plan, update the page in storage format, answer and resolve ... (đầy đủ trong file)
    connections:
      source: [comment, link]
      wiki: [confluence.create_page, confluence.update_page, confluence.comment, confluence.resolve_comment]

  - type: agent
    id: implement
    name: Implement
    role: implement               # loads the approved plan, pushes, writes release notes
    instruction: |
      Implement the approved plan ... npm ci, typecheck, test, build pass ... (đầy đủ trong file)
    review:
      complete: { labels: [code-done] }
      feedback: { labels: [fix-review], mention: true }
      instruction: |
        Address the code review: pull_requests_list, pull_request_threads, fix,
        reply, resolve ... (đầy đủ trong file)
    connections:
      source: [comment]
      pull_requests: [reply, resolve]

  - type: approval
    id: release-sign-off
    name: Release sign-off
    approve: { labels: [ship-it] }
```

Giải thích cho người nghe:

- **Plan** là một bước `agent` với `role: plan` thay vì `agentflow.plan` của
  workshop 1, vì chỉ bước `agent` có `review:` và `connections:`.
  `role: plan` làm ba việc: thêm hợp đồng vào `CLAUDE.md` của bước (kế hoạch
  cuối cùng ghi vào `.agentflow-ai/work/plan.md`), giữ file đó thành
  Implementation Plan của run (một version mỗi round), và phát
  `plan.started` / `plan.completed`. Bước kết thúc mà không có kế hoạch thì
  được nhắc một lần, vẫn không có thì fail.
- Instruction của bước nói **cách làm của đội**: hỏi gì, đăng kế hoạch lên
  trang nào, đặt link ở đâu. AgentFlow không biết gì về "trang kế hoạch":
  agent dùng tool `confluence_*` và `source_item_link` được cấp trong
  `connections:`.
- **`review:` của Plan:** sau mỗi round run chờ (`needs_approval`).
  `plan-approved` (hoặc Approve) duyệt kế hoạch và sang bước sau.
  `replan` hoặc một comment @bot (hoặc Replan) chạy lại bước, **tiếp tục phiên
  cũ** với feedback và phần `review.instruction` (đọc comment Confluence, sửa,
  trả lời, resolve).
- **Implement** (`role: implement`): trước khi agent chạy, AgentFlow ghi version
  mới nhất của kế hoạch đã duyệt vào `plan.md` (sửa kế hoạch trong AgentFlow
  thì bản sửa thắng), duyệt document kế hoạch, luôn commit và push, viết
  release notes (`releaseNotes` mặc định bật). `review.complete` (không phải
  `approve`) vì đây là kết thúc review code.
- **`pull_requests: [reply, resolve]`**: key dành riêng, không phải project
  connection. Tool chỉ nhận URL của các pull request **do run này mở**, nên
  link trong comment không thể đưa agent sang pull request khác.
- **Release sign-off** (`approval`): bước duyệt của workshop 1, giờ duyệt được
  bằng label `ship-it`. Reject chỉ có trong AgentFlow.

### 6.4 Workflow

Workflows → **New workflow** → dán `todo-workflow.yaml` → Save.

```yaml
name: Todo delivery (Jira TODO)
project: Todo App
triggers:
  - connection: jira
    type: jira.issue_conditions
    config:
      match: any                       # assigned to the bot OR the bot is mentioned
      assigned: true
      mentioned: true
      projectKeys: [TODO]
      statuses: [To Do, In Progress]   # a mention on an issue in review or done starts nothing
agent:
  runAs: admin@agentflow.local
  runner: runner-1
  prd:
    instruction: PRD when the issue has the label "prd", or ... (đầy đủ trong file)
actions:   # 13 action, đầy đủ trong file
```

| # | `on` | Action | Làm gì |
|---|---|---|---|
| 1 | `workflow.triggered` | `jira.transition_issue` (`continueOnError`) | Ticket → **In Progress** |
| 2 | `workflow.triggered` | `jira.update_labels` (`continueOnError`) | Thêm `agentflow`; gỡ label review của lần chạy trước (`plan-approved`, `replan`, `code-done`, `fix-review`, `ship-it`) |
| 3 | 8 event còn lại | `webhook.post` (`connection: http`) | Gửi event tới `event-feed.py` |
| 4 | `plan.completed` | `jira.add_comment` | Link kế hoạch và trích đoạn (`{{summary}}`), mỗi round một comment |
| 5 | `input.needed` | `jira.add_comment` | `{{summary}}`: câu hỏi; hoặc cách quyết định review (label, mention, link run); hoặc chờ sign-off |
| 6 | `execute.completed` | `bitbucket.create_pull_request` | Mở pull request (round sau: dùng lại PR đang mở, PR tự cập nhật vì cùng branch) |
| 7 | `execute.completed` | `jira.transition_issue` | Ticket → **In Review** |
| 8 | `execute.completed` | `jira.add_comment` | Link PR (`{{pr.urls}}`), release notes nháp (`{{releaseNotes.url}}`), cách yêu cầu sửa |
| 9 | `workflow.completed` | `jira.add_comment` | Release notes (`{{releaseNotes}}`) và PR |
| 10 | `workflow.completed` | `confluence.create_page` (`connection: wiki`) | Trang "TODO-n Release notes" dưới "AgentFlow documents" |
| 11 | `workflow.completed` | `jira.transition_issue` | Ticket → **Done** |
| 12 | `workflow.failed` | `jira.add_comment` | Lý do và link run (`{{summary}}`) |
| 13 | `workflow.failed` | `jira.transition_issue` | Ticket → **To Do** |

Điểm nhấn khi trình bày:

- **Trigger không cần biết về review.** Label và mention lúc run đang review
  được AgentFlow chuyển thẳng tới run đó trước khi so trigger, nên chúng không
  bao giờ khởi động run mới. Trigger chỉ lo bắt đầu (assign) và trả lời câu
  hỏi (@bot khi ticket còn To Do / In Progress).
- **`statuses`**: ticket đã In Review hoặc Done thì một comment @bot không làm
  gì (ngoài lúc run đang chờ review, khi nó là feedback).
- **Action 2** là cách label hoạt động: tín hiệu là label **được thêm vào**,
  label đã có sẵn không tính. Gỡ label cũ khi bắt đầu để lần chạy mới dùng
  lại được.
- **Execute.completed chạy mỗi round:** action 6-8 chạy lại sau mỗi lần sửa
  code. PR không bị mở hai lần (dùng lại PR đang mở cùng branch), Jira có
  thêm một comment "ready for code review" cho round mới.
- Không có action nào gắn link trang Confluence lên ticket: agent của bước
  Plan làm việc đó (`source_item_link`), vì chỉ nó biết URL trang.

### 6.5 Kiểm tra trước khi chạy

- [ ] Ba connection **Test** thành công, hiện tên bot.
- [ ] Project Todo App: repository `todo-app`, runner-1, agent instructions,
      project connection `jira` và `wiki`.
- [ ] Process version 1 lưu không lỗi (lỗi grant hiện ngay khi lưu, ví dụ
      `wiki` chưa có).
- [ ] Workflow lưu không lỗi, **Enabled**.
- [ ] Jira webhook có 4 event, JQL gồm TODO; tunnel đang chạy.
- [ ] `event-feed.py` đang nghe.

## 7. Kịch bản chạy

Theo dõi song song: trang run (Workflows → Todo delivery → Runs → run), ticket
Jira, trang Confluence, pull request Bitbucket, `event-feed.py`.

Trên trang run, card **Process** hiện bước hiện tại; khi run chờ review, card
có **review panel**: round, cách quyết định trên ticket, các round trước (ai,
qua kênh nào, nội dung), ô comment và các nút.

### 7.1 Ticket thử 1: EditorConfig (đi hết bằng nút trong AgentFlow)

Tạo **Task** trong TODO từ `jira-tickets/smoke-1-editorconfig.md`, **Assignee:
bot**.

| Bước | Trạng thái run | Chuyện gì xảy ra | Làm gì |
|---|---|---|---|
| 1 | `ingesting → pre_actions` | Phân loại **Issue**; ticket In Progress, label `agentflow` | — |
| 2 | `running` (Plan) | Agent lập kế hoạch, tạo trang **TODO-1 Implementation plan** trong space TODO, gắn link "Implementation plan (Confluence)" lên ticket | Mở trang Confluence, link trên ticket |
| 3 | `needs_approval` (review round 1) | Jira: comment kế hoạch, comment "ready for review" kèm label và link run | Trên trang run: **Approve** |
| 4 | `running` (Implement) | Code, push; PR trên Bitbucket; ticket In Review; release notes **DOC** | Mở PR |
| 5 | `needs_approval` (review code) | Jira: comment "ready for code review" | Trên trang run: **Done** |
| 6 | `needs_approval` (Release sign-off) | Jira: comment chờ sign-off (label `ship-it`) | **Approve** |
| 7 | `succeeded` | Comment release notes, trang **TODO-1 Release notes**, ticket Done | — |

Điều cần nói: không cần ai biết label để dùng được; đội không dùng Jira vẫn
chạy hết bằng nút. Ước lượng: 20-30 phút, 4-6 USD.

### 7.2 Ticket thử 2: Changelog (từ chối ở review kế hoạch)

Tạo **Task** từ `jira-tickets/smoke-2-changelog.md`, assign cho bot. Khi run
tới review kế hoạch, trên trang run gõ lý do vào ô comment (ví dụ
`Not now: releases are tracked in Jira`) và bấm **Reject**.

Mong đợi: run `failed` với `review_rejected` (không retry được); comment "⚠️
AgentFlow could not complete TODO-2: …" kèm link run; ticket về **To Do**;
event feed ⚠️. Trang kế hoạch trên Confluence vẫn còn (agent tạo nó trước khi
chờ review); xoá tay nếu không cần.

Reject khác **Cancel**: Cancel không phát event (không comment, ticket không
đổi trạng thái).

### 7.3 PRD 1: Todo list (kịch bản chính)

Mỗi cảnh: làm gì, copy-paste gì, và thấy gì.

#### Cảnh A: BA tạo PRD

Jira → Create → **Story** trong TODO. Summary = dòng đầu của
`jira-tickets/prd-1-todo-list.md`, Description = phần còn lại, **Label:
`prd`**, **Assignee: bot**.

Thấy: delivery `accepted`, "1 run started"; phân loại **PRD** (lý do dưới
Work items); **PRD-n** và **PLN-n**; ticket In Progress, label `agentflow`;
event feed 🚀 🧭.

#### Cảnh B: kế hoạch hỏi lại, trả lời trên Jira

PRD 1 cố ý để ngỏ vài quyết định, thường là: todo mới hiện ở đầu hay cuối
danh sách, todo đã xong có bị dời xuống không, dữ liệu localStorage hỏng thì
xử lý sao. Run sang `needs_input`; Jira có comment liệt kê câu hỏi đánh số
kèm khuyến nghị.

Trả lời **tất cả trong một comment có @bot** (chọn bot trong danh sách mention).
Ví dụ, sửa số cho khớp câu hỏi thật:

```
@AgentFlow Bot
1. New todos go at the top of the list.
2. Completed todos stay where they are.
3. Use your recommendation.
```

Thấy: delivery "1 run resumed"; cycle 2, event 🧭 `plan.started`; agent
tiếp tục **cùng phiên** (Sessions: cùng session id, `--resume`), sửa kế
hoạch theo câu trả lời. Không có câu hỏi thì cảnh này được bỏ qua.

#### Cảnh C: kế hoạch lên Confluence, chờ review

Khi kế hoạch xong, agent:

1. tìm trang "TODO-n Implementation plan" (`confluence_find_pages`), không có
   thì tạo (`confluence_create_page`) dưới "AgentFlow documents";
2. gắn link lên ticket (`source_item_link`), thấy ở mục **Web links** của
   ticket.

Thấy: Jira có comment 📝 (link kế hoạch trong AgentFlow, trích đoạn) và comment
❓ "is ready for review (round 1)" nói cách duyệt: thêm `plan-approved`, thêm
`replan` hoặc mention bot để yêu cầu sửa, link run. Trang run: review panel
`"Plan" waits for review (round 1)`. Integration tool calls: các lần gọi
`confluence_*` và `source_item_link`, đều `succeeded`.

#### Cảnh D: reviewer comment trên Confluence, yêu cầu lập lại

Mở trang Confluence. Thêm **hai inline comment** (bôi đen một đoạn → Comment)
và **một comment cuối trang**:

- Inline, bôi đen đoạn nói về lưu localStorage:

  ```
  Store the list under a versioned key (todo-app:v1) and treat data that cannot be read as an empty list instead of crashing; the next PRD will add fields.
  ```

- Inline, bôi đen phần test (hoặc một task bất kỳ):

  ```
  Add one test that goes through a whole session with user-event: add three todos, complete one, filter Active, reload.
  ```

- Comment cuối trang (để thấy agent phản biện khi comment đi ngược instructions):

  ```
  Can we use Redux Toolkit for the state? It would scale better.
  ```

Rồi trên Jira, **thêm label `replan`** vào ticket (không cần viết gì).

Thấy: delivery "1 run resumed" (không phải "run started"); trang run: lịch sử
review ghi `Changes asked · label "replan" by <tên>`; cycle mới, 🧭.

#### Cảnh E: round 2 của kế hoạch

Agent tiếp tục phiên cũ với prompt "Review round 1 of the Plan step: … asked
for changes by adding the label replan" (label không có nội dung, nên agent
đọc comment), rồi làm theo `review.instruction`:

1. `confluence_list_comments`: ba comment đang mở;
2. sửa `plan.md` (key có version, test cả phiên);
3. sửa trang bằng storage format (`confluence_get_page` format storage →
   `confluence_update_page` với version vừa đọc), để inline comment vẫn bám
   đúng đoạn;
4. trả lời từng comment (`confluence_comment` với `replyTo`), resolve hai
   inline comment (`confluence_resolve_comment`); comment Redux được trả lời
   kiểu "the project instructions rule out a state library…" và **để mở**.

Thấy:

- Label `replan` **đã biến mất** khỏi ticket: AgentFlow gỡ sau khi dùng, để
  gắn lại được ở round sau.
- Confluence: trang version mới; hai inline comment resolved, có reply của bot;
  comment Redux có reply giải thích.
- AgentFlow: PLN-n có **version 2**; Jira có comment 📝 mới và ❓ "round 2".
- Integration tool calls: `confluence_list_comments`, `confluence_get_page`,
  `confluence_update_page`, `confluence_comment` ×3, `confluence_resolve_comment`
  ×2.

Nếu muốn thêm một round: comment thêm trên Confluence, rồi lần này dùng
**mention** trên Jira thay cho label, ví dụ
`@AgentFlow Bot please also say which file holds the storage code.` (nội dung
comment chính là feedback).

#### Cảnh F: duyệt kế hoạch

Trên Jira, **thêm label `plan-approved`**.

Thấy: lịch sử review `Approved · label "plan-approved" by <tên>`; document kế hoạch
**APPROVED**; bước Implement bắt đầu, 🛠️ `execute.started`. Label
`plan-approved` ở lại trên ticket (label duyệt không bị gỡ).

#### Cảnh G: implement, pull request trên Bitbucket

Agent dựng app theo kế hoạch đã duyệt (AgentFlow đã ghi nó vào `plan.md`),
chạy `npm ci / typecheck / test / build`, viết release notes; AgentFlow commit
và push.

Thấy (khi xong):

- Bitbucket: pull request **"TODO-n: Todo list: add, complete, edit, delete
  and filter"**, mô tả có link PRD, kế hoạch, release notes, run.
- Jira: ticket **In Review**; comment 🛠️ "ready for code review" với link PR
  và link release notes nháp; comment ❓ "review (round 1)" của bước Implement.
- AgentFlow: document **DOC "Release notes: TODO-n …"** (link dưới Work items);
  review panel "Implement waits for review" với nút Done / Request changes.

Ước lượng: 40-60 phút, 10-15 USD.

#### Cảnh H: review code trên Bitbucket, yêu cầu sửa bằng mention

Trên pull request, thêm:

- Comment trên **dòng code** của component form thêm todo (file trong
  `src/components/`, dòng xử lý submit):

  ```
  Keep the focus in the input after adding a todo, so I can type the next one right away.
  ```

- Comment chung của pull request:

  ```
  Please add a test that "Clear completed" is hidden when no todo is completed.
  ```

- Comment trên dòng bất kỳ của phần lưu trữ (`src/todos/`):

  ```
  Let's switch this to sessionStorage, it is simpler.
  ```

  (Đi ngược FR-7 của PRD: agent nên trả lời vì sao không đổi, và để mở.)

Rồi trên Jira, comment **có mention** (nội dung chính là feedback):

```
@AgentFlow Bot please address the review comments on the pull request.
```

Thấy: delivery "1 run resumed"; lịch sử review `Changes asked · comment by
<tên>`; cycle mới, 🛠️ `execute.started`.

#### Cảnh I: round 2 của implement

Agent tiếp tục phiên cũ, làm theo `review.instruction`:

1. `pull_requests_list` → `pull_request_threads` (status open): ba thread;
2. sửa focus, thêm test; không đổi sang sessionStorage;
3. chạy lại typecheck/test/build;
4. `pull_request_reply` cho từng thread ("Fixed: …" hoặc lý do),
   `pull_request_resolve` hai thread đã sửa;
5. cập nhật release notes nếu thay đổi người dùng thấy được.

Thấy:

- Bitbucket: commit mới trên **cùng pull request**; hai thread resolved có
  reply của bot; thread sessionStorage có reply giải thích, vẫn mở.
- Jira: comment 🛠️ mới (round 2); ticket vẫn In Review.
- AgentFlow: release notes DOC **version 2** (nếu agent sửa);
  Integration tool calls: `pull_requests_list`, `pull_request_threads`,
  `pull_request_reply` ×3, `pull_request_resolve` ×2.

Ở round sau, `pull_request_threads` đánh dấu comment nào là của agent
(`mine`), nên agent bỏ qua thread nó đã trả lời mà reviewer chưa viết thêm.

#### Cảnh J: review code xong

Reviewer xem lại PR, đồng ý với lời giải thích về sessionStorage và resolve
thread đó. Trên Jira: **thêm label `code-done`**.

Thấy: lịch sử review `Approved · label "code-done" by <tên>` (kết thúc review
cũng hiện là Approved); bước **Release sign-off**:
comment ❓ trên Jira nói chờ duyệt, thêm label `ship-it` hoặc Approve trong
AgentFlow.

Merge pull request lúc này hay sau khi ship là quyết định của đội: AgentFlow
không dùng trạng thái PR làm tín hiệu.

#### Cảnh K: product owner duyệt phát hành

Trên Jira: **thêm label `ship-it`**.

Thấy:

- Jira: comment 📦 release notes (nội dung `{{releaseNotes}}`) kèm PR; ticket
  **Done**.
- Confluence: trang **TODO-n Release notes** dưới "AgentFlow documents".
- AgentFlow: run `succeeded`; event feed 🎉.
- Merge PR, rồi trên máy: `npm ci && npm test && npm run dev`.

Event feed của PRD 1 (nếu có câu hỏi và hai round mỗi review): 🚀 🧭 ❓(câu
hỏi) 🧭 📝 ❓(review 1) 🧭 📝 ❓(review 2) 🛠️ ✅ ❓(code review 1) 🛠️ ✅
❓(code review 2) ❓(sign-off) 🎉.

### 7.4 PRD 2: Due dates, priorities and search (biến thể)

Merge PR của PRD 1 trước. Tạo Story từ
`jira-tickets/prd-2-due-dates-priorities-search.md`, label `prd`, assign cho
bot. Lần này quyết định **trong AgentFlow** và thử tín hiệu xếp hàng:

1. **Replan trong AgentFlow.** Khi kế hoạch chờ review: trên trang run gõ vào
   ô comment rồi bấm **Replan**:

   ```
   Sorting by due date must also put completed todos after active ones with the same date. And migrate the stored v1 data in one place, with a test.
   ```

   Lịch sử review: `Changes asked · in AgentFlow`. Feedback qua
   AgentFlow giữ nguyên nội dung gõ (không đọc comment Jira). Thành viên
   thường cũng Replan / Request changes được; Approve, Done, Reject cần admin.
2. **Tín hiệu xếp hàng.** Ngay khi round 2 bắt đầu (🧭 trên event feed),
   thêm label **`plan-approved`** trên Jira trong lúc agent còn làm. Run ghi
   tín hiệu vào hàng chờ (`step_state.pendingSignals`); khi round 2 xong, kế
   hoạch được duyệt **ngay**, không có comment ❓ "ready for review" (không ai
   cần được báo nữa), và Implement bắt đầu.
3. **Request changes trong AgentFlow.** Khi code chờ review, comment trên PR
   (ví dụ `The search field needs a visible label, not only a placeholder.`),
   rồi trên trang run gõ `Please address the pull request comments.` và bấm
   **Request changes**.
4. **Done** và **Approve** (sign-off) trên trang run.

Điều cần nói: cùng một process phục vụ cả đội sống trên Jira và đội sống trong
AgentFlow; lịch sử review ghi cả hai.

### 7.5 Event nào, action nào, thấy ở đâu

| Event | Khi nào | Action | Thấy ở đâu |
|---|---|---|---|
| `workflow.triggered` | Assign; câu trả lời @bot | 1-2 (trước agent) | Jira: status, label |
| `workflow.started` | Loop đầu tiên chạy | 3 | Event feed |
| `plan.started` | Mỗi round của Plan (cả khi trả lời câu hỏi) | 3 | Event feed |
| `plan.completed` | Mỗi round của Plan có kế hoạch | 3, 4 | Jira comment 📝 |
| `input.needed` | Câu hỏi; review kế hoạch; review code; sign-off | 3, 5 | Jira comment ❓, review panel |
| `execute.started` | Mỗi round của Implement | 3 | Event feed |
| `execute.completed` | Mỗi round của Implement | 3, 6, 7, 8 | PR, Jira In Review, comment 🛠️ |
| `workflow.completed` | Sau sign-off | 3, 9, 10, 11 | Jira 📦, trang release notes, Done |
| `workflow.failed` | Lỗi, Reject | 3, 12, 13 | Jira ⚠️, To Do |

## 8. Xem dữ liệu

| Ở đâu | Xem gì |
|---|---|
| Trang run → **Process** | Bước hiện tại, review panel, **lịch sử review**: mỗi round một dòng (Approved / Changes asked / Rejected, qua label / comment / AgentFlow, ai, lúc nào, nội dung) |
| Trang run → **Work items** | PRD/Issue, Implementation Plan, **Release notes (DOC)** |
| Document kế hoạch → History | Một **version mỗi round** của bước Plan: so version 1 và 2 để thấy agent đã sửa gì theo review |
| Document release notes → History | Một version mỗi round của Implement |
| Trang run → **Integration tool calls** | Mọi lần agent gọi: `confluence_*`, `pull_request_*`, `source_item_link`, `source_item_comment`, kết quả, lỗi (ví dụ trang ngoài space bị từ chối) |
| Trang run → **Agent loops** / Sessions | Mỗi round là một loop STEP; các round review **tiếp tục cùng phiên** Claude Code; chi phí từng round |
| Trang run → **Actions** | Action theo event và cycle; PR action ở round 2 báo dùng lại PR đang mở |
| Integrations → Jira → Deliveries | Delivery của label/mention khi review: "1 run resumed", không phải "run started" |
| `monitor.sh "Todo App"` | Delivery, run, action, tool call, loop, document, session |

## 9. Checklist kiểm tra dữ liệu

Sau PRD 1:

- [ ] Run `succeeded`; lịch sử review của Plan có ít nhất: Changes asked (label
      "replan") → Approved (label "plan-approved").
- [ ] Lịch sử review của Implement: Changes asked (comment) → Approved (label
      "code-done"); sign-off: `Approved with the label "ship-it" by <tên>`.
- [ ] Implementation Plan có ≥ 2 version, trạng thái APPROVED.
- [ ] DOC release notes có ít nhất một version; nội dung trùng comment 📦 và
      trang "TODO-n Release notes".
- [ ] Ticket: label `replan`, `fix-review` không còn (đã gỡ); `plan-approved`,
      `code-done`, `ship-it`, `agentflow`, `prd` còn; web link tới trang kế
      hoạch; status Done.
- [ ] Confluence: trang kế hoạch có version mới sau round 2, inline comment đã
      resolve có reply của bot, comment Redux có reply và còn mở.
- [ ] Bitbucket: một PR, ít nhất hai commit; thread đã sửa resolved có reply
      của bot; thread sessionStorage có reply.
- [ ] Integration tool calls: không có lời gọi `failed` ngoài ý muốn.

## 10. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Gắn label nhưng run không đi tiếp | Webhook thiếu event **Issue updated**; hoặc label đã có sẵn trên ticket (chỉ label **được thêm** mới tính) | Thêm event; gỡ label rồi gắn lại |
| Delivery `ignored`, `caused_by_bot` | Thao tác bằng tài khoản bot | Dùng tài khoản người |
| Gắn `plan-approved` và `replan` cùng lúc không có tác dụng | Hai tín hiệu trái nhau trong một lần sửa bị bỏ qua | Gắn từng label một |
| Comment @bot khi đang chờ câu hỏi lại không phải feedback | Đúng thiết kế: lúc `needs_input`, @bot là câu trả lời | Trả lời câu hỏi trước; feedback khi run chờ review |
| Run chờ review rất lâu | Review không hết hạn | Quyết định, hoặc Cancel trên trang run |
| `confluence_*` lỗi "Not allowed: … not in the project connection's spaces" | Trang nằm ngoài `spaceKeys` | Đúng thiết kế; kiểm `spaceKeys` của `wiki` |
| `confluence_*` lỗi 401 / 403 | Token thiếu scope; bot thiếu quyền trong space | Mục 5.3; Test lại connection |
| Inline comment thành "dangling" sau khi sửa trang | Trang bị ghi lại bằng Markdown thay vì storage format | Instruction đã yêu cầu storage format; nhắc lại trong feedback |
| Action `confluence.create_page` (release notes) lỗi "already exists" | Chạy lại cùng ticket: tiêu đề trùng | Đổi tên hoặc xoá trang cũ, **Retry** action run |
| `pull_request_*` báo "not supported" | Repository không phải Bitbucket Cloud / Azure DevOps (ví dụ Local Git) | Dùng repository Bitbucket |
| Round 1 của Implement không có tool `pull_request_threads` | PR chỉ có sau `execute.completed` của round 1 | Đúng thiết kế |
| Bước Plan fail `step_failed` | Không ghi `plan.md` sau lần nhắc; hoặc runner cũ | Build lại runner (mục 5.2); **Retry** bước Plan trên trang run |
| Comment ❓ không có sau round mà tín hiệu đã xếp hàng | Tín hiệu xếp hàng được áp dụng ngay, không cần báo | Đúng thiết kế (mục 7.4) |

**Retry:** run `failed` hoặc `cancelled` ở một bước Plan / Implement có nút
**Retry <bước>** trên trang run: chạy lại đúng bước đó ở cycle mới (không chạy
lại từ đầu). Không áp dụng cho `review_rejected` / `approval_rejected`.

## 11. Chi phí và thời gian

Ước lượng theo workshop 1 (Claude Code qua proxy, model mặc định); ghi số thật
sau lần chạy thử:

| Phần | Thời gian | Chi phí |
|---|---|---|
| Phân loại PRD/Issue | < 1 phút | ~0,1 USD |
| Plan, round đầu (PRD 1) | 10-20 phút | 3-5 USD |
| Plan, mỗi round review | 5-10 phút | 1-3 USD (tiếp tục phiên, ít khám phá lại) |
| Implement, round đầu (PRD 1) | 40-60 phút | 10-15 USD |
| Implement, mỗi round review | 10-20 phút | 2-5 USD |
| Ticket thử | 20-30 phút | 4-6 USD |

Khác workshop 1: không có review nội bộ nhiều tầng của `agentflow.execute`
(critic, decision table); chất lượng dựa vào instruction của process và vào
review của người. Muốn giữ review nội bộ đó, đổi bước Implement thành
`type: agentflow.execute` (mất `review:` của bước, vẫn có release notes).

## 12. Chạy lại workshop từ đầu

1. Jira: xoá hoặc đóng các ticket TODO cũ (ticket mới có key mới, tiêu đề
   trang Confluence không trùng).
2. Confluence: xoá các trang dưới "AgentFlow documents" nếu muốn space sạch.
3. Bitbucket: đóng các PR cũ; muốn dựng lại app từ đầu thì đưa `main` về commit
   README đầu tiên.
4. AgentFlow: run cũ giữ nguyên; document của project (PRD, plan, release
   notes) tích luỹ theo ticket.
5. Kiểm lại mục 6.5.
