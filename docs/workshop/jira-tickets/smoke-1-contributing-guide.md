# Add a contributing guide

The repository has only a README so far. Add a `CONTRIBUTING.md` at the
repository root for the people who work on the Calculator app, and link it
from `README.md`. In under 40 lines it explains:

- how work arrives: an issue in the Jira project CALC, assigned to the
  AgentFlow bot;
- the branch and pull request flow: AgentFlow pushes a branch and opens a pull
  request on Local Git; a person reviews and merges it;
- what to run before merging: `npm install`, `npm test` and `npm run build`
  (the app and its scripts arrive with a later PRD; until then the guide says
  so).
