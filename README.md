# Healthcheck

An internal ops console for the Loyalty Platform: add each Linux server that runs the
middleware/jars, connect to it over SSH, see what's running on it, and
start/restart/stop everything in the right order — gated on each step actually
becoming healthy before the next one starts. You manage **servers**: each one is checked and
controlled on its own.

> **Installing on another machine?** See [DEPLOYMENT.md](DEPLOYMENT.md).

> This file is kept up to date as the tool changes. If you make or ask for a
> change that affects setup, configuration, or day-to-day usage, update this
> file in the same pass.

---

## 1. Requirements

- Node.js 22+ (uses the built-in `node:sqlite` module — no native build tools,
  no Python/`node-gyp` needed).
- Network access from this machine to the Linux servers you'll manage, on their
  SSH port.

Each market/server must provide the following **before** Healthcheck can manage it. These are
prerequisites of the deployment, not something Healthcheck sets up:

1. **A service user and its password.** An SSH-enabled service account (e.g. `svc_user`) on each
   target server. Its password is entered once when you add the server (see
   [Adding a server](#3-adding-a-server)); after that Healthcheck uses its own SSH key and the
   password is never stored.
2. **That service user must be able to run `systemctl` with `sudo` without a password**
   (`NOPASSWD` in the sudoers file). Healthcheck runs `sudo -n systemctl start|stop <unit>` — `-n`
   means it never waits for or sends a password — so if the rule is missing the Start/Stop step
   fails with a message saying so. Example, in `/etc/sudoers.d/healthcheck` (edit with `visudo -f`):

   ```
   svc_user ALL=(root) NOPASSWD: /usr/bin/systemctl
   ```

   Check it on the server, logged in as that user — this must run **without asking for a password**:

   ```
   sudo -n systemctl status sshd
   ```

   Notes: use the path that `which systemctl` prints (`/usr/bin/systemctl` or `/bin/systemctl`). If
   sudo answers "you must have a tty to run sudo" (older RHEL/CentOS `requiretty`), also add
   `Defaults:svc_user !requiretty`. Reading status (`systemctl show`) needs no sudo.
3. **Every component installed as a systemd service** (`.service` unit) on the server — the unit
   files in `Services/` are the reference. Healthcheck does not install or convert anything: it
   detects, starts and stops through `systemctl` on the unit name.

## 2. Install & run

```bash
npm install                 # installs all three workspaces (shared/server/web)
npm run dev                 # runs the API (port 4000) and the UI (port 5173/5174) together
```

Open the UI at whatever port Vite prints (e.g. `http://localhost:5173`).

For a permanent/production install:

```bash
npm run build                # builds shared -> server -> web
npm start                    # serves the built UI + API from a single Node process on $PORT
```

### Environment variables (optional)

Set these as real environment variables, or in a `.env` file in the project root (a `server/.env` also
works; see `.env.example`). Real environment variables win over the file.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Port the API (and, in production, the UI) listens on. |
| `HOST` | `127.0.0.1` | Interface to bind to. Change to a LAN IP if you need to reach it from another machine. |
| `HEARTBEAT_INTERVAL_CRON` | `*/5 * * * *` | Cron expression for the background status check (the "heartbeat") — every 5 minutes by default. The "every N minutes" text on the server page follows it when it's in the `*/N * * * *` form. |
| `START_ATTEMPTS` | `3` | Start / Restart All: how many times to try a component that crashes on start before pausing to ask you. |
| `START_RETRY_DELAY_S` | `5` | Seconds to wait between those attempts. |
| `PORT_RELEASE_WAIT_S` | `30` | A start that fails because a port is already in use waits this long for the port to be released (a previous instance may still be shutting down) before it gives up and names who holds it. |
| `START_HINT_AFTER_S` | `30` | A unit that is running but hasn't printed its success line after this long gets the **Mark as started** button. |
| `START_PARALLEL` | `4` | Start / Restart All: how many components that no condition mentions are started at the same time. Each one keeps a log tail open over SSH, and Healthcheck never uses more than 8 SSH channels per server at once, which fits sshd's default `MaxSessions 10`. |
| `START_STAGGER_S` | `6` | Even within that limit, this many seconds are put between the *launch* of each parallel component, so their processes don't all hit the database (or anything else shared) in the same instant. A component that finishes early frees its slot immediately - the stagger only spaces out the start, not the whole run. |
| `HEALTHCHECK_DATA_DIR` | `server/data` | Where the SQLite database, the generated SSH keypair, and `master.key` live. Change this if you want the data directory somewhere other than inside the repo. |
| `HEALTHCHECK_PASSWORD` | *(none — auth currently disabled)* | Reserved for re-enabling the basic-auth gate in `server/src/middleware/auth.ts` if you ever expose this beyond localhost. |

**Do not delete the data directory** (`server/data` by default) — it holds every
server, catalog entry, job history, and the SSH key that's already
installed on your servers. There's no undo.

## 3. Using it

### Servers

The landing page (**Fleet overview**) has three panels on top — a welcome card with **Add server**, a
**Fleet health** donut (the share of components running across all servers, with Running / Stopped /
Problems counts) and **Recent activity** (the latest jobs; click one to open its server) — and below them
your **servers**, each with its connection status, how many components are running, and a chip per
installed component. The white bar at the top of every page finds a server by name (type, then Enter) and
shows how many components are running overall; the sidebar's **Add server** button works from any page.
Open a server to control it: everything on its page —
Start All / Restart All / Stop All, the per-component buttons, statuses, logs — applies to that one
server only. **Remove server** (top right of its page) makes Healthcheck stop managing it; nothing on the
machine itself is changed or stopped.

### Adding a server

Click **+ Add server** on the Servers page and give it:

- Server name (must be unique), host, port, SSH username
- The service account's **password** — used once

Healthcheck generates its own SSH keypair the first time it's needed (stored in
the data directory), connects with the password, appends its public key to
`~/.ssh/authorized_keys` on that server, and uses that key for every connection
from then on. **The password itself is never stored.** If the connection fails, nothing is created.

The moment the connection succeeds, Healthcheck checks the software catalog against that
server and automatically adds every component whose systemd unit is **installed** there —
running or not — and opens the server's page. **A server only ever lists what is installed on
it**, never the whole catalog: you don't tell it what's on the box. (If a component later turns out
not to be installed on the server, the next status check removes it from the list; if the server was
unreachable during that check, nothing is removed.)

_Upgrading from a version that had groups:_ groups no longer exist in the UI. On the first start, a
group that contained several servers is split so that every server has its own software list (a copy of
the group's list); old `/groups/...` links redirect to the server.

### The software catalog

The catalog (Software Catalog page) is a shared, reusable list of
software/jars — what to run to detect it, how to start/stop it, how to tell
it's healthy, and its log path. It **ships with the repository** (see *The catalog and conditions ship
with the repo* below) with 25 known components, each mapped to its systemd unit and its fixed
`/Data/logs/...` path:

| Catalog name | systemd unit |
|---|---|
| Keycloak | `keycloak.service` |
| WSO2 API Manager | `wso2am.service` **or** `wso2apim.service` (markets differ — whichever exists on the server is used) |
| Artemis | `artemis.service` |
| WildFly (JBoss) | `wildfly.service` |
| WSO2 Streaming Integrator | `wso2si.service` |
| Nginx, Filebeat | `nginx.service`, `filebeat.service` (standard package names — no unit file was provided) |
| conversion-rules-selector | `conversion-rule-selector.service` |
| earning-rules-selector | `earning-rule-selector.service` |
| rules-interpreter | `rule-interpreter.service` |
| mq-wrapper, voucher-backend, loyalty-backend, portal-backend, voucher-management, balance-management, conversion-backend, goal-backend, prize-draw-backend, sales-backend, usage-backend, streak-backend | `<same name>.service` |
| product-catalog | `product-catalog-backend.service` (the `admin/backend/product-catalog` one) |
| product-catalog-service | `product-catalog.service` (the `system-modules/product-catalog` one; no success pattern, so "unit is active" counts as healthy) |
| balance-notification | `balance-util.service` |

For a systemd entry the **Detect value is the unit name** — or several alternative names separated
by `|` (e.g. `wso2am.service|wso2apim.service`); on each server Healthcheck uses the one that
exists there, for detection, start and stop alike. The **Start/Stop
command are left blank** — Healthcheck runs `systemctl start|stop <unit>` itself
(via `sudo -n` when it isn't root). You generally don't need to add anything
before you start; **Edit** an entry from the Software Catalog page (not
delete/recreate — that would remove it from every server) whenever a new one is
needed or an existing path/pattern needs to change:

- **New service shows up** that isn't in the list yet — click **+ Add
  software**, give it its unit name (e.g. `new-thing.service`) and, since the
  fixed log convention is `/Data/logs/<component>/<file>.log`, set its **Log
  path** the same way. Everything about a catalog entry is editable at any time.

#### The catalog and conditions ship with the repo

The catalog **and the conditions** (next section) that you set up are stored in one file in the
repository: [`server/defaults/defaults.json`](server/defaults/defaults.json). Anyone who pulls the repo
gets exactly that catalog and those conditions — a new install starts with them already in place, nothing
to enter by hand. On every start Healthcheck loads the file and **merges** it into the local database, so
an upgrade never wipes what a customer changed:

- An entry or condition that isn't in the database yet is **added**.
- One that is there is left alone — except that a field **you changed in the file** is updated, as long as
  the customer never edited that field themselves (it still holds what was shipped before). A customer's
  own edit always wins over a newer shipped value.
- One the customer **deleted stays deleted**. Entries the customer created themselves are never touched.
- A shipped condition that would contradict one the customer made (a loop) is skipped, with a line in the
  start-up log.
- The start-up log says what was added or updated (`Shipped catalog/conditions applied: …`).

**To publish a change** — you tune the catalog or conditions in the UI on your own installation, then:

```bash
npm run build                # once, so the export tool is built
npm run defaults:export      # writes your catalog + conditions to server/defaults/defaults.json
git add server/defaults/defaults.json
git commit -m "Update shipped catalog/conditions"
git push
```

Customers then `git pull`, rebuild and restart (see DEPLOYMENT.md) and receive it through the merge above.
`npm run defaults:export` reads the database in `server/data` (or `HEALTHCHECK_DATA_DIR`) and shows what it
wrote. Don't put secrets in start/stop commands: they would be exported too.

**To put an installation back to the shipped state** (undo local edits to shipped entries, bring back
deleted ones; anything the customer added is kept): `npm run defaults:reset`, then restart the app.

### How "healthy" is decided

After a start, Healthcheck waits for the component to be genuinely up before it moves
on to the next one:

- **Success pattern** (regex) seen in *new* lines of the component's log → healthy. The
  defaults are: Keycloak `Listening on:`, WSO2 API Manager `WSO2 Carbon started in`,
  Artemis `Server is now live`, WildFly `WFLYSRV0025|WFLYSRV0026` (it prints `0025` when everything
  deployed cleanly and `0026` when it came up "with errors" - some deployment failed but the server
  itself is running; either one counts as started), and Spring Boot's
  `Started <App> in N seconds` for every jar except **mq-wrapper**, which logs through its own
  log4j2 layout and never prints that line: its default is `configureConnectionManager, s=success`
  (the last line of its start-up). These are educated defaults — if a
  component's log doesn't print its line (e.g. a jar's log level hides it) the start
  will time out; fix it by editing that component's **Success pattern** (or clearing it,
  in which case "unit is active" counts as healthy). Fix such a pattern once in the catalog and publish it
  with `npm run defaults:export` (see above).
- **Running, but no success line?** If systemd reports the unit as running for more than
  `START_HINT_AFTER_S` seconds (30) and the success line still hasn't appeared, the step's live log
  says so and a **Mark as started** button appears on that line (with an (i) explaining it). Click it if
  you can see the component is up: the run carries on as if it had become healthy — anything waiting for it
  starts — instead of sitting out the timeout. The real fix is the Success pattern in the Software Catalog.
- **Error pattern** (regex) — a new log line matching it is a *warning sign*, not an instant failure.
  For a systemd unit Healthcheck then checks whether the service really **died**: no longer running,
  waiting for systemd to restart it, or a new main process id. If so, the start counts as a **crash**
  (and is retried — see below). If the service just keeps running, Healthcheck keeps waiting for the
  success line, so a healthy start that happens to log an ERROR still passes. The default is
  level-based: `\b(ERROR|FATAL|SEVERE)\b|APPLICATION FAILED TO START` (a log line *at* ERROR/FATAL
  level, not the word "Exception" anywhere). The failure message shows the exact line. (An early version
  saved `\b` as a backspace character in the database, which silently stopped ERROR lines from matching;
  that is repaired automatically on start and before an export.)
- systemd reporting the unit as `failed`, or the **health timeout** (300 s for the WSO2/
  WildFly/Keycloak tier, 180 s for jars) passing → the step fails. A timeout is **not** retried (a slow
  start won't be quicker the second time).

A failed step never lets its dependents start (see *Operating a server* for what carries on and what
is held back).

- **Port already in use.** If the log says a port is taken (`Port(s) already bound: 9663, 7443`,
  `Address already in use`, `BindException`, `EADDRINUSE`, `Port 8080 was already in use`), retrying blindly
  is pointless, so Healthcheck instead: (1) stops the crash-looping unit, (2) waits up to
  `PORT_RELEASE_WAIT_S` seconds for the port to be released — a previous instance that is still shutting
  down is the usual cause, and it then tries again even if that was the last attempt, (3) if the port stays
  taken, looks on the server (`ss -ltnp`) for **who holds it** and puts that in the failure text and the
  question box: process, pid, user, how long it has been up, whether it belongs to a systemd service or
  was started by hand from a terminal, and its command line (passwords and tokens in it are masked).
  When the holder can be dealt with, the question box gets a **Free port(s) … and retry** button: it stops
  the holding systemd service with `systemctl stop`, or signals a stray process (`kill`, then `kill -9` after
  10 s), waits for the port to be released and starts the component again. It is offered only for
  processes the service user is allowed to stop — its own, or a systemd service (via the same NOPASSWD
  rule). A listener the SSH user can't see (another user's, without root) is reported as such, with the
  `sudo ss -ltnp` command to find it. Nothing is ever stopped without you pressing that button.

- **Expired password / credential.** A line mentioning an expired password or credential (`ORA-28001:
  the password has expired`, `password ... expired`, `expired ... password`, Active Directory's
  `data 773`) fails the step **without the usual retries**, since the same login will fail the same way
  every time until the password is changed on the server. It fails **immediately**, on the first attempt,
  when that line is itself flagged at ERROR/FATAL/SEVERE level (a Spring Boot jar logging its
  `Application run failed` line is genuinely dead the moment that prints). A line that only *mentions*
  the expired credential at a lower severity — WildFly's JCA layer logs a WARN ("Unable to fill pool")
  when one datasource can't connect, but the server itself often still finishes starting a moment later —
  is **not** treated as fatal on sight: the health check keeps waiting normally, and only if the unit
  actually goes down (or the health timeout passes) does the same expired-credential check run again to
  explain why. This avoids the false alarm of giving up on a component that was in fact still going to
  come up healthy. Either way, once it is treated as a genuine expired-credential failure, the question
  box offers only **Continue without it** and **Roll back** (stops everything the run has started so
  far) — Retry and Stop the run are hidden, since neither helps here. Continue skips it and carries on
  with the rest (holding back only what depends on it through a condition). **One shared password behind
  several components** (a common Oracle account, for example) usually expires for all of them at once —
  each one still gets its own question, since Continuing past one doesn't tell you whether you'd want the
  same answer for the next; Roll back on any of them stops the whole run, including ones already
  answered. The unit is also stopped outright as soon as this is confirmed, before the operator even
  answers — otherwise `Restart=` just keeps bouncing it against the database, hitting it with the same
  bad password every few seconds, for as long as the run's SSH connection stays open.

  Its Status column reads **"Failed (due to expired password)"**, and stays that way — a scheduled
  heartbeat re-check on a component parked in this state does not overwrite it with a plain "Stopped" (it
  genuinely is stopped, that reading isn't wrong, just less useful than the reason already known); it only
  updates once the component comes back up for real, or a fresh Start/Restart records its own new outcome.
  The check that decides this looks at the last 300 log lines, not 40 — a Hibernate/Spring stack trace
  routinely runs past 40 lines once its "Caused by" chain is included, and a smaller window could evict
  the one line that says why before this ever got a chance to look at it (which is why the same expired
  password could show up correctly for one component and as a bare "Failed" for another, in the same run).

### Start & stop order — Conditions

Each server has a **start order** and a **stop order**. Neither is edited by hand: both are worked out
from the rules on the **Conditions** page (sidebar → Configure → Conditions), and every server updates
as soon as a rule changes. The server's table shows both: **Start #** (the order Start / Restart All go
in) and **Stop #** (the order Stop All goes in).

There are two types of condition, and each one only affects its own order:

- **Start before** — "A must start before B". Honoured on every server that has both.
- **Stop before** — "A must stop before B". Honoured on every server that has both, and it wins
  over the default (below).

How the orders are worked out:

- **Start order:** your *Start before* conditions; anything they don't constrain is ordered
  services first, then by name.
- **Stop order:** by default the **reverse of the start order**; your *Stop before* conditions then
  override that wherever they apply. So if you never define a stop rule, stopping is simply start in
  reverse — a stop rule only exists to make stopping differ from that.
- Start rules and stop rules are checked separately, so a stop rule never conflicts with a start rule.
- Shipped rules (in `server/defaults/defaults.json`): *start before* — Keycloak → WSO2 API Manager,
  Artemis → WildFly (JBoss), and `conversion-rules-selector` → `earning-rules-selector` →
  `rules-interpreter`; *stop before* — WildFly (JBoss) → Artemis, WSO2 API Manager → WildFly (JBoss).
- Built-in: services come before jars, unless a condition says otherwise.
- Each condition has an **Active** switch (turn a rule off without deleting it), a note, and Delete.
  A rule that would create a loop among conditions of the same type (A before B before … before A) is
  refused.
- Shipped rules are merged in on every start (see *The catalog and conditions ship with the repo*): a rule you
  delete stays deleted until you run `npm run defaults:reset`.
- Restart All restarts each component (stop, then start) in the start order.
- **Only components a "Start before" condition mentions are started one after another.** Everything
  else (typically the jars, Nginx, Filebeat) is started **at the same time** as each other, up to
  `START_PARALLEL` at once, alongside that ordered chain. See *Operating a server*.
- The Conditions page is built around a condition **type**, so other kinds of condition can be added
  later without redesigning it.

### Operating a server

- **Start All** — starts only what's currently down. Leaves anything already healthy untouched.
  Components that a *Start before* condition ties together (Keycloak → API Manager, Artemis →
  WildFly, the rules selectors → rules-interpreter) start **one after another, in order**, each waiting
  until the one before it is healthy. Components that **no condition mentions** start **in parallel**
  — up to `START_PARALLEL` (default 4) at a time, and at the same time as that ordered chain — so
  ten jars no longer wait for each other. Their *launch* is still staggered `START_STAGGER_S` seconds
  apart (default 6s) so several JVMs don't open a database connection pool in the same instant — several
  Spring Boot apps starting at once can saturate a database and fail together, which is worse than
  starting one after another. The job panel shows all of them straight away: the ones running
  now with their **live log** (the last lines of the log they're being watched on), the rest as "waiting".
- **Restart All** — forces every component to stop and start again, even if it's already running. Same
  ordered-chain-plus-parallel behaviour as Start All. **Stop All** stays one at a time, in the stop order.
- **Stop All** — stops everything, in the stop order (the reverse of the start order unless a *Stop before* condition says otherwise).
- **A component that keeps crashing is retried, then the run asks you.** In Start / Restart All, if a
  component crashes on start (e.g. goal-backend exits because its database password expired), Healthcheck
  stops it, waits `START_RETRY_DELAY_S` seconds and tries again, up to `START_ATTEMPTS` attempts in total
  (default 3). If it still won't come up, the run **pauses** and the job panel asks what to do (if several
  components fail together, you're asked about one at a time):
  - **Free port(s) … and retry** — only when the failure is a port already in use; see *Port already in use*.
  - **Retry** — try it again (e.g. after you fixed the password); you'll be asked again if it fails again.
  - **Skip *component* and continue** — leave it stopped and carry on with the rest. Only what depends on
    it through a condition is held back (the box lists them; if nothing depends on it, nothing is).
  - **Stop the run here** — start nothing further so you can look into it; the rest is left as it was.
    **Stop the run here and Roll back take effect immediately**: components that were still coming up are
    no longer waited for (they show "Cancelled" / "Not waited for"), queued ones are dropped, and no retry
    or new start is issued. A rollback then stops what was started, including those in-flight ones.
  - **Roll back** (Start / Restart All only) — undo the run: stop **what this run has started so far**
    (plus the component that failed), in the stop order, like Stop All but only for those. Components that
    were already running before the run began are not touched. The job ends as *Rolled back*, and its message
    lists what was stopped. Hover the (i) next to the button to see exactly which components it will stop.

  If nobody answers within 30 minutes the run stops by itself, so the server is never locked forever.
  A failed component is left **stopped** (so it isn't crash-looping against the database in the
  background). The same question is asked in Stop All ("leave it running and continue"). Reloading the
  page re-attaches to a paused or running job.
- **When something fails, only its dependents are held back.** A failed Start / Restart / Stop All step
  does **not** abort the whole run. It blocks just the components that depend on the failed one through
  a condition — e.g. if Artemis doesn't start, WildFly (Artemis → WildFly) is **not started**, and so is
  anything that depends on WildFly — while everything unrelated (Nginx, the jars, …) carries on. Blocked
  components show as "not started" with the reason; the job still ends as *Failed* and its message lists
  what failed and what was held back. For **Stop All** the same applies in the other direction: if a
  component won't stop, the components that must stop after it (per the stop order) are left running.
  Only conditions count — the built-in "services before jars" preference never blocks anything.
- **Single Start / Restart / Stop check the conditions first.** Before doing anything, Healthcheck looks at
  what depends on what, on that server, and refuses with a message saying what to do first — nothing is
  started or stopped:
  - **Stop** (and **Restart**) a component while something that must stop before it is still running —
    e.g. WildFly and Artemis are both running and you click Stop on Artemis: *"Can't stop Artemis: WildFly
    (JBoss) is still running and must be stopped first. Stop WildFly (JBoss) first, or use Stop All."*
    This covers *Stop before* rules and the reverse of every *Start before* rule.
  - **Start** (and **Restart**) a component whose *Start before* prerequisite isn't running — e.g. WildFly
    while Artemis is down.
  - A component that isn't running has nothing to protect, so stopping it again (or starting one whose
    dependents are running) is simply allowed. Restart All / Stop All follow the conditions themselves.
  The message appears in a red box under the action buttons.
- **One job at a time per server.** While a job is running — or paused waiting for your answer — the Start /
  Restart / Stop / Check status buttons are greyed out, and the server refuses another one, so two runs can
  never fight over the same components.
- **Restart / Stop / Start** on a single row does the same for just that item.
  Note: systemd stops anything that `Requires=` the unit you stop (e.g. stopping a
  rules selector also stops `rule-interpreter`). After a single **Restart**,
  Healthcheck starts back up whatever was running before and got taken down that way,
  as extra steps in the same job. A single **Stop** does not — it stops what you asked
  for, plus whatever systemd takes down with it.
- **Check status** — read-only: looks at the components on the server and reports
  which are running (up) and which are stopped (down).
- **Discover software** — looks for catalog components that are installed on the server
  but not in its list yet, and adds them (running or stopped). There is no way to add a
  component that isn't installed — a server lists installed components only.
- Any software found installed later (via the periodic background check) that
  isn't in the server's list yet shows up as a dismissible suggestion on its
  page, with one-click **Add** — it's never added automatically without your
  say.

All of the above run as a tracked **job**. Its result appears in a compact panel right under the
action buttons (no scrolling): a summary bar with the outcome, what ran, how long it took and
counts (e.g. "9 ok · 5 running · 4 waiting · 1 failed"), then one line per component, updating live. A
component that is starting shows the latest lines of its log; a failed one shows its error or log excerpt
inline.

**Every button on the server page has a small (i) next to it** — hover it (or tap it) to read what the
button does. The row buttons (Start / Restart / Stop / Logs / Remove) are explained by the (i) in the
**Actions** column header; **Start #** and **Stop #** have one too.

- **Hide details / Show details** folds the panel down to just the summary bar. A run that finishes
  with nothing wrong folds itself down automatically; a failure stays open.
- **Only problems** (shown when something failed) hides the successful lines.
- **Clear** dismisses the panel. It's only the last result — the **Status** column in the table
  always shows each component's current state.
- **Check status** is a report, not an operation: it finishes as "Done" even if components are
  stopped, and lists those as "not running".

### Status and the heartbeat

Every component in a server's table has a **Status** chip:

| Status | Meaning |
|---|---|
| **Running** | systemd reports the unit `active` |
| **Stopped** | installed, not running |
| **Failed** | systemd reports `failed`, or the last start didn't become healthy |
| **Starting** / **Stopping** | systemd is in the middle of it |
| **Not installed** | the unit doesn't exist on that server (Start/Restart/Stop All simply skip it) |
| **Unreachable** | the server couldn't be reached over SSH |
| **Not checked yet** | no status recorded yet |

A background **heartbeat** re-checks every component on every server every **5 minutes** (see
`HEARTBEAT_INTERVAL_CRON`), and once shortly after the app starts. The line above the table shows the
interval and when the last check ran. Status is also refreshed immediately by **Check status**, by any
Start/Restart/Stop job (step by step while it runs), and right after a server is added or software is
discovered. The page re-reads statuses every 15 seconds, so a new beat appears on its own — no reload.
If a server is unreachable it's tried once per beat (not once per component), so a down host can't
stall the check. Status history is kept for 3 days.

### Logs

Click **Logs** on a software row to open a full-size log viewer (requires that catalog entry's
Log path to be set). It shows the last 100–2000 lines with line numbers, jumps to the newest
lines, colours errors/warnings, and has a **filter** box (matches highlighted), **Wrap**,
**Auto-refresh** (every 4 s), **Copy** and **Refresh**.

## 4. Security notes

- SSH private keys are generated locally and never leave the data directory;
  only the *public* key is ever sent anywhere (appended to the target server's
  `authorized_keys`).
- The web UI currently has **no login** (disabled per request). It grants
  remote shell execution across every configured server — do not expose this
  beyond localhost/a trusted LAN without re-enabling auth (see
  `HEALTHCHECK_PASSWORD` above).

## 5. Project layout

```
shared/   Types + zod validation schemas shared by server and web
server/   Express API, SQLite (node:sqlite), SSH connection pool, orchestrator
          defaults/defaults.json = the shipped software catalog + conditions
web/      React + Vite UI
```

See `PLAN.md` for the original architecture write-up.
