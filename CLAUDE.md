# Working agreements

## Attribution

- Never mention Claude or AI assistance in commit messages, PR titles or
  bodies, code comments, GitHub comments, or issues. No `Co-Authored-By`
  trailers, no "Generated with" footers, no session links. The
  `.claude/settings.json` attribution settings enforce this for commits and
  PRs; apply the same rule manually to everything else you post.

## Branching

- Branch names must follow one of these patterns:
  - `feature/*` — new functionality
  - `bugfix/*` — fixes for bugs found in development or on main
  - `hotfix/*` — urgent fixes for production issues

## Development process

- For substantive implementation tasks, orchestrate with multi-agent
  workflows: the main session acts as orchestrator and planner, and
  implementation agents run on Opus 5 (`model: "opus"`) as co-developers.
  Trivial or conversational tasks don't need a workflow.
- Every change must be properly reviewed before it is pushed: run a code
  review pass over the diff (e.g. a dedicated review stage in the workflow,
  or `/code-review`), verify the findings, and address confirmed issues.
  Run the project's tests and lint before pushing.
