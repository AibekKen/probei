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

Both are OpenAI-compatible, so switching is one line in `.env`.

## Quick start

```bash
npm install
npm run browsers          # downloads Chromium for Playwright
cp .env.example .env      # add your key(s); .env is git-ignored
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

## Roadmap for the hackathon

- [x] Agent loop v0, provider switch, reports with screenshots and video
- [x] Bug zoo app #1 (shop) with three planted bugs
- [ ] SAM 3.1 element finder (fallback: coordinates from Muse Spark)
- [ ] Bug zoo benchmark runner and metrics table
- [ ] Redesign test: same scenario on a restyled shop
- [ ] Voice scenarios (Muse Voice Transcribe)
- [ ] Web UI: start a run, watch it live, read the report

## Security

Keep API keys only in `.env`. Never commit it — the repository is public.
