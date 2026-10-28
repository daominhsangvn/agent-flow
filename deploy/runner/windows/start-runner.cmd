@echo off
rem Starts the AgentFlow runner (docs/runner.md "Option D: Windows").
rem The first start asks for the API URL, API key, runner name and workspace,
rem and saves them to %USERPROFILE%\.agentflow-runner\runner.env.
rem start-runner.cmd --project PRO-1 starts the personal runner of a project.
setlocal
where node >nul 2>nul || (
  echo Node.js 22 or later is required: https://nodejs.org
  exit /b 1
)
node "%~dp0runner.mjs" %*
exit /b %ERRORLEVEL%
