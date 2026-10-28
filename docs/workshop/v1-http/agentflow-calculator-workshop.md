# Workshop AgentFlow: xây ứng dụng Calculator từ PRD đến Pull Request

Tài liệu cho người dẫn workshop. Trong buổi demo, đội sẽ thấy AgentFlow nhận
một PRD qua HTTP, tự lập kế hoạch, viết code React có test, đẩy branch lên
Local Git và mở pull request, sau đó xem lại mọi dữ liệu AgentFlow ghi nhận
(PRD, Plan, Loop, Session, Agent).

Các file đi kèm, cùng thư mục `docs/workshop/`:

| File | Dùng để |
|---|---|
| `calculator-prds/CALC-1-basic-calculator.md` | PRD 1: máy tính cơ bản (và dựng khung app) |
| `calculator-prds/CALC-2-keyboard-and-history.md` | PRD 2: nhập bằng bàn phím và lịch sử phép tính |
| `calculator-prds/CALC-3-memory-percent-dark-mode.md` | PRD 3: phím nhớ, %, ±, √ và dark mode |
| `send-prd.sh` | Gửi một file PRD vào HTTP trigger của workflow |
| `monitor.sh` | In dữ liệu AgentFlow đã ghi cho project (đọc trực tiếp Postgres) |

---

## 1. Mục tiêu và thông điệp chính

Sau buổi workshop, người tham dự nắm được:

1. **AgentFlow là gì:** nền tảng giao phần mềm do AI thực hiện nhưng con người
   kiểm soát. AI tạo ra các artifact (PRD → kế hoạch → code → pull request),
   con người duyệt ở các mốc quan trọng.
2. **Một workflow chạy thế nào:** `trigger → pre actions → agent team (PLAN →
   EXECUTE) → post actions`. Engine không tự ghi vào hệ thống nguồn; mọi thay
   đổi bên ngoài là một action do admin cấu hình.
3. **Dữ liệu nào được ghi lại:** PRD và Implementation Plan là document của
   project; mỗi lần agent chạy là một Loop; mỗi Loop có Session (transcript,
   token, chi phí) và danh sách Agent (subagent) đã dùng.
4. **Con người ở đâu trong vòng lặp:** câu hỏi mở của plan, review và merge
   pull request.

Câu chốt cho người nghe: *"Gửi một PRD bằng một lệnh. Khoảng một giờ sau có
một pull request chứa ứng dụng React đã có test, kèm kế hoạch và toàn bộ dấu
vết của các agent."*

## 2. Agenda gợi ý (khoảng 2 giờ)

| Thời lượng | Phần | Nội dung |
|---|---|---|
| 10' | Mở đầu | Vấn đề AgentFlow giải quyết, thông điệp chính |
| 15' | Khái niệm và kiến trúc | Mục 3 và 4 |
| 20' | Setup | Mục 6: Local Git, connection, project, workflow (làm live, hoặc đi qua môi trường đã chuẩn bị) |
| 10' | Các PRD | Mục 7 |
| 30' | Demo CALC-1 | Mục 8: gửi PRD, theo dõi run, PRD, Plan, Session, Agent |
| 15' | Review và merge | Pull request trên Local Git, chạy ứng dụng |
| 10' | CALC-2, CALC-3 và các tình huống | Mục 8.6, 8.7 |
| 10' | Hỏi đáp | |

Một PRD chạy hết PLAN + EXECUTE mất khá lâu (xem số liệu thực tế ở mục 9),
nên **hãy chạy trước CALC-1 trước buổi workshop** và chỉ chạy live một PRD.

## 3. Khái niệm chính

| Khái niệm | Ý nghĩa trong demo |
|---|---|
| Connection | Tài khoản đã xác thực với một hệ thống ngoài. Ở đây: **Local Git** (Gitea chạy trong Docker). Credential chỉ nằm ở connection. |
| Project | "Calculator": nơi chứa repository, agent instructions, process và các document. |
| Project repository | `workshop/calculator` trên Local Git. Agent clone và push bằng credential cấp riêng cho từng loop. |
| Process | Các bước giữa pre và post action. Demo dùng **process mặc định**: PLAN rồi EXECUTE. |
| Workflow | "Calculator PRDs (HTTP)": trigger HTTP → agent team → post action "Create pull request". |
| HTTP trigger | URL riêng của workflow. Request có `"type": "prd"` được nhập thành **PRD**. |
| Run | Một lần xử lý một item (một PRD). Trạng thái: `received → ingesting → planning → executing → succeeded`. |
| Loop | Một lần agent chạy trên runner: `PLAN` hoặc `EXECUTE`. |
| Runner | `runner-1`: headless runner trong Docker, chạy Claude Code với các plugin của AgentFlow. |
| Session | Phiên Claude Code của một loop: transcript, model, token, chi phí, số tool call. |
| Agent | Các subagent/skill đã được gọi trong session (pre-explorer, plan-writer, implementation-subagent, ...). |

## 4. Kiến trúc của buổi demo

```
 send-prd.sh ──POST + X-AgentFlow-Token──►  AgentFlow API :3002
                                             │  workflow engine (tick 10s)
                                             │   ├─ tạo PRD + Plan document
                                             │   ├─ PLAN loop ─┐
                                             │   └─ EXECUTE loop ┤
 Web app :3000 ◄─── đọc ─────────────────────┘                  │ (WebSocket, runner nối ra ngoài)
   (Workflows, PRDs, Plans,                                     ▼
    Loops, Sessions, Agents)                     runner-1 (Docker): Claude Code + agent-plugins
                                                                │ clone / push (credential theo loop)
                                                                ▼
                                                 Local Git (Gitea) :3300 ── Pull request
```

Process mặc định khi workflow ở chế độ `plan_and_execute`:

1. **PLAN**: khám phá repository, viết `plan.json` (task, câu hỏi mở, khuyến
   nghị), validate. Plan được tải lên thành document Implementation Plan.
2. Nếu plan còn câu hỏi mở không có khuyến nghị và `stopOnOpenQuestions: true`
   → run dừng ở `needs_input` chờ người trả lời.
3. **EXECUTE** (`review: full`, mặc định): đánh giá plan, critic review, chốt
   plan kèm decision table → implement từng task → đơn giản hoá code → viết
   test và build/validate → **Phase 5.5** đối chiếu code với decision table →
   review vòng cuối → commit và push branch `symphony/<plan>`.
4. Run `succeeded` → post action mở pull request trên Local Git.

## 5. Chuẩn bị trước buổi workshop (người dẫn)

### 5.1 Máy và dịch vụ

```bash
cd ~/Projects/agentflow
nvm use                                   # Node 24
docker compose up -d                      # postgres, rustfs, mailpit, local-git
docker compose ps                         # tất cả "healthy"
pnpm turbo dev --filter=app --filter=api --filter=mcp
curl -s http://localhost:3002/health      # OK
curl -s http://localhost:3010/health      # OK
grep host.docker.internal /etc/hosts      # 127.0.0.1 host.docker.internal
```

### 5.2 Runner

- `docker ps` thấy `agentflow-runner-1` ở trạng thái `healthy`.
- Settings → Compute & Integrations → Local Compute Targets: **runner-1
  online**, đã có **Model provider** (và Claude Code version nếu proxy yêu cầu).
- Image runner đóng gói sẵn `agent-plugins/` lúc build. Sau khi cập nhật code
  plugin, build lại image và tạo lại container (README, bước 10):

  ```bash
  docker buildx build -f deploy/runner/Dockerfile -t agentflow-runner:base .
  docker rm -f agentflow-runner-1   # rồi chạy lại đúng lệnh docker run trong README
  ```

### 5.3 Sessions và Agents: không cần cấu hình

Trang **Sessions** và **Agents** luôn nhận dữ liệu: runner gửi session của mỗi
loop (token, chi phí, transcript) và kho agent của nó lên API ngay khi chạy.
Không còn toggle trong Settings → Organization, cũng không cần feature flag;
dữ liệu chỉ nằm trong Postgres của bản self-hosted này, không đi đâu khác.

Tuỳ chọn (docs/self-hosting.md, "Feature flags without PostHog"):

```bash
# apps/api/.env.local
AGENTFLOW_FEATURE_FLAGS=desktop-agent-session-sync,emergent
# apps/app/.env.local
NEXT_PUBLIC_AGENTFLOW_FEATURE_FLAGS=desktop-agent-session-sync,emergent
```

- `emergent`: màn hình Active Runs (xem run đang chạy trong Sessions).
- `desktop-agent-session-sync`: chỉ còn mở số liệu của Dashboard (insights)
  và golden candidates; Sessions/Agents không cần nó.

Khởi động lại `pnpm turbo dev …` nếu app không tự nạp lại env. Nếu runner tạm
không gửi được (API tắt), nó thử lại sau 5 phút và gửi bù các loop kết thúc
trong 24 giờ gần nhất.

### 5.4 Tài khoản

| Ở đâu | Tài khoản | Ghi chú |
|---|---|---|
| AgentFlow http://localhost:3000 | owner của tổ chức (`admin@agentflow.local`) | Tạo connection, workflow cần quyền admin |
| Local Git http://localhost:3300 | `agentflow` | Mật khẩu: `jq -r .password ~/.agentflow/local-git.json` |

### 5.5 Biến môi trường cho HTTP trigger

URL và secret của trigger lấy ở workflow → **Show URL and secret**. Lưu vào một
file chỉ mình đọc được, rồi nạp trước khi gửi PRD:

```bash
cat ~/.agentflow/calculator-trigger.env     # AGENTFLOW_TRIGGER_URL=..., AGENTFLOW_TRIGGER_SECRET=whsec_...
set -a; source ~/.agentflow/calculator-trigger.env; set +a
```

Dialog **Show URL and secret** chỉ hiện secret khi bấm, có nút rotate (URL và
secret đổi cùng lúc) và liệt kê các delivery gần nhất kèm lý do bị bỏ qua.
Không chiếu secret lên màn hình; nếu lỡ lộ thì rotate rồi cập nhật file env.

## 6. Setup từng bước

Có thể làm live, hoặc làm trước và trình bày lại từng màn hình. Các đoạn YAML
dưới đây đã được kiểm tra bằng chính parser của trình soạn thảo trong app.

### 6.1 Local Git

```bash
pnpm local-git:init --org workshop
```

Script tạo tài khoản admin `agentflow` (mật khẩu in ra một lần), organization
`workshop` và một access token cho connection. Mở http://localhost:3300 để
đăng nhập thử.

### 6.2 Connection "Local Git"

Settings → Compute & Integrations → Connections → **Add connection** → Local
Git. Dán YAML, nhập **Access token** (token vừa in ra) vào ô mật khẩu bên dưới
trình soạn thảo, rồi Save:

```yaml
name: Local Git
config:
  serverUrl: http://localhost:3300               # API của AgentFlow gọi Local Git ở đây
  runnerUrl: http://host.docker.internal:3300    # runner trong Docker clone/push ở đây
  owner: workshop                                # repository mới được tạo trong org này
```

Điểm nhấn: secret không bao giờ nằm trong YAML; token được mã hoá
(AES-256-GCM) và runner không bao giờ giữ token (mỗi loop xin credential ngắn
hạn từ API).

### 6.3 Project "Calculator"

1. Tạo project **Calculator** trong một team (Teams → team → Projects →
   **Create Project**).
2. Tab **Repositories** → **Add repository** → Local Git → **Create and add**
   → tên `calculator`. Repository mới có commit đầu tiên (README) trên `main`.
3. Cùng tab, phần **Runners** → chọn `runner-1`.
4. Tab **Overview** → **Agent instructions**: dán nội dung sau (bối cảnh chung
   cho mọi agent làm việc trên project):

   ```markdown
   # Calculator

   A calculator web app that runs in the browser. It is built one PRD at a time: every PRD extends the app that is already on `main`.

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

5. Tab **Process**: để nguyên **AgentFlow (default)**, tức PLAN rồi EXECUTE.
   (Đây là chỗ thay bằng process riêng, ví dụ Spec Kit, khi cần.)

### 6.4 Workflow "Calculator PRDs (HTTP)"

Workflows → **New workflow** → dán YAML → Save:

```yaml
name: Calculator PRDs (HTTP)
description: A PRD posted to this workflow's HTTP endpoint is planned, implemented and opened as a Local Git pull request.
triggers:
  - connection: http            # the workflow's own URL ("Show URL and secret")
    type: webhook.request
    config:
      types: [prd]              # only requests with "type": "prd" start a run
agent:
  project: Calculator
  runAs: admin@agentflow.local
  runner: runner-1
  mode: plan_and_execute        # PLAN, then EXECUTE (the default process)
  stopOnOpenQuestions: true     # stop for people when the plan has open questions
actions:
  - on: workflow.completed      # the run succeeded
    type: local_git.create_pull_request   # no connection: the project's Local Git
    config:
      title: "{{source.key}}: {{source.title}}"
      description: |-
        Implements {{source.key}}: {{source.title}}

        PRD: {{feature.url}}
        Implementation plan: {{plan.url}}
        AgentFlow run: {{run.url}}
      draft: false
```

Sau khi lưu: **Show URL and secret** → ghi vào `~/.agentflow/calculator-trigger.env`
(mục 5.5).

Giải thích nhanh cho người nghe:

- `connection: http` là trigger HTTP có sẵn của mọi workflow; xác thực bằng
  header `X-AgentFlow-Token` hoặc chữ ký Standard Webhooks.
- `types: [prd]`: request có `"type": "prd"` được nhập thành document **PRD**
  (không phải Issue) và plan sinh ra từ PRD đó. Request loại khác bị ghi nhận
  là `ignored`.
- `id` trong request là khoá chống trùng: cùng `id` chỉ tạo một run. `key`
  (ví dụ `CALC-1`) là mã hiển thị; mỗi workflow chỉ chạy một run cho một key
  tại một thời điểm.
- `actions:` là một danh sách chạy theo thứ tự. Mỗi item có `on:` (khi nào:
  `workflow.triggered` trước agent team; `workflow.started`, `plan.started`,
  `plan.completed`, `input.needed`, `execute.started`, `execute.completed`,
  `workflow.completed`, `workflow.failed` sau đó) và
  hoặc `type:` + `config:` (action cố định như ở trên), hoặc `instruction:`
  bằng lời (agent đọc thư mục plan của run rồi đề xuất thao tác, AgentFlow
  kiểm tra và thực hiện). Không ghi `connection:` thì run tự chọn: instruction
  dùng connection của trigger; action tạo PR chạy trên mọi connection giữ repo
  của run, nên mỗi repo agent team đã push có một PR (repo không đổi gì thì
  không có); action cố định khác dùng connection có loại đó (ở đây là Local
  Git của project).
- Trên trang cấu hình, mục **Configuration guide** phía trên editor liệt kê
  sự kiện, các key của action, cách instruction chạy, connection nào được
  chọn, các connection của org cùng loại trigger/action và option, biến
  template và ví dụ để copy. Phần **Actions in run order** dưới editor cho
  thấy mỗi sự kiện chạy action nào, theo thứ tự nào, trên connection nào,
  trước khi lưu.

Workflow lấy việc từ Jira dùng instruction thay cho các comment cố định, ví dụ:

```yaml
actions:
  - on: workflow.triggered      # before the agent team
    instruction: Move the issue to "In Progress".
  - on: workflow.completed
    type: local_git.create_pull_request
  - on: execute.completed       # listed after the PR action, so it sees {{pr.url}}
    instruction: |
      Summarize what was implemented for {{source.key}}: the files that
      changed, the tests, and the pull request ({{pr.url}}). Post it as one
      comment on the issue, then move the issue to "In Review".
```

## 7. Các PRD của Calculator

Ba PRD xây dần một ứng dụng: PRD sau mở rộng app đã có trên `main`, nên chạy
theo thứ tự và **merge pull request của PRD trước rồi mới gửi PRD sau**.

| Key | Tên | Nội dung chính | Phụ thuộc |
|---|---|---|---|
| CALC-1 | Basic calculator | Dựng app React + TypeScript + Vite + Vitest; bàn phím 4 cột; + − × ÷ kiểu máy tính bỏ túi (tính ngay, trái sang phải); chia cho 0; làm tròn 12 chữ số; C và ⌫; accessibility | Không (repo chỉ có README) |
| CALC-2 | Keyboard input and calculation history | Gõ phím (kể cả numpad, Enter, Esc, Backspace); panel History 20 phép gần nhất; bấm để dùng lại kết quả; lưu `localStorage`, dữ liệu hỏng không làm sập app | CALC-1 đã merge |
| CALC-3 | Memory, percent, sign, square root and dark mode | MC/MR/M+/M−, %, ±, √ (số âm → `Invalid input`); bố cục phím mới 4×7; dark mode theo hệ điều hành và nhớ lựa chọn | CALC-1 đã merge (CALC-2 có thì ghi history đúng) |

Vì sao các PRD được viết như vậy (nói với người nghe):

- **Hành vi được mô tả bằng ví dụ cụ thể** (bảng acceptance criteria: phím
  bấm → kết quả hiển thị). Plan và test sinh ra bám đúng các ví dụ này, và
  Phase 5.5 dùng chúng để đối chiếu code với decision table.
- **Có quy tắc "khó"** để thấy AgentFlow xử lý tình huống biên: tính ngay
  `2 + 3 × 4 = 20`, `0.1 + 0.2 = 0.3`, chia cho 0, số mũ `9.9999998e+17`,
  `200 + 10 % = 220`.
- **Phạm vi rõ ràng** (Out of scope) để plan không lan sang PRD sau.
- **Agent instructions của project** giữ stack và quy ước chung, nên PRD chỉ
  nói về tính năng.

Tóm tắt từng PRD (đọc file để xem đầy đủ):

**CALC-1 — Basic calculator.** Màn hình hai dòng (phép tính đang chờ và số
đang nhập/kết quả), bàn phím 4 cột với `=` cao hai hàng và `0` rộng hai cột.
Nhập tối đa 16 chữ số, một dấu thập phân. Toán tử tính ngay kiểu máy tính bỏ
túi; bấm toán tử liên tiếp thì thay toán tử; sau kết quả, gõ số là phép tính
mới, gõ toán tử là tính tiếp. Chia cho 0 hiện `Cannot divide by zero`. Logic
thuần TypeScript trong `src/calculator/`, mỗi acceptance criterion có unit
test. 12 acceptance criteria.

**CALC-2 — Keyboard input and calculation history.** Bảng ánh xạ phím đầy đủ;
nút tương ứng sáng lên khoảng 150 ms; không chiếm phím khi đang gõ trong ô nhập
hoặc giữ Ctrl/Alt/Meta; `/` không mở quick find. History lưu phép tính hoàn tất
bằng `=` (không lưu phép lỗi), mới nhất ở trên, tối đa 20; bấm một dòng để dùng
lại kết quả; `Clear history`; lưu `localStorage` khoá `calculator.history.v1`.
10 acceptance criteria.

**CALC-3 — Memory, percent, sign, square root and dark mode.** Bố cục phím mới
4×7. `±` đổi dấu (không bao giờ `-0`); `%` theo quy tắc máy tính để bàn
(`200 + 10 % → 20`, `50 × 10 % → 0.1`); `√` (số âm → `Invalid input`); bộ nhớ
với chỉ báo `M`, giữ qua `C` nhưng không qua reload. Dark mode theo
`prefers-color-scheme`, lưu lựa chọn, đạt tương phản WCAG AA. 12 acceptance
criteria.

## 8. Demo: gửi PRD và theo dõi

### 8.1 Gửi CALC-1

```bash
set -a; source ~/.agentflow/calculator-trigger.env; set +a
bash docs/workshop/send-prd.sh docs/workshop/calculator-prds/CALC-1-basic-calculator.md
# {"ok":true}
# HTTP 200
# Sent CALC-1 (Basic calculator) with id CALC-1-20261012-201550
```

`send-prd.sh` lấy `key` và `title` từ dòng đầu của file (`# CALC-1: Basic
calculator`), phần còn lại là `description`, và gửi:

```json
{ "id": "CALC-1-<timestamp>", "key": "CALC-1", "title": "Basic calculator",
  "type": "prd", "labels": ["calculator", "workshop"], "description": "## Summary ..." }
```

Tương đương với curl:

```bash
curl -X POST "$AGENTFLOW_TRIGGER_URL" \
  -H 'content-type: application/json' \
  -H "X-AgentFlow-Token: $AGENTFLOW_TRIGGER_SECRET" \
  -d '{"id":"demo-1","key":"CALC-1","title":"Basic calculator","type":"prd","description":"..."}'
```

### 8.2 Run diễn ra thế nào

Số liệu thật của lần chạy thử CALC-1 (12/10, giờ UTC):

| Thời điểm | Trạng thái run | Chuyện gì xảy ra | Xem ở đâu |
|---|---|---|---|
| 13:15:53 | `received` → `ingesting` | HTTP trigger nhận request (delivery `accepted`, "1 run started"). Engine tạo **PRD-1** "CALC-1: Basic calculator" (`APPROVED`, nội dung = `description`) và **PLN-1** "Plan: CALC-1: Basic calculator" (`DRAFT`), liên kết PRD-1 `PRODUCES` PLN-1 | Show URL and secret (deliveries), trang run |
| 13:15:54 | `planning` | Loop **PLAN** được giao cho runner-1. Runner clone `workshop/calculator`, dựng workspace `/workspace/loops/pln-1` (repo là thư mục con, branch `symphony/pln-1`) | `docker logs agentflow-runner-1` |
| 13:16 – 13:32 | `planning` | Orchestrator: Phase 0.9 khám phá repo (pre-explorer) → Phase 1 soạn plan (plan-draft-writer, plan-validator) → Phase 1.1 dừng chờ duyệt plan. Loop PLAN `COMPLETED` sau **~17 phút** | Loops, Sessions (session PLAN) |
| 13:32:58 | `planning` → `executing` | Plan được tải lên (**PLN-1 v2**). Không còn câu hỏi mở chặn (khuyến nghị đã được chấp nhận) nên engine đặt PLN-1 `APPROVED` và chạy loop **EXECUTE** (tiếp tục session của PLAN) | Trang plan, trang run |
| 13:33 – 13:47 | `executing` | Phase 1.2 đưa các câu trả lời (khuyến nghị) vào task → 1.3 đánh giá độ phức tạp (`simple_mode: false`) → 1.4 kiểm tra repo khác → 2.5 critic (chưa cấu hình critic nào) → 2.7 chốt plan và tạo decision table (*lần chạy thử bị bỏ qua do lỗi đã sửa, xem mục 9*) | Sessions (session EXECUTE `active`) |
| 13:47 – 14:13 | `executing` | Phase 3: 9 task, mỗi task verification-subagent kiểm tra → implementation-subagent viết code và test → đánh dấu `[x]` trong plan | Trang plan (task được tick dần) |
| 14:13 – 14:20 | `executing` | Phase 5 build-validator: typecheck, build, 68 test pass → 5.5 đối chiếu decision table → 6 kiểm tra giao diện (bỏ qua nếu không có dev server) → 7 ghi `log.md`, kiểm tra build lần cuối | |
| 14:20:02 | `executing` → `succeeded` | Loop EXECUTE `COMPLETED`: runner commit và push `symphony/pln-1` lên Local Git. Engine đặt PRD-1 `EXECUTED`, run `succeeded` (tổng **1 giờ 04 phút**) | Trang run |
| 14:20:03 | `succeeded` | Post action mở **PR #1** "CALC-1: Basic calculator" (27 file) | Local Git → Pull requests |

### 8.3 Xem trên giao diện

| Màn hình | Đường dẫn | Chỉ cho người nghe |
|---|---|---|
| Workflow → Runs → run | `/agentflow/workflows/<workflow>/runs/<run>` | Trạng thái, các loop (PLAN, EXECUTE), PRD và Plan, post action, pull request |
| PRD | `/agentflow/prds/PRD-1` | Nội dung PRD nhập từ HTTP request, trạng thái |
| Implementation Plan | `/agentflow/implementation-plans/PLN-1` | Task, câu hỏi mở và khuyến nghị, phiên bản plan |
| Project | Teams → team → Projects → Calculator | Tab PRDs, Plans, Repositories, Process |
| Loops | `/agentflow/loops` | Mỗi loop: lệnh, trạng thái, thời gian, token, chi phí |
| Sessions | `/agentflow/sessions` | Transcript, model, token, chi phí, agent đã chạy |
| Agents | `/agentflow/agents` | Các subagent/skill được gọi và số lần gọi |
| Local Git | http://localhost:3300/workshop/calculator | Branch `symphony/pln-1`, Pull requests |

Khi mở plan (PLN-1 trong lần chạy thử), chỉ cho người nghe:

- **Acceptance Criteria**: 20 tiêu chí, 12 lấy từ bảng của PRD, 8 tiêu chí
  suy ra từ các FR/NFR (cấu trúc project, bố cục bàn phím, accessibility, …),
  mỗi tiêu chí ghi nguồn.
- **Architecture Decisions**: ví dụ chọn `useReducer` vì PRD yêu cầu reducer
  thuần, `toPrecision(12)` cho định dạng số, CSS Grid cho phím `=` cao hai hàng.
- **Tasks** theo phase (scaffold → engine → unit test → UI → component test,
  README, build), mỗi task trỏ về các AC nó đáp ứng; một task `[MANUAL]` để
  người kiểm tra ở màn hình 360 px.
- **Open Questions** có khuyến nghị, ví dụ "`5 + =` làm gì?" → *Recommended:
  không làm gì*. Với process mặc định, khuyến nghị được chấp nhận tự động nên
  run không dừng; muốn bắt người trả lời thì dùng `recommendations: suggest`.
- **Gaps**: những chỗ PRD chưa nói rõ, để lần sau viết PRD tốt hơn.

### 8.4 Xem dữ liệu đã ghi

```bash
bash docs/workshop/monitor.sh            # project Calculator
```

In ra: delivery của HTTP trigger, run, document PRD/Plan và liên kết giữa
chúng, loop, session, agent, post action. Mục 9 là danh sách những gì cần
thấy.

### 8.5 Review, merge và chạy thử ứng dụng

1. Local Git → `workshop/calculator` → **Pull requests** → PR
   `CALC-1: Basic calculator`. Mô tả PR có link tới plan và run.
2. Xem diff cùng người nghe: `src/calculator/` (logic + test), `src/components/`,
   `README.md`.
3. **Merge** (đây là cửa kiểm soát của con người).
4. Chạy thử:

   ```bash
   git clone http://localhost:3300/workshop/calculator.git /tmp/calculator
   cd /tmp/calculator && npm install && npm test && npm run dev
   ```

   Thử các acceptance criteria: `2 + 3 × 4 =` → `20`, `0.1 + 0.2 =` → `0.3`,
   `9 ÷ 0 =` → `Cannot divide by zero`.

### 8.6 CALC-2 và CALC-3

Sau khi merge PR của PRD trước:

```bash
bash docs/workshop/send-prd.sh docs/workshop/calculator-prds/CALC-2-keyboard-and-history.md
# merge PR CALC-2, rồi:
bash docs/workshop/send-prd.sh docs/workshop/calculator-prds/CALC-3-memory-percent-dark-mode.md
```

Runner chạy được 2 loop cùng lúc, nhưng gửi CALC-2 và CALC-3 song song sẽ tạo
hai PR cùng sửa logic và bố cục, dễ conflict khi merge. Chỉ làm vậy nếu muốn
demo xử lý conflict.

### 8.7 Các tình huống nên demo thêm

Đã thử thật trên môi trường demo (kết quả ở cột cuối):

| Tình huống | Làm gì | Kết quả |
|---|---|---|
| Đang chạy | Gửi lại cùng key với id mới khi run của key đó đang chạy: `bash docs/workshop/send-prd.sh <file> CALC-1-again` | HTTP 200; delivery `ignored`, "Run already active"; không có run mới |
| Trùng request | Gửi lại đúng `id` cũ: `bash docs/workshop/send-prd.sh <file> <id cũ>` | HTTP 200; không ghi thêm delivery, không có run mới (request lặp lại bị bỏ qua) |
| Sai loại | Gửi `"type": "feature"` | HTTP 200; delivery `ignored`, "No enabled trigger matched" |
| Thiếu `title` | Gửi body không có `title` | HTTP 200; delivery `ignored`, "invalid_payload: title: …" |
| Sai secret | Đổi `AGENTFLOW_TRIGGER_SECRET` | HTTP 401 `{"ok":false,"message":"Unauthorized"}` |
| Câu hỏi mở | Run dừng ở `needs_input`, trang run và plan hiện câu hỏi | Trả lời bằng cách sửa PRD (thêm câu trả lời) và gửi lại **cùng key, id mới**: run tiếp tục, plan được sửa lại (re-plan) |

## 9. Checklist kiểm tra dữ liệu (PRD, Plan, Session, Agents)

Chạy `bash docs/workshop/monitor.sh` sau mỗi run và so với bảng dưới. Cột
"Lần chạy thử" là kết quả thật của các run ngày 12/10 (✅ đúng, ⚠️ sai hoặc
thiếu, kèm lý do; các lỗi ⚠️ đã sửa, xem ghi chú).

| Dữ liệu | Cần thấy | Lần chạy thử |
|---|---|---|
| Delivery của HTTP trigger | Một dòng `accepted`, "1 run started", `run_count = 1` | ✅ |
| Run | `succeeded`, `cycle = 1`, không có lỗi; có PRD, Plan, `branch_name`, `pr_url` | ✅ `succeeded` sau 1 giờ 04 phút; branch `symphony/pln-1`; PR #1 |
| PRD | Document loại PRD, tên `CALC-1: Basic calculator`, nội dung = `description`; `APPROVED` lúc tạo, `EXECUTED` khi run thành công | ✅ PRD-1 `APPROVED` → `EXECUTED` |
| Implementation Plan | Loại IMPLEMENTATION_PLAN, `DRAFT` → `APPROVED` trước EXECUTE, version tăng khi plan được tải lên; PRD `PRODUCES` Plan | ✅ PLN-1 v2 `APPROVED`, liên kết PRD-1 → PLN-1 |
| Loops | `PLAN` và `EXECUTE` đều `COMPLETED`, cùng document, cùng branch | ✅ PLAN 17 phút, EXECUTE 47 phút |
| Chi phí loop | Bằng chi phí Claude Code báo; token theo từng model thật (không có `default`) | CALC-1: ⚠️ `0.00` (ghi chú 1). CALC-3 PLAN (runner đã sửa): ✅ 3,87 USD = opus 3,57 + sonnet 0,27 + haiku 0,03; 74.890 output token, khớp `result` của Claude Code |
| Sessions | Một session cho mỗi loop, tên `PLAN PLN-1 · workshop/calculator`, `active` khi chạy, `inactive` khi xong, model, số agent, số tool call | ✅ luôn có, không cần cấu hình (mục 5.3) |
| Token/chi phí session | Bằng số Claude Code báo: `result` cuối của mỗi phiên Claude, cộng các phiên; chi phí tách theo model | ✅ sau khi sửa (ghi chú 2): CALC-1 EXECUTE 123.110 token in+out, 6,25 USD; CALC-2 EXECUTE 271.524 token, 11,58 USD (opus 8,55 + sonnet 2,84 + haiku 0,19) |
| Agents | Kho agent của runner (subagent, skill, command, plugin) và số lần gọi trong các session | ✅ 112 component; 17 agent/skill được gọi (verification-subagent 9 lần, implementation-subagent 8, build-validator 2, …) |
| Pull request | Post action `local_git.create_pull_request` `succeeded`, PR mở vào `main` | ✅ PR #1, 27 file, mô tả có link plan và run |
| Code | `npm test` và `npm run build` chạy được; các acceptance criteria của PRD đúng | ✅ 68 test pass, build OK; tự kiểm 12/12 AC bằng test riêng |
| Decision table + Phase 5.5 | `plan.json` có `decisionTable`, Phase 5.5 chạy behavior-verifier, `decisionTable.status = aligned` | CALC-1: ⚠️ không có (ghi chú 3). CALC-2: ✅ `aligned` sau 2 vòng behavior-verifier, tự sửa 6 chỗ lệch (4 code, 2 test) — `.agentflow-ai/work/decision-table-verifications.jsonl` |

Ghi chú:

1. **Chi phí loop = 0 (đã sửa).** Model provider của runner-1 xác thực bằng
   `ANTHROPIC_CUSTOM_HEADERS`, nên Claude Code báo `apiKeySource: "none"` và
   AgentFlow từng coi như gói subscription (không tính tiền theo token). Giờ
   `"none"` chỉ được coi là subscription khi compute target không có model
   provider. Chi phí loop lấy đúng số Claude Code tính
   (`usageReconciliation.authoritativeCostUsd`, cộng mọi phiên Claude của
   loop); sự kiện `completed` gửi token theo từng model thật (không còn
   `default`), và bảng giá của API có thêm Sonnet 5.5, Haiku 5.5. Chi phí thật
   của CALC-1: PLAN 3,32 USD + EXECUTE 6,25 USD ≈ **9,57 USD**.
2. **Token của session bị đếm trùng (đã sửa).** Một phiên Claude Code phát
   nhiều sự kiện `result`, mỗi cái là tổng *cộng dồn* tới lúc đó; runner cũ
   cộng tất cả lại (session EXECUTE của CALC-1 có 20 `result`: ghi 129 triệu
   token thay vì 9,3 triệu) và không gửi chi phí. Giờ runner giữ `result` cuối
   của mỗi phiên, cộng các phiên, và gửi chi phí theo từng model. Sau khi cập
   nhật, runner gửi lại các loop kết thúc trong 24 giờ, nên session cũ cũng
   được sửa số.
3. **Không có decision table, Phase 5.5 bị bỏ qua (đã sửa, xác nhận ở CALC-2).** Khi không cấu hình critic
   nào, prompt cũ nhảy từ Phase 2.5 thẳng sang Phase 3, bỏ qua Phase 2.7 (chốt
   plan + tạo decision table); orchestrator sau đó tự bỏ qua Phase 5.5. Đã sửa
   trong `agent-plugins/code` (Phase 2.5 không có review → Phase 2.7;
   plan-writer ghi decision table vào đúng thư mục Phase 5.5 đọc).
4. Phase 4 (đơn giản hoá code) bị bỏ qua vì agent `code-simplifier` (plugin
   ngoài) không có trên runner self-hosted; Phase 6 (kiểm tra giao diện) bỏ
   qua vì không có dev server đang chạy. Cả hai không chặn run.

## 10. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `send-prd.sh` trả HTTP 401 | Sai secret, hoặc secret đặt trong `Authorization: Bearer` | Lấy lại ở Show URL and secret; dùng header `X-AgentFlow-Token` |
| HTTP 200 nhưng không có run | Delivery `ignored` (sai `type`, thiếu `title`, run cùng key đang chạy), hoặc trùng `id` (không ghi delivery) | Lý do ở dialog Show URL and secret hoặc `monitor.sh` mục Deliveries; trùng `id` thì gửi lại với id mới |
| Run `failed` với `compute_target_unavailable` | runner-1 offline | `docker ps`, `docker logs agentflow-runner-1` |
| Loop lỗi `426 Outdated Claude Code version` | Proxy của model provider chỉ nhận một phiên bản | Model provider → Claude Code version |
| Clone/push lỗi | `runnerUrl` của connection sai | `http://host.docker.internal:3300` cho runner trong Docker |
| Không xem được transcript/attachment trên Mac | Mac không phân giải `host.docker.internal` | Thêm `127.0.0.1 host.docker.internal` vào `/etc/hosts` |
| Run kẹt ở `needs_input` | Plan có câu hỏi mở và `stopOnOpenQuestions: true` | Trả lời như mục 8.7, hoặc tắt `stopOnOpenQuestions` cho buổi demo |
| PR không được tạo | Post action lỗi | `monitor.sh` mục Post actions; trang run có nút retry action |

## 11. Chạy lại workshop từ đầu

- Cách nhanh: tạo repository mới (Project → Integrations → Create and add, ví dụ
  `calculator-2`), gỡ repository cũ khỏi project, rồi gửi lại các PRD (id mới
  được sinh tự động).
- Cách sạch: tạo project mới và workflow mới trỏ tới project đó; dữ liệu cũ
  vẫn còn để so sánh.
