# Notes for coding agents

## Project

Probei is a visual QA agent: scenario → screenshot → Meta model decides one action → Playwright acts → repeat → bug report.

```
src/config.ts   provider settings from .env (baseten | meta), agent settings
src/llm.ts      OpenAI-compatible client, JSON extraction (strips <think> blocks), one retry
src/browser.ts  Playwright session: screenshots, actions, page/console/5xx error capture, video
src/agent.ts    system prompt, action schema + validation, the run loop, stuck detection
src/suggest.ts  app review crawl + scenario drafts from the Meta model
src/projects.ts web UI projects (app URL + saved scenarios) in data/projects.json
src/server.ts   web UI API: runs, projects, auto-review; web/ is the page
src/report.ts   report.json + report.md per run in runs/<run-id>/
src/cli.ts      npm run probe -- --url ... --scenario "..." [--max-steps N] [--headed]
zoo/            demo apps with planted bugs; zoo/bugs.json is ground truth
```

Commands: `npm install`, `npm run browsers`, `npm run zoo`, `npm run probe -- ...`, `npm run typecheck`.

## Rules

- The agent's runtime decisions use Meta models only (Meta Model API or Muse Spark Open via a partner). Other models may help write code, never run inside Probei.
- Never put secrets in the repo. Keys live only in `.env` (git-ignored). The repo is public.
- The agent must never see `zoo/bugs.json`: not in prompts, not via the zoo server (it returns 404 for it).
- Baseten model name is exactly `meta-models/muse-spark-open-1026`.
- Keep `.env.example` in sync when adding settings.
