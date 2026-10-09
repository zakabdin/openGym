# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

openGym is a self-hosted gym & body-weight tracker PWA. Three containers (`db` PostgreSQL + `api` + `web`) plus a
`./data` folder and `./pgdata` the user owns — no third-party account, no telemetry. Passkey (WebAuthn) login,
installable as a home-screen app, optional Capacitor shells for standalone Android/iOS builds.
License: AGPL-3.0-or-later.

## Project layout

```
frontend/  React 19 + Vite app (src/views, src/components, src/store, src/lib). Builds to static files.
           android/ + ios/ are the Capacitor shells for the standalone mobile app (docs/MOBILE.md).
api/       backend — server.js (Node, no framework), deps: @simplewebauthn/server, web-push.
           coach/ is the optional AI coach; openapi.yaml documents every route.
web/       multi-stage Dockerfile (builds frontend → nginx) + nginx.conf.template (serves app, proxies /api).
mcp/       optional MCP server — read-only stdio bridge exposing a user's workouts/1RM/muscle
           balance to LLM clients (Claude Desktop, Cursor…). Not part of the Docker build; only
           runs when an LLM client spawns it.
media/     exercise img/gif, gitignored, fetched at runtime by the `media` compose service.
website/   static project site (plain HTML/CSS/JS), deployed separately.
kubernetes/ example manifests (docs/SELF_HOSTING_KUBERNETES.md).
docs/      guides indexed in docs/README.md (FAQ, SELF_HOSTING*, MOBILE, AI_COACH, DATA_IMPORTS, API);
           docs/dev/ holds feature design notes (SET_TYPES: drop sets/rest-pause, LIST_VIEW, COMBINE_ROUTINES).
```

## Commands

```bash
# Local stack (api + web + media, prebuilt or built from source)
cp .env.example .env
docker compose up -d --build

# Frontend dev server (hot reload), proxies /api to :3000
cd frontend && npm install && npm run dev

# Frontend tests (training logic: progression, 1RM, session read-back)
cd frontend && npm test            # vitest run
cd frontend && npm run test:watch
npx vitest run src/lib/progression.test.js   # single file
npx vitest run -t "some test name"           # single test by name

# API and MCP server tests
cd api && npm test
cd mcp && npm test

# Production build
cd frontend && npm run build
cd frontend && npm run build:mobile   # + cap sync, points media at the CDN dataset
```

There is no linter/formatter configured (no ESLint/Prettier config in the repo) and no
TypeScript — match the existing style by hand.

GitHub (`github.com/DuarteSantos8/openGym`) is the home of the project; `.github/workflows/mirror.yml`
pushes `main` and `v*` tags to the GitLab mirror. Pull requests are gated by
`.github/workflows/test.yml` on Node 22 — the same version as `web/Dockerfile` / `api/Dockerfile`
(`node:22-alpine`): the frontend, api and MCP suites, the locale checks, and building and booting
both api image targets. GitLab CI on the mirror (`.gitlab-ci.yml`) builds the release artifacts:
the signed Android APK, the multi-arch images and the SBOMs. Never push or merge on GitLab
directly; the mirror is fast-forward only.

## Architecture

### Frontend (`frontend/src`)

- **`store/useStore.js`** — single Zustand store holding the entire client-side app state (`S`),
  persisted to `localStorage` (`gym_state_v1`) and debounce-pushed to the server when signed in
  (`pushState`, see `lib/api.js`). On the Capacitor mobile build it's also mirrored to a file via
  `lib/mobile.js` (`nativeSave`), since WebView storage can be evicted. `store/useUI.js` holds
  ephemeral UI state (modals, active sheet, etc.) separately from persisted data.
- **`lib/`** — pure, framework-free helpers, each paired with a same-directory `*.test.js`. This
  is where the domain logic lives, most importantly:
  - `progression.js` — the progression-rule engine (linear, Greyskull LP, double progression,
    time-based). Rules implement a shared policy interface; adding a new one plugs in here.
  - `onerm.js` — estimated 1RM from logged sets.
  - `finish-workout.js` — reduces a completed session back into state (weights advance, PRs, etc).
  - `recovery.js` / `recovery-view.js` — fatigue/muscle-recovery model.
  - `workout-model.js`, `supersetFlow.js` — in-session workout state machine, incl. supersets.
  - `exercises.js` / `exercises-data.js` — the exercise library (1,324 built-ins + user-defined).
  - `api.js` — the only place that talks to the backend (`fetch` wrapper, session cookie flows).
  - CONTRIBUTING.md is explicit: **anything that decides what you lift next, or reads a logged
    session back, is a pure helper here with a unit test beside it** — not verifiable by
    clicking, and the progression engine has already had two bugs that only a test caught.
- **`views/`** — one file per screen (Home, Workout, Plan, Library, Stats, History, Settings,
  Admin, Login, RoutineEdit), routed by `react-router-dom` from `App.jsx`.
- **`components/`** — shared UI (charts, modals, timers); `instr/` holds per-language exercise
  instruction text; `locales/` is the i18n string catalogue (`lib/i18n.js` / `i18n-core.js`).
- Mobile: `@capacitor/*` wraps the same web build into native shells under `frontend/android` and
  `frontend/ios` (see `docs/MOBILE.md`); `mobile.js` in `lib/` gates native-only behavior (file
  persistence, local notifications, wake lock) behind a `MOBILE` flag.

### API (`api/server.js`)

Single file, no framework, plain `node:http`. Requests are dispatched through a `routes` object
keyed by `'METHOD /path'` (e.g. `routes['GET /api/health']`) matched against `req.method + ' ' +
url.pathname` — add a new endpoint by adding a key here. State is in PostgreSQL
(`DATABASE_URL`), through `api/store.js`: users (a `data` jsonb record plus derived index columns),
credentials, push subscriptions, invites, device links, `user_state` (per-user workout document,
with its `rev`), `assignments` (trainer inbox) and `audit`. Nothing is held in memory between
requests; a read-modify-write goes through `store.users.mutate` / `store.state.update`, which lock
the row. Auth is
WebAuthn passkeys (`@simplewebauthn/server`) plus a signed session cookie (HMAC'd with a
`DATA_DIR/secret` generated on first boot) — no JWT/session-store dependency. Optional pieces
gated by env vars: `ADMIN_UIDS` (admin dashboard), `INVITE_ONLY` (signup needs a code),
`ALLOW_GUEST` (client-only guest mode never hits the server at all), plus the `audit`
table for sign-in/admin events. Web Push (`web-push`, VAPID keys
auto-generated into `data/vapid.json`) drives rest-timer-over and day-reminder notifications.

### MCP server (`mcp/src`)

Read-only stdio MCP bridge (`@modelcontextprotocol/sdk`) that lets an LLM client read a single
user's routines/workouts/body-weight/1RM/muscle-balance directly from the same `DATA_DIR` the API
writes to — no network call, no extra container. `state.js` loads/derives the data, `tools.js`
defines the exposed MCP tools (zod-validated schemas), `labels.js` maps internal keys to
human-readable labels, `index.js` wires it together. See `mcp/README.md` for the client-config
side (Claude Desktop / Cursor).

### Passkeys and self-hosting constraints

WebAuthn passkeys are bound to an exact hostname (`RP_ID`) and require HTTPS (localhost excepted)
— this shapes a lot of the API and Settings code (`RP_ID`/`ORIGIN` env vars, guest-mode fallback
when neither is available). Read `docs/SELF_HOSTING.md` before touching auth, session, or
notification code; it documents the exact env-var contract (`RP_ID`, `ORIGIN`, `PORT`,
`WEB_PORT`, `NGINX_PORT`, `BACKEND`, `SESSION_DAYS`, `ADMIN_UIDS`, `INVITE_ONLY`, `ALLOW_GUEST`,
`AUDIT_*`, `VAPID_SUBJECT`) that real deployments depend on.

### Docker / deploy

`docker-compose.yml` has three services: `media` (one-shot exercise-asset downloader, gitignored
output), `api`, `web` (multi-stage build of `frontend/` served by nginx, which also proxies
`/api` → `api` and serves the shared media volume — single origin, required for passkeys).
`web/nginx.conf.template` is rendered from env vars at container start (`NGINX_PORT`, `BACKEND`,
`PORT`), so host/port remapping works against prebuilt images without a rebuild.

### The Telegram bot's commands

`api/bot.js` answers what people type to the bot (`/start /help /plan /today /last /progress /weight
/clients /language /reminders /notifications`), read-only apart from those last three settings. Texts
live in `api/bot-i18n.js` (17 languages incl. Azerbaijani, all with the same keys — a test enforces it;
the app itself has no Azerbaijani pack yet). Telegram calls `POST /api/telegram/webhook`, proved by the
`X-Telegram-Bot-Api-Secret-Token` header (derived from the bot token, no extra env). On boot, on an
`https` `ORIGIN`, `bot.setup()` registers the webhook, the per-language command menu and descriptions
(skipped when unchanged, via `meta.bot_setup`). Replies use the language chosen in the app, else
Telegram's; notifications to a person go through `tgNotify` (translated, honours `/notifications off`).

`/done [minutes]` and the PDF buttons on `/plan` and `/today` work the same way: the bot only checks and offers a
button (`web_app` → `#/done/<min>` or `#/pdf/<plan|today>`); the app does the work because it owns the exercise
catalogue and how a finished workout is filed (`lib/finish-workout.js` `quickDone`/`fileWorkout`/`recordsOf`,
shared with the normal finish path), then POSTs `/api/telegram/document` or `/api/telegram/say` to put the
result in the person's own chat. The server never writes a workout itself.

**Azerbaijani in the app is parked, not deployed.** The 1,708-string pack (`locales/az.js` + `az` in
`i18n-core.js`) lives on branch `azerbaijani`; `telegram` has it reverted (`8082d2d`, `c6f1a42`) so a deploy
doesn't ship it. To ship it later: on `telegram`, `git revert c6f1a42 8082d2d` (undo the reverts). The bot's
Azerbaijani texts (`bot-i18n.js`) are separate and already live.

**Admin "Reset data…"** (user page of `/admin`) clears a profile for a fresh-start look: the training
document becomes `{resetAt, lang, langAuto, _rev+1}`, the inbox and uploads go, the account stays. Devices
follow because `resetAt` without `resetIds` makes a copy that missed it keep only what it made afterwards.

### Production server (opengym.one)

The maintainer's live instance: a VPS behind Cloudflare and nginx (Origin Certificate), Docker
Compose from a checkout at `~/openGym` on the `telegram` branch, user `deploy`. Services are
`db` (Postgres), `api`, `web` (+ one-shot `media`); `web` is bound to `127.0.0.1:8081` by an
untracked `docker-compose.override.yml` on the server — leave that file alone. The server's `.env`
holds the secrets (bot token, `DATABASE_URL`, admin login); never print or commit it.

- **Run something on the server:** `./ssh-server.sh '<command>'` (repo root, gitignored; logs in as
  `deploy`). Without arguments it opens a shell.
- **Deploy** (only when the user asks): push to `telegram`, then
  `./ssh-server.sh 'cd ~/openGym && git pull --ff-only origin telegram && ./scripts/deploy.sh'`.
  The script builds first while the old containers serve, then `docker rollout api` starts a second
  api container, waits for its healthcheck and removes the old one (zero downtime), then recreates
  `web` (under a second). It needs the `docker-rollout` plugin, installed on the server at
  `~/.docker/cli-plugins/docker-rollout` (pinned v0.14); without it the script falls back to a plain
  `up -d` with a short gap. Schema changes must be backward compatible (old and new api overlap).
- **Verify after a deploy:** `curl https://opengym.one/api/health` (`{"ok":true,"users":N}`) and
  `./ssh-server.sh 'cd ~/openGym && docker compose ps'` — all services `healthy`.
- The production database is shared, real data. Do not edit rows (for example attaching a user to a
  trainer) or reset it without the user's explicit go-ahead.
- Local testing without the live bot: run the API against the Postgres test container
  (`TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/opengym`, a throwaway `DB_SCHEMA`) with
  `TELEGRAM_BOT_TOKEN=123456:TEST-token`, then sign users in with a stubbed `window.Telegram.WebApp`
  whose `initData` is signed with that token. Clear stale cookies first: a session cookie beats a
  Bearer token.

## Guidelines from CONTRIBUTING.md worth knowing before changing code

- **Dependency-light is a hard constraint, not a preference.** Frontend: React + Router + Zustand
  and nothing else. `api/`: two dependencies total. New dependencies are a hard sell either side.
- Don't commit `media/` or `data/` (gitignored).
- Training-logic changes (progression, 1RM, session read-back) need a unit test in `src/lib`
  beside the code, not just manual clicking-through.
