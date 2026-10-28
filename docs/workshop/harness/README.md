# Kịch bản: agent team do revfactory/harness sinh ra thay cho agent built-in

Mục tiêu: kiểm tra một harness được **sinh tự động** bởi
[revfactory/harness](https://github.com/revfactory/harness) v2.1.0 (meta-skill của
Claude Code) có lập kế hoạch và implement PRD được trên AgentFlow chỉ qua cơ chế
toolkit của Process không, và so kết quả với Spec Kit (`../speckit/`) và Process
built-in trên cùng code xuất phát và cùng PRD RC-1..3.

## Thành phần

| Thứ | Giá trị |
|---|---|
| Repo code | `workshop/harness-calculator` (Local Git, cùng commit xuất phát `fc8d27c` với `workshop/react-calculator` của Spec Kit) |
| Repo toolkit | `workshop/harness-toolkit` (`e8beb46`): `.claude/agents` (4), `.claude/skills` (5), `CLAUDE.md`, `GENERATION-PROMPT.md`, `runs/` |
| Project | **React Calculator (Harness)** `PRO-3` (team Engineering, runner `runner-1`, 2 repo trên) |
| Process | `harness-process.yaml` (version 1 của project) |
| Workflow | **React Calculator PRDs (Harness)** (`harness-workflow.yaml`), trigger HTTP, `types: [prd]` |
| Gửi PRD | `./send-prd.sh prds/RC-1-working-calculator.md` (URL + secret trong `~/.agentflow/harness-trigger.env`) |

`prds/` là bản sao PRD của Spec Kit; RC-1 chỉ đổi tên repo trong phần Background.

## Harness được sinh thế nào

Chạy trên Mac (không phải trên runner), trong một workspace chỉ có
`harness-calculator/` ở `fc8d27c`:

```bash
claude -p --plugin-dir <clone của revfactory/harness @ 92d9f1b> \
  --permission-mode bypassPermissions "$(cat GENERATION-PROMPT.md)"
```

16 lượt, ~7 phút, $3.50, không đụng repo code. Prompt (`GENERATION-PROMPT.md` trong
repo toolkit) đè các mặc định của harness cho phù hợp runner headless:

| Mặc định của harness | Trong workshop | Lý do |
|---|---|---|
| Workflow / persistent agents + `SendMessage` | Chỉ sub-agent delegation (`Agent` + `subagent_type`) | `claude -p` một lần, không có ai đồng ý `Workflow` |
| `model: fable/opus/sonnet` theo agent | `model: inherit` | Model provider của runner-1 (proxy Azure) quyết định model |
| `_workspace/` | `harness-toolkit/runs/<KEY>/` | Hai phiên plan/build chỉ chia sẻ file; file về lại repo toolkit qua PR |
| Hỏi người dùng ở bước 0 | Không hỏi, ghi giả định vào plan | Chạy unattended |
| Test A/B with-skill vs baseline (6-3) | Bỏ qua | Chính workshop này là phép so sánh |

Team sinh ra:

| Agent | Phiên | Việc |
|---|---|---|
| `calc-planner` | plan | Phân tích PRD + code, viết plan `- [ ] T001 …`, sửa theo review |
| `calc-reviewer` | plan + build | Review plan (tối đa 3 vòng); cổng review cuối của build |
| `calc-developer` | build | Implement từng module + Vitest, sửa finding |
| `calc-qa` | build | QA ngay sau mỗi module: test, build, đối chiếu logic ↔ component |

Skill: `calc-prd-delivery` (orchestrator), `calc-codebase`, `calc-planning`
(`check_plan.sh`, `mark_tasks.sh`), `calc-implementation`, `calc-quality-gates`
(`verify.sh`).

## Luồng một run

```
POST PRD ──► Plan ─────────────────────► Approve the plan ──► Build ─────────────────────────────► PR × 2
            /calc-prd-delivery plan        (admin trên web)      /calc-prd-delivery build              harness-calculator
            planner → reviewer (≤3 vòng)                         theo module: developer → qa (≤2 fix)   harness-toolkit (runs/)
            → .agentflow-ai/work/plan.md                         → verify.sh → reviewer cuối → verify
            (role: plan → Implementation Plan)                   (role: implement → push, release notes)
```

- Toolkit mount `.claude/agents` và `.claude/skills`; runner link từng entry vào
  `.claude/` của gốc workspace (`linkInto` trong
  `apps/desktop/src/server/operations/loop-step.ts`).
- Không có bước hỏi đáp: harness tự ghi giả định vào plan.
- Phiên build đọc `.agentflow-ai/work/plan.md`; nếu không có thì dùng
  `harness-toolkit/runs/<KEY>/04_main_final-plan.md`.

## Những gì cần quan sát

1. Phiên plan có thật sự gọi được custom agent `calc-*` từ mount không (session
   của loop có các lượt `Agent` với `subagent_type: calc-planner` …), hay rơi về
   `general-purpose`.
2. `harness-toolkit/runs/RC-1/` có đủ file `00`–`05` và `10`–`40`; `plan.md` có `[X]`.
3. Plan mà người duyệt thấy có phải là `.agentflow-ai/work/plan.md` của phiên plan;
   phiên build có đọc được nó không (hay dùng `04_main_final-plan.md`).
4. `verify.sh` PASS (`npm ci`, `npm test`, `npm run build`), hai PR trên Local Git.
5. So với Spec Kit RC-1 (~91 phút, 34 task, 125 test): thời gian, số task, số test,
   cấu trúc code, số vòng review/fix.

## Kết quả

### RC-1 — Make the calculator work (2026-10-19, run `01a15221`)

- Run succeeded in ~101 min wall clock: plan ≈ 14 min ($2.32, 11 turns), approval of PLN-11 in
  the UI (~63 min waiting), build ≈ 24 min ($4.04, 21 turns).
- The mounted custom agents resolve in the headless loop: the session `init` lists `calc-planner`,
  `calc-reviewer`, `calc-developer`, `calc-qa` next to the plugin agents, and every delegation used
  them (no `general-purpose` fallback).
- Plan: r1 REVISE (0 blocker, 2 major, 4 minor; the reviewer ran node to show `toFixed(10)`
  artefacts for large integer parts and a wrong expected test value), r2 APPROVE. 13 tasks in
  4 modules, 17 requirements, 17 assumptions; `check_plan.sh` OK.
- Build: M1–M4 each passed QA in round 1 (no fix rounds); final review APPROVE with 3 minor
  (unreported transitive `rollup` 3.10.1 → 3.30.0 lockfile bump, visual checks not done in a real
  browser, an unreachable defensive fallback). `verify.sh` PASS (`npm ci`, `npm test`,
  `npm run build`); 13/13 tasks `[X]`; logic in `src/logic/calculator.js`, 136 Vitest tests.
- `runs/RC-1/` has every file `00`–`05`, `10`–`40` plus `plan.md` and `10_main_baseline-status.md`.
- PRs: `workshop/harness-calculator#1` (code, 9 files), `workshop/harness-toolkit#1` (21 run files).
- Compared with Spec Kit RC-1 (agent time ≈ 47 min, 34 tasks, 125 tests): agent time ≈ 38 min,
  13 coarser tasks, 136 tests; an explicit review loop on the plan and per-module QA instead of
  Spec Kit's clarify/analyze.
- AgentFlow issues found:
  - The approved plan is stored with `>` escaped as `&gt;`, and the runner writes that copy back
    to `.agentflow-ai/work/plan.md` for the build session (only prose was affected here). Cause:
    `sanitize-html` in `apps/api/app/documents/sanitize-content.ts` encodes `>` and `&` in text;
    fixed with a `textFilter` that restores them (`<` stays encoded).
  - `agent-plugins/code/hooks/session-end-hook.sh` writes its debug log under the hook's `$CWD`;
    the plan session ended inside `harness-toolkit/runs/RC-1/`, so a stray
    `.agentflow-ai/session-end-hook-debug.log` appeared there (it was not committed).
  - The build commit message in both repositories reads "Implementation plan — …".
