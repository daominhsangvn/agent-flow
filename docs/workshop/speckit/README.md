# Kịch bản: toolkit Spec Kit ngoài thay cho agent built-in

Mục tiêu: kiểm tra một project của AgentFlow có thể lập kế hoạch và implement
PRD **chỉ bằng skill/command của một toolkit ngoài** (GitHub Spec Kit nằm trong
một repo riêng), thay cho agent PLAN/EXECUTE built-in, và mọi artifact Spec Kit
sinh ra đều về lại repo toolkit qua pull request.

## Thành phần

| Thứ | Giá trị |
|---|---|
| Repo code | `workshop/react-calculator` (Local Git, clone từ github.com/tncrayt/react-calculator, `main` = `fc8d27c`) |
| Repo toolkit | `workshop/speckit-toolkit`: Spec Kit 1.2.0 (`specify init --integration claude --script sh`), `.claude/skills/speckit-*`, `.specify/`, constitution 1.0.0 viết từ repo code |
| Project | **React Calculator (Spec Kit)** (team Engineering, runner `runner-1`, 2 repo trên) |
| Process | `speckit-process.yaml` (version 1 của project) |
| Workflow | **React Calculator PRDs (Spec Kit)** (`speckit-workflow.yaml`), trigger HTTP, `types: [prd]` |
| Gửi PRD | `./send-prd.sh prds/RC-1-working-calculator.md` (URL + secret trong `~/.agentflow/speckit-trigger.env`) |

Trạng thái repo code ban đầu: `npm ci` và `npm run build` chạy được, dev server
lên, giao diện có đủ phím nhưng **không phím nào hoạt động** (`handleClick` trong
`src/App.jsx` toàn case rỗng) và chưa có test. RC-1 chính là làm cho nó chạy.

## Luồng một run

```
POST PRD ──► Specify ──► Clarify ──► Plan ──► Tasks ──► Approve the plan ──► Implement ──► PR × 2
            /speckit-   /speckit-   /speckit- /speckit-  (admin trên web)      /speckit-     react-calculator
            specify     clarify     plan      tasks                            implement     speckit-toolkit
                        (hỏi → chờ                (role: plan →                (role: implement
                        trả lời)                   Implementation Plan)          → push, release notes)
```

- Toolkit mount `.claude/skills` của repo toolkit vào gốc workspace, nên các
  bước gọi được `/speckit-*`. Không mount `.specify`: `instructions` của toolkit
  bảo agent coi `speckit-toolkit/` là project root của Spec Kit, nên `specs/`
  được ghi vào repo toolkit (không phải gốc workspace) và constitution được đọc
  từ đó.
- **Clarify** có `questions: ask`: nếu có câu hỏi, run chuyển `needs_input`;
  trả lời trong thẻ Process của run (ai trong org cũng trả lời được).
- **Tasks** có `role: plan`: ghép spec + plan + tasks thành
  `.agentflow-ai/work/plan.md`, AgentFlow giữ làm Implementation Plan của run.
- **Approve the plan**: run chuyển `needs_approval`; admin xem plan (và
  spec.md/plan.md/tasks.md) trên trang run rồi Approve hoặc Reject.
- **Implement** (`role: implement`): `/speckit-implement`, đánh dấu `[X]` trong
  tasks.md, viết release notes; khi xong AgentFlow commit + push **cả hai** repo.
- Action `local_git.create_pull_request` trên `execute.completed` mở một PR cho
  mỗi repo đã push: code ở `react-calculator`, specs ở `speckit-toolkit`.

## Các PRD (gửi theo thứ tự, merge PR của PRD trước rồi mới gửi PRD sau)

| Key | Nội dung | Phụ thuộc |
|---|---|---|
| RC-1 | Làm calculator chạy: nhập số, + − × ÷ trái sang phải, =, lặp =, DEL, RESET, chia 0, làm tròn, dòng biểu thức, a11y, Vitest | Không |
| RC-2 | Bàn phím + lịch sử 20 phép (localStorage, dữ liệu hỏng không làm sập) | RC-1 merged |
| RC-3 | %, ±, MC/MR/M+/M−, theme sáng/tối | RC-1 merged (RC-2 nếu có) |

## Những gì cần quan sát

1. `specs/001-.../` xuất hiện trong **repo toolkit** (không ở gốc workspace) và
   có trong PR của `speckit-toolkit`; `tasks.md` có `[X]`.
2. Run page: thẻ Process đi qua 6 bước, câu hỏi Clarify (nếu có), panel Approve,
   Implementation Plan là bản ghép từ Tasks, release notes.
3. Hai PR trên Local Git (http://localhost:3300/workshop/...), PR code có test,
   `npm test` / `npm run build` pass.
4. Session/loop: chỉ loop `STEP` (không có PLAN/EXECUTE built-in).

## Kết quả

### RC-1 — Make the calculator work (2026-10-17, run `01a14a88`)

- Run succeeded in ~91 min (specify → clarify → plan → tasks ≈ 16 min, approval, implement ≈ 31 min).
- Skills mounted from `speckit-toolkit` via `.claude/skills` symlink; all artifacts written to
  `speckit-toolkit/specs/001-calculator-core-behavior/` (none at the workspace root).
- Clarify asked no questions. Plan PLN-8 approved via `POST /workflow-runs/{id}/approval`.
- Implement: 34/34 tasks marked `[X]`; logic in `src/logic/`, 125 Vitest tests, `npm test` and `npm run build` pass.
- PRs: `workshop/react-calculator#1` (code), `workshop/speckit-toolkit#1` (9 spec files).
- Note: the action run's `externalRef` records only the first PR URL.

### RC-2 — Keyboard input and calculation history (2026-10-18, run `01a14cb6`)

- Sent after merging both RC-1 PRs. Run succeeded in ~37 min, including approval of PLN-9 in the UI.
- The new feature landed in `speckit-toolkit/specs/002-keyboard-history/` next to the merged `001-*`;
  the step files snapshot lists both feature directories.
- Implement: 38/38 tasks marked `[X]`; new `src/logic/{keymap,history,session}.js`,
  `src/storage/historyStorage.js`, `src/hooks/`, `HistoryPanel`; 312 Vitest tests, `npm run build` passes.
- PRs: `workshop/react-calculator#2` (code), `workshop/speckit-toolkit#2` (10 spec files).
- Note: on Node ≥ 25 the tests fail with `localStorage` undefined (Node's own Web Storage global
  shadows jsdom's). The runner uses Node 24; locally run with
  `NODE_OPTIONS=--no-experimental-webstorage npm test`.

### RC-3 — Percent, sign, memory keys and a light theme (2026-10-18, run `01a14cfb`)

- Sent after merging both RC-2 PRs. Run succeeded in ~71 min, including clarify answers and approval of PLN-10.
- First run where Clarify asked questions (keypad layout, theme flash on load): the run went to
  `needs_input`, the answers were given on the run page, and a second `clarify` loop recorded them
  under `## Clarifications` in `spec.md` (6 single-width rows; inline theme script in `index.html`).
- Feature landed in `speckit-toolkit/specs/003-percent-sign-memory-theme/`.
- Implement: 47/47 tasks marked `[X]`; new `src/logic/{memory,percentSign,theme,calcState}.js`,
  `src/storage/themeStorage.js`, `useTheme`, `ThemeToggle`, inline pre-paint theme script with a test that
  keeps it in sync with `resolveTheme`; 494 Vitest tests (Node 24), `npm run build` passes.
- PRs: `workshop/react-calculator#3` (code, 45 files), `workshop/speckit-toolkit#3` (10 spec files).
