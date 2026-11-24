# Catalys modules: how to work in this repo

This repo holds small, standalone Catalys tools ("modules"). They're vibe-coded fast, but built so each can go to production without a rewrite. Every agent (Orca, Claude Code, Codex, anything else) reads this file first.

## Read only what the task needs (SW-058)

| Task | Read first (stock-watch paths under `modules/stock-watch/`) |
|---|---|
| Any change | this file, then `modules/stock-watch/AGENTS.md` (files table, status) |
| A number on the page is questioned / engine change | `LOGIC.md` index at its top → that section only; `src/engine.js`, `test/engine.test.js` |
| New or changed route | `API.md`; `server.js` (`storeApi`); `src/access.js` (view-only gate); `SECURITY.md` endpoints table |
| Stored file or row format | `FORMATS.md`; `src/store.js`, `src/rows.js` |
| Secrets, auth, logs | `SECURITY.md`; `src/keys.js`, `src/log.js` |
| Deploy, backups, restore, incidents, container | `docs/RUNBOOK.md`; root `Dockerfile`, `modules/stock-watch/scripts/entrypoint.sh` |
| UI change | `public/app.js` (+ the feature's own `public/*.js`), `public/styles.css` tokens at the top; ADR-0006, ADR-0013; `test/ui-*.test.js` |
| Dates, days, hours | `public/tz.js` (LOGIC §0a); never a fixed +5:30 |
| What to build next / done criteria | `docs/BACKLOG.md`, `docs/DEFINITION-OF-DONE.md` |
| Why something is the way it is | `docs/adr/README.md` → the ADR; `docs/DECISIONS.md` |
| Recent history | `docs/DEVLOG.md` (newest 15; older in `docs/devlog/`) |
| Critic round | `docs/ORCA.md` prompts; save reports in `docs/reviews/` |

Fast checks: `npm run test:agent` (dots, failures only). `.ignore` keeps `node_modules`, data and screenshots out of searches.

## Layout

```
AGENTS.md                 this file: rules for every module
CLAUDE.md                 imports this file for Claude Code
docs/DEVLOG.md            what changed, when, and why (newest first; newest 15, older in docs/devlog/<YYYY-MM>.md via npm run devlog:rotate)
docs/reviews/             saved critic reports (README says how)
docs/DECISIONS.md         decisions that apply across modules
docs/ORCA.md              how to run several agents in parallel with Orca
docs/RUNBOOK.md           deploy, rollback, backups, restore, what to do when something breaks
docs/BACKLOG.md           the work, by SW-number; docs/DEFINITION-OF-DONE.md (DoR, DoD, PR checklist); docs/adr/ (ADRs)
SECURITY.md               every secret, where it lives, how to rotate it; auth model; destructive endpoints
.github/workflows/test.yml  CI on every push and PR: job `test` (npm test, Node 20 + 22, no install) and job `ui`
                          (npm ci → Playwright 1.65.1 + Chromium: npm run test:ui, smoke; screenshots artifact)
package.json              root scripts: test, test:ui (browser tests), test:smoke (smoke), stamp (BUILD_SHA before deploy)
.railway/railway.ts       Railway as code: region, one replica, /health check, /data volume
modules/<name>/           one folder per module, with its own AGENTS.md
  AGENTS.md               the module's context: purpose, data flow, files, status, next steps
  LOGIC.md                how every number is worked out and why: rule, reason, alternatives, limits
  CHANGELOG.md            user-facing changes per version (semver; top heading = package.json version, tested)
  API.md, FORMATS.md      every route; every row format and stored file (schemaVersion) (web app modules)
  .env.example            every variable the code reads, blank (no real values, ever)
  CLAUDE.md               imports AGENTS.md for Claude Code
Dockerfile                builds the module deployed on Railway (now: stock-watch)
```

| Module | What | Runs on |
|---|---|---|
| `modules/stock-watch` | Stock-out Watch web app: brand report (best sellers out of stock, month by month, 12 months), ads push / pause, restock list, read-only Shopify pull | Railway |
| `modules/stock-watch-sheets` | The same idea as a Google Sheet + Apps Script, fed by Shopify Flow (no server) | Google Sheets |

## Rules

1. **Read the module's `AGENTS.md` before touching it**, and work inside that one folder. A task that spans modules is split into one task per module.
2. **Context lives in Markdown, in the repo.** When you change how a module works, update its `AGENTS.md` in the same commit: what it does, its files, its status, what's next. The next agent should never have to rediscover anything.
3. **Log every change** in `docs/DEVLOG.md`: date, module, what changed and why, and anything left open. Newest first, a few lines each. Add the same line to the shared dev log page, Catalys Modules: Dev Log (https://claude.ai/artifact/27Q6x8r3rpZHYaNzhjW2Zq), which the team reads.
4. **Explain the logic** in the module's `LOGIC.md`: every number the user sees, with its rule, why we chose it, what else we considered and when it can be wrong. Change it in the same commit as the rule, so anyone who questions a number can check it.
5. **Record decisions** that outlive one change (data access, hosting, security) in `docs/DECISIONS.md`, with the date and who decided.
6. **Tests before push:** `npm test` at the root runs every module's tests (plain Node, browser tests skip). UI changes also run `npm run test:ui` and `npm run test:smoke` (Playwright: `npm ci` at the root, or `PLAYWRIGHT_PATH`; `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome); CI's `ui` job runs both. Add a test for each new behaviour.
7. **No secrets in git, ever.** Keys go in Railway variables or Azure Key Vault. Never in code, Markdown, logs or Google Sheets.
8. **Shopify is read-only** in every module. Only GraphQL queries are allowed through; no mutations, and no webhooks registered under someone else's app.
9. **One agent, one worktree, one branch.** When several agents run at once in Orca, each gets its own worktree (see `docs/ORCA.md`). Merge to `main` only after tests pass.
10. **Five critics review every dev cycle.** Before a change is called done, separate reviewer agents that haven't seen the builder's reasoning each give a ranked list of findings with file:line, marked confirmed or suspected:
    - **Logic critic:** the numbers. Formulas vs `LOGIC.md`, period windows, cost vs price, edge cases (no sales, no cost, short history), anything that would mislead a decision.
    - **UI critic:** the running app at 1280, 1440, 1920 and 390px. Wasted space, sideways scrolling, whether the decision number stands out, Performity consistency, accessibility.
    - **Cross-module critic:** the same rule gives the same answer in every module and against the client's existing tools (e.g. the DAWBU sheet), drift between docs and code, and what should be shared code.
    - **Simplicity critic:** can a busy manager or a first-time user understand each screen in five seconds? It flags what to cut, merge or hide behind "More", and jargon that needs a manual. **Default view = the decision; detail on demand.**
    - **Mobile critic and fixer:** reviews the phone layout (390px) and fixes what it finds in its own worktree or branch. The builder reviews the diff and merges it.
    The first four never change code. The builder fixes what holds up and records anything rejected, with the reason, in `docs/DEVLOG.md`. Prompts are in `docs/ORCA.md`.
11. **Stay standalone.** No module reads another team's database. Data comes from Shopify (read-only) into the module's own storage.

## Deploy

- Deploy is manual: from a clean, pushed `main` with CI green, run `npm run stamp && railway up && rm modules/stock-watch/BUILD_SHA` at the repo root (the stamp puts the commit on `/health`, `/status` and the footer) (Railway account Limitless Pixel, project `stock-watch`, service `web`, Singapore; the old project on the shivam account is obsolete): https://web-production-d8d7a911.up.railway.app. Pushing to `main` does **not** deploy (ADR-0012). Steps, rollback, backups and restore: `docs/RUNBOOK.md`. Secrets and auth: `SECURITY.md`.
- Railway builds the root `Dockerfile`, which copies `modules/stock-watch`.
- Variables are listed in `modules/stock-watch/AGENTS.md`.

## Not yet aligned

The plan is to follow the main product's (Performity's) conventions where they help ship to production faster, and keep things separate where they don't. Its repo hasn't been shared with us yet; once it is, record what we adopt in `docs/DECISIONS.md`.
