# Probei

A QA agent on Meta models that tests a web app the way a user does: it reads a plain-language scenario, looks at screenshots, clicks and types, checks the result and writes a bug report with steps and screenshots. No selectors, so tests survive a redesign.

Built for the **Meta Global AI Developer Hackathon** (Oct 26 – Nov 4, 2026), track **Indie**, theme **Build for Your World**. All code in this repository was written during the hackathon.

## How it works

1. **Scenario** — plain text: what to do and what is expected.
2. **Screenshot** — Playwright captures the page (1280×800).
3. **Decide** — Muse Spark looks at the screenshot and the history and returns one action as JSON.
4. **Act** — click, type, press a key, scroll or wait.
5. **Check** — repeat until the scenario passes, a bug is found, or the agent gets stuck.
6. **Report** — `report.md` and `report.json` with steps, screenshots, page errors and a video of the run. The video skips the time the model spends thinking, so a few clicks make a few seconds of video.

## Models

| Provider | Model | Set in `.env` |
| --- | --- | --- |
| Baseten (open weights) | `meta-models/muse-spark-open-1026` | `LLM_PROVIDER=baseten` |
| Meta Model API | Muse Spark (id from Meta docs) | `LLM_PROVIDER=meta` |

Whoever runs the agent locally chooses one of the two: set `LLM_PROVIDER` in `.env` and fill in only that provider's keys — the other section can stay empty. Both are OpenAI-compatible, so switching is one line in `.env`.

## Quick start

```bash
npm install
npm run browsers          # downloads Chromium for Playwright
cp .env.example .env      # pick one provider (LLM_PROVIDER) and add its key(s); .env is git-ignored
npm run zoo               # bug zoo shop at http://localhost:5173/shop/
```

In a second terminal:

```bash
npm run probe -- --url http://localhost:5173/shop/ \
  --scenario "Add 'Green tea' to the cart twice. Expected: the cart shows Green tea × 2 and the total is 5 000 ₸."
```

Add `--headed` to watch the browser. Results land in `runs/<run-id>/`.

No scenarios yet? Let Probei review the app and draft them:

```bash
npm run probe -- --url http://localhost:5173/shop/ --suggest
```

It crawls same-origin pages and asks the model for up to 10 runnable scenarios. In the web UI this is the "Auto-review" button on a project.

## Web UI

```bash
npm run ui   # http://localhost:5174/
```

The UI is a three-pane workspace:

- **Projects**: one per app URL. Create one, then press **Auto-review**: Probei walks the app's pages and saves drafted scenarios into the project. You can also write or edit scenarios yourself.
- **Scenarios**: each saved scenario has a Run button and its own run history underneath. **Run all** queues every scenario of the project; the server runs one at a time, in order, and the waiting ones can be cancelled. Auto-review never starts runs by itself.
- **Run**: live steps with screenshots, the bug report and the video of the selected run.

Projects live in `data/projects.json` (git-ignored); each run links to its scenario through `runs/<id>/meta.json`. Older runs that match no saved scenario show under **Unsorted runs**, where you can save them into a project. The server always runs headless; use `--headed` on the CLI to watch the browser.

By default the UI listens on `127.0.0.1` only. To run it on a server:

```bash
HOST=0.0.0.0 UI_PASSWORD=<long-random-password> ALLOWED_ORIGIN=https://probei.example.com npm run ui
```

- `UI_PASSWORD` is required when `HOST` is not local; the browser asks for it (any user name).
- `ALLOWED_ORIGIN` lists the pages allowed to start runs, so other sites cannot start runs through a visitor's browser.
- `ALLOW_PRIVATE_URLS` defaults to `false` off localhost: the agent then refuses localhost, private networks and cloud metadata addresses (`169.254.169.254`), checked after DNS resolution and on every request, redirects included.
- `UI_MAX_STEPS` caps the steps per run (default 30).

## Bug zoo

`zoo/` holds small demo apps with planted bugs. `zoo/bugs.json` is the ground truth (the agent never sees it) and lists a scenario for each bug plus clean scenarios that must pass. It is used to measure:

- bugs found out of the planted ones;
- false alarms on clean scenarios;
- whether tests still pass after a redesign;
- time and cost per run.

Run the benchmark with the zoo server up:

```bash
npm run zoo                  # in one terminal
npm run bench                # in another: runs every ground-truth scenario headless
```

Each case runs like a normal probe (reports land in `runs/bench-*/`), then gets scored: bug scenarios must end in `bug`, clean ones in `passed`. The score table prints to the console and saves as JSON to `bench/`. Useful flags: `--dry-run` (list cases without running), `--limit N` (first N cases), `--max-steps N`, and `--url-from/--url-to` to replay every scenario against a restyled copy for the redesign test. Cost uses `--price-in/--price-out` per 1M tokens (defaults: 1.25/4.25).

## Redesign test

`zoo/shop2/` is the shop after a redesign: new layout, theme, DOM structure and class names, but identical flows, copy and behavior (verified by driving both through the same click flow and comparing every text). The same scenarios run against it with no changes:

```bash
npm run zoo                                                     # in one terminal
npm run bench -- --url-from /shop/ --url-to /shop2/             # Probei on the restyle
node zoo/selectors.mjs http://localhost:5173/shop/              # classic selectors: PASS
node zoo/selectors.mjs http://localhost:5173/shop2/             # same script: FAIL
```

`zoo/selectors.mjs` is a plain Playwright check written against the old shop's classes and element positions — the kind of suite that breaks on every redesign. Observed result (Meta `muse-spark-1.3`, Oct 29): Probei found 1/3 bugs on the shop and 2/3 on the restyle with zero false alarms on either (small sample — scores vary run to run), while the selector script went from PASS to FAIL. No selectors, nothing to break.

## Roadmap for the hackathon

- [x] Agent loop v0, provider switch, reports with screenshots and video
- [x] Bug zoo app #1 (shop) with three planted bugs
- [x] Web UI: projects with saved scenarios, run-all queue, live run view, reports
- [x] Auto-review: crawl the app and draft scenarios (CLI `--suggest` and UI button)
- [x] Voice scenarios via the browser's speech recognition (no model tokens)
- [x] Deploy watch: notify on a new deploy, optionally run all tests after it
- [ ] SAM 3.1 element finder (fallback: coordinates from Muse Spark)
- [x] Bug zoo benchmark runner and metrics table
- [x] Redesign test: same scenario on a restyled shop

## Security

Keep API keys only in `.env`. Never commit it — the repository is public.
