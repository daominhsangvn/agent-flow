AgentFlow runner for Windows
============================

Runs AgentFlow agent loops on this computer, with the tools, databases and
network (VPN) it already has. Full guide: docs/runner.md, "Option D: Windows".

Install once (PowerShell):

  winget install OpenJS.NodeJS.LTS
  winget install Git.Git
  winget install jqlang.jq
  winget install Python.Python.3.12
  winget install GitHub.cli
  python -m pip install --user pyyaml
  irm https://claude.ai/install.ps1 | iex      (Claude Code, native installer)

Open a new terminal afterwards so PATH includes the new tools.

Run a dedicated, non-administrator Windows account for the runner when you
can: the agents can do anything that account can.

Start:

  start-runner.cmd    The first start asks for the AgentFlow API URL, an API
                      key (Settings -> API Keys), the runner name (default:
                      your Windows user name) and the workspace (default:
                      %USERPROFILE%\.agentflow\_works), then connects.
  setup-runner.cmd    Asks the questions again.

The answers are saved to %USERPROFILE%\.agentflow-runner\runner.env. Add more
variables there, one NAME=value per line, for the agents to use, e.g.

  CLAUDE_CODE_OAUTH_TOKEN=...            (from `claude setup-token`)
  ConnectionStrings__DefaultConnection=Server=localhost;Database=App_Agent;...

Variables set in the environment win over the file. Stop the runner with
Ctrl+C.

Personal runner (one project, in your own project folder, with this
computer's git, gh and Claude Code setup):

  setup-runner.cmd    Answer "personal" to the first question, then give the
                      AgentFlow project key (e.g. PRO-1), the project folder,
                      and whether your commands can run several tasks at once.
  start-runner.cmd --project PRO-1
                      Starts the personal runner of PRO-1. Run one per project;
                      they can run next to each other and next to the auto
                      runner. Settings: %USERPROFILE%\.agentflow-runner\personal\PRO-1\runner.env

See docs/runner.md, "Personal runner".
