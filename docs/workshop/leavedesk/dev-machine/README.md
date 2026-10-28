# Máy dev của An (Personal Runner)

Dev của LeaveDesk chạy trên **máy của dev**: một Ubuntu 24.04 (container `leavedesk-dev-an`)
có thư mục làm việc `~/work/leavedesk` và **credential của chính dev** (git/Gitea, Jira).
AgentFlow chỉ gửi model provider của Claude (cấu hình trên compute target `an-PRO-1`). BA, QC
design và QC run vẫn chạy trên `runner-1` / `runner-qc` như cũ.

| Trên máy | Là gì |
| --- | --- |
| `~/work/leavedesk/` | Thư mục project: `leavedesk-app/`, `leavedesk-superpowers/`, `.claude/skills` → skills của superpowers, `CLAUDE.md` mô tả thư mục |
| `~/.git-credentials`, `tea` | Tài khoản Local Git `an` (An Nguyen), quyền write trên 2 repo; commit ký tên An |
| `jira` | CLI Jira của dev (`jira login`: site, email, API token của **bạn**; lưu ở `~/.config/jira/credentials`, mode 600) |
| `~/agentflow-runner/` | `runner.mjs` + `agent-plugins/` (như bản release), log ở `runner.log` |
| `~/.agentflow-runner/personal/PRO-1/` | Cấu hình của personal runner (setup) |

## Dựng máy

```bash
docs/workshop/leavedesk/dev-machine/setup.sh      # image, container, user Gitea `an`, clone 2 repo, bundle runner
docker exec -it leavedesk-dev-an jira login        # bạn tự nhập API token Jira (id.atlassian.com → Security)
docker exec -it leavedesk-dev-an node agentflow-runner/runner.mjs setup --project PRO-1
docker exec -d leavedesk-dev-an bash -lc 'node agentflow-runner/runner.mjs --project PRO-1 >> ~/agentflow-runner/runner.log 2>&1'
```

Setup (personal): API URL `http://host.docker.internal:3002`, API key, project key `PRO-1`,
folder `/home/an/work/leavedesk`, parallel **no** (một checkout, các run xếp hàng), bỏ qua
permission **yes**, tên `an-PRO-1`, port `random`. Model provider: Settings → Compute &
Integrations → `an-PRO-1` (giống runner-1, cùng Claude Code 2.1.307 — image cài đúng bản đó).

## Workflow Dev (`../dev-personal-workflow.yaml`)

Cùng tên, trigger (`ready-for-dev`) và actions với `dev-workflow.yaml`, khác ở chỗ:

- `runner: an-PRO-1`; không toolkit, không `connections` cho step, không `role: implement`
  (role đó buộc AgentFlow push, personal runner từ chối).
- `plan`: tạo branch `<KEY>` từ `main` ở cả 2 repo; tải `PRD-<KEY>.md` bằng `jira attachment`
  (credential của dev); `writing-plans` → `work/<KEY>/plan.md`; câu hỏi lên ticket như cũ.
- `implement`: superpowers + TDD; commit bằng git của dev; **tự push và mở PR bằng `tea`**;
  `jira attach` file `PLAN-<KEY>.md` cho QC.
- Comment tóm tắt chạy ở `workflow.completed` (instruction action, chạy trên `an-PRO-1`, đọc
  `report.md` trong thư mục của dev) rồi label `dev-done`, In Review, link PR.
- Comment, label, transition của actions vẫn do bot Jira làm (server), như BA/QC.

Quay lại runner-1: lưu lại `dev-workflow.yaml` trong Workflows → Configuration.

## Theo dõi

```bash
docker exec leavedesk-dev-an tail -f /home/an/agentflow-runner/runner.log
docker exec leavedesk-dev-an ls /home/an/work/leavedesk/.agentflow-ai/runs   # work dir của từng run
```
