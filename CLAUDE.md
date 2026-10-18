# Healthcheck: notes for Claude

An ops console for the loyalty platform's Linux servers (WildFly, WSO2 API Manager, Keycloak, Artemis, the Spring
Boot backends). It watches services, starts / stops / restarts them in order, reads logs, keeps each service's
history and raises alerts. Users are operators, many not technical: every text in the UI is plain language.

## How it's deployed

- **One local install per market**, each with its own database. Today Windows (NSSM service); Ubuntu is planned
  (`DEPLOYMENT-UBUNTU.md`), then a jar or docker compose at the end of release 1. Windows install: `DEPLOYMENT.md`.
- **No email server anywhere.** A forgotten password: another admin resets it; an admin can use their
  authenticator app (Forgot password); last resort `npm run reset-password -- <user>` on the machine.
- **First install:** the browser opens on "Create the first admin".
- Healthcheck signs in to the servers over SSH with its own key (`server/data/healthcheck_id_rsa`) as a service
  account (e.g. `svc_user`) with NOPASSWD sudo for `systemctl`.

## Layout and commands

npm workspaces: `shared/` (types), `server/` (Express + `node:sqlite`, Node 22.13+), `web/` (React + Vite).

```bash
npm install && npm run build && npm start   # the real thing (npm run dev restarts on every save: interrupts runs)
npm test                                    # builds, then every self-contained suite in tests/
npm run test:live                           # permissions suite against the running app
npm run settings                            # write / tidy .env (all settings, defaults, comments)
```

- `server/src/env.ts`: **every setting**, its default and its comment, in one list. `.env` in the repo root is the
  only settings file; Healthcheck writes it and adds new settings itself. A real environment variable wins (tests
  rely on that: they set `HEALTHCHECK_DATA_DIR` etc. before importing anything).
- `server/src/scan/journal.ts` + `history.ts`: service history from the journal (who did what: sudo lines,
  Healthcheck runs, systemd, reboots), with systemd's timestamps as the fallback.
- `server/src/scan/crashAlerts.ts`: alerts for a service that had been running fine and keeps crashing (never
  stopped by Healthcheck), with the reason from its log and the server's disk / memory.
- `server/src/orchestrator/sequenceRunner.ts`: Start / Stop / Restart (one or all), in Conditions order.
- `web/src/pages/ServerDetail.tsx`: the server page; `web/src/components/`: popups and windows.
- Tests: `tests/*.mts`, run with tsx; each makes its own temporary data folder. Add a suite to `tests/run.mjs`.

## Rules

- **Commit and push only when asked.** Push to both branches: `git push origin release-1 release-1:main`, then
  `git branch -f main origin/main`. Write the message to a file and use `git commit -F`.
- **Never commit** `Notes.txt`, `.env`, `server/data/` or `Services/`. Before every commit, check that
  `git diff --cached` doesn't contain the Artemis password (the value of `ARTEMIS_PASSWORD` in `.env`).
- **Never start, stop or restart services on the real servers** without the user's explicit go-ahead for that
  case. Read-only commands (`systemctl show`, `journalctl`, `tail`, `df`) are fine.
- **Before writing to the live database** (`server/data/healthcheck.sqlite`), back it up (`VACUUM INTO` a copy).
  Try things on a copy first (copy the database + `master.key` into a temp folder, set `HEALTHCHECK_DATA_DIR`).
- For bigger features the user wants **the logic discussed before it's built**: lay out the plan, ask the open
  questions, then implement what they choose.

## The test server

`loyalty_1` (Rocky Linux 9, systemd 252). `svc_user` is in `wheel`, so it can read the journal; the journal lives
only in `/run` (lost at a reboot). Backends log to `/Data/logs/...` and send their console output to `null`.
