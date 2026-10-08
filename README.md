# Healthcheck

An internal ops console for the Loyalty Platform: add each Linux server that runs the
middleware/jars, connect to it over SSH, see what's running on it, and
start/restart/stop everything in the right order — gated on each step actually
becoming healthy before the next one starts. You manage **servers**: each one is checked and
controlled on its own.

> **Installing on another machine?** See [DEPLOYMENT.md](DEPLOYMENT.md) (Windows) or
> [DEPLOYMENT-UBUNTU.md](DEPLOYMENT-UBUNTU.md) (Ubuntu, including moving from Windows).

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
4. **For the full service history** (every start and stop, and who did it from a terminal): that user
   must be able to read the system journal. On Rocky / RHEL a member of `wheel` or `adm` already can;
   otherwise `sudo usermod -aG systemd-journal svc_user`. Check it as that user: `journalctl -n 1 _PID=1`
   must print a line. Without it Healthcheck still works, with a shorter history (see
   [Service history](#service-history)).

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

> **Use `npm start` for real work, not `npm run dev`.** Dev mode restarts the server every time a source
> file is saved. A restart marks any running Start / Restart / Stop All job as *Interrupted* (nothing is
> stopped, but the run and any question it was asking are gone, and you have to start it again).

### Settings: one file, `.env`

Every setting is in **one file: `.env` in the Healthcheck folder** (next to `package.json`). Healthcheck reads
it when it starts, so **restart Healthcheck after changing it**. The start-up log says which file it read.

- **You never create it by hand.** At its first start Healthcheck writes it with every setting at its default.
  Each setting has a comment saying what it does and its default, and **(recommended)** marks the defaults to
  keep unless you have a reason. `npm run settings` does the same without starting Healthcheck, and tidies the
  file after hand edits, keeping your values.
- **Upgrades:** when a newer version brings a setting the file doesn't have yet, Healthcheck adds it at its
  default. Your values stay.
- **An empty value or a deleted line means the default.**
- **It holds passwords** (`ARTEMIS_PASSWORD`), so it is in `.gitignore` and never committed. Keep it readable
  only by Healthcheck's account.
- A real environment variable with the same name wins over the file. That's only for a service manager or a
  container that sets one; normally you just edit the file.

The settings, as the file lists them:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Port the API (and, in production, the UI) listens on. |
| `HOST` | `127.0.0.1` | Interface to bind to. Change to a LAN IP if you need to reach it from another machine. |
| `HEARTBEAT_INTERVAL_CRON` | `0 */2 * * *` | Cron expression for the background status check (the "heartbeat") — every 2 hours by default, to keep SSH logins on the servers low. The "every …" text on the server page follows it in the `*/N * * * *` (minutes) and `0 */N * * *` (hours) forms. |
| `SERVICE_HISTORY_DAYS` | `30` | How many days of service history (starts, stops, errors) to keep. |
| `START_ATTEMPTS` | `3` | Start / Restart All: how many times to try a component that crashes on start before pausing to ask you. |
| `START_RETRY_DELAY_S` | `5` | Seconds to wait between those attempts. |
| `PORT_RELEASE_WAIT_S` | `30` | A start that fails because a port is already in use waits this long for the port to be released (a previous instance may still be shutting down) before it gives up and names who holds it. |
| `START_HINT_AFTER_S` | `30` | A unit that is running but hasn't printed its success line after this long gets the **Mark as started** button. |
| `START_PARALLEL` | `4` | Start / Restart All: how many components that no condition mentions are started at the same time. Each one keeps a log tail open over SSH, and Healthcheck never uses more than 8 SSH channels per server at once, which fits sshd's default `MaxSessions 10`. |
| `START_STAGGER_S` | `6` | Even within that limit, this many seconds are put between the *launch* of each parallel component, so their processes don't all hit the database (or anything else shared) in the same instant. A component that finishes early frees its slot immediately - the stagger only spaces out the start, not the whole run. |
| `WILDFLY_CLI_PATH` | `/Data/software/bin/wildfly-26.1.3.Final/bin/jboss-cli.sh` | Where `jboss-cli.sh` is on the servers, for WildFly's datasource and traffic checks (see *WildFly's database connections and traffic*). The same path is used on every server. |
| `WILDFLY_READY_TIMEOUT_S` | `60` | After WildFly starts, how long to keep checking whether it can receive traffic before counting it as a failure. |
| `ARTEMIS_USER` | `loyalty_management` | Broker login for the Artemis report after each start/restart (see *Artemis report after a start*). |
| `ARTEMIS_PASSWORD` | *(none)* | That login's password. **Put it in `.env`** (gitignored), so it never ends up in the repository. Without it the queues can't be read on a broker that checks passwords, and the report says so. |
| `ARTEMIS_URL` | `tcp://localhost:61616` | Where the broker's CLI connects, run on the server itself. |
| `ARTEMIS_INSTANCE` | `/Data/software/bin/loyalty-management-broker` | Only a fallback: the instance folder is normally read from the running broker's `-Dartemis.instance=`. |
| `ARTEMIS_CHECK_CRON` | `0 8,14,20 * * *` | When Artemis's own beat reads DLQ, ExpiryQueue and memory: every day at 08:00, 14:00 and 20:00, on the clock of the machine running Healthcheck. |
| `ARTEMIS_MEMORY_DANGER_PERCENT` | `50` | At or above this share of its heap in use (e.g. 2 GB of 4 GB), the Artemis report becomes a red danger warning. |
| `HEALTHCHECK_DATA_DIR` | `server/data` | Where the SQLite database, the generated SSH keypair, and `master.key` live. Change this if you want the data directory somewhere other than inside the repo. A relative path counts from the Healthcheck folder. |
| `SESSION_IDLE_HOURS` | `8` | A signed-in session ends after this long without use. |
| `SESSION_MAX_HOURS` | `24` | ...and after this long in any case, so everyone signs in at least once a day. |
| `LOGIN_MAX_ATTEMPTS` | `5` | Wrong passwords in a row before an account is locked. |
| `LOGIN_LOCK_MINUTES` | `15` | How long the lock lasts (an admin can unlock it sooner). |
| `TEMP_PASSWORD_HOURS` | `24` | How long a temporary password (new account, admin reset) works. |
| `PUBLIC_URL` | `http://localhost:<PORT>` | The address people open Healthcheck at. The one-time links printed by `npm run reset-password` start with it. |
| `RESET_LINK_MINUTES` | `30` | How long such a link works. |
| `COOKIE_SECURE` | `false` | Set to `true` when Healthcheck is served over HTTPS, so the sign-in cookie is only ever sent encrypted. |
| `HEALTHCHECK_DEFAULTS_FILE` | `server/defaults/defaults.json` | The catalog and conditions file loaded at every start. Leave it empty. |

**Do not delete the data directory** (`server/data` by default) — it holds every
server, catalog entry, job history, and the SSH key that's already
installed on your servers. There's no undo.

## 3. Using it

### Signing in

Everyone signs in with their own username and password. Every run records who started it, and **Recent
activity** shows "by &lt;username&gt;".

- **First time:** with no accounts yet, Healthcheck opens on **Create the first admin**. That account
  adds everyone else. It sets up its authenticator app right away (see *Forgot password* below). Add a second
  admin soon.
- **Adding people** (admins, **Users** in the sidebar): **Add user** with a name, a username and **what
  they can do** (see *Permissions* below). Healthcheck shows a **temporary password once**. Pass it on
  privately. It works for 24 hours (`TEMP_PASSWORD_HOURS`), and at the first sign-in the person must choose
  their own password before anything else.

**Permissions.** Everyone can view everything: servers, statuses, runs, alerts and Artemis readings. Each
action needs its own permission:

| Group | Permission | Allows |
|---|---|---|
| Run services | **Start All** / **Restart All** / **Stop All** | That button on a server, and on several servers at once from the overview |
| | **Start / Restart / Stop a service** | Those buttons for one service |
| Look closer | **Check status** | The **Check status** button on a server (looks at every service now; changes nothing) |
| | **Test connection and Artemis** | Test connection, and Artemis **Check now** |
| | **Read logs** | Open a service's log (logs can contain sensitive data) |
| Configure | **Manage servers** | Add a server, stop watching it, change its list of services (Find installed software, Watch it, Remove from this list) |
| | **Edit the software catalog** / **Edit conditions** | Change those pages (without it they're view-only) |
| Administer | **Manage users** | The Users page. Having it makes someone an **admin**. |

Three presets fill the boxes in one click, and any box can be changed afterwards ("Custom"):
- **Viewer:** nothing, so view only. For managers.
- **Operator:** everything under *Run services* and *Look closer*.
- **Admin:** everything.

Change someone's name or permissions with **Edit** next to their name. It takes effect on their next click,
with no need to sign in again.

Enforcement:
- **The server checks every action** against one rule table. A change that isn't listed there is refused
  by default.
- **In the page,** actions you can't use are greyed out, saying "You don't have permission for this. Ask an
  admin."
- **Run questions** (Try again / Roll back …) can only be answered by someone allowed to start that kind of
  run.
- **Nobody can take Manage users away from themselves**, and Healthcheck always keeps at least one active
  admin.

**Change password:** at the bottom of the sidebar. It asks for the current password. Your other signed-in
browsers are signed out.

**Forgot password.** No email server is needed: everything works on a market's own network.
- **Everyone: ask an admin.** The admin clicks **Reset password** next to your name. That gives a new
  temporary password, unlocks the account, and signs you out everywhere. You choose a new password at
  sign-in.
- **An admin: with their authenticator app.** On the sign-in page: **Forgot your password?** → **Reset with my
  authenticator app**. Enter your username, the 6-digit code the app shows for Healthcheck, and a new
  password, and you're signed in.
  - **Setting it up:** every admin must, at their first sign-in as an admin, before anything else. Scan a QR
    code with Microsoft Authenticator or Google Authenticator and type one code to confirm. The app is only
    used for Forgot password, never at normal sign-in.
  - **Offline:** the phone and Healthcheck each compute the codes from a shared secret and the time, so
    neither needs internet. Only installing the app on the phone does.
  - **The clocks must agree:** Healthcheck accepts codes up to about 30 seconds off. If the phone and the
    server are further apart, it says so instead of just refusing. The setup screen shows the server's time
    to compare with the phone.
  - **Safe against someone who knows the username:** without the phone's current code nothing happens. The
    answer is the same for a wrong code, an unknown username or a non-admin, and each code works once.
    Wrong codes count toward the same lockout as wrong passwords (5 tries, then 15 minutes).
  - **New phone:** **Authenticator app** at the bottom of the sidebar. Scan the new code; it asks for your
    password, and the old phone stops working.
  - **Lost phone:** another admin clicks **Remove authenticator** next to your name on the Users page. You
    set it up again at your next sign-in.
  - **Storage:** the app's secret is stored encrypted with `master.key`.
- **An admin with neither their password nor their phone:** another admin resets the password from the Users
  page. If there's no other admin, someone with access to the machine Healthcheck runs on runs this in the
  Healthcheck folder:
  ```bash
  npm run reset-password -- <username>
  ```
  It prints a **one-time link**. Open it in a browser, choose a new password, and you're signed in.
  - **Lifetime:** the link works once, for 30 minutes (`RESET_LINK_MINUTES`). Running the command again
    cancels the earlier link.
  - **Address:** the link starts with `PUBLIC_URL`. Set it to the address people use for Healthcheck.
  - **What else it does:** it unlocks and enables the account. If no other active admin exists, it also
    gives that account every permission. Once used, every other session of that account is signed out.
  - **Why the machine:** anyone who can run commands there already controls Healthcheck's data. So the
    machine is the proof of identity when there's no email. Keycloak (`kc.sh bootstrap-admin`) and Grafana
    (`grafana cli admin reset-admin-password`) recover their admins the same way.
  - **Built code:** it runs the built code, like `npm start`, so run `npm run build` first after an update.
  - **Storage:** only a hash of each link is kept.
- **Users page, also:** **Unlock** a locked account, **Edit** (name and permissions), **Disable** /
  **Enable**, and **Recent sign-in activity**.
  - **Disable:** disabled people are signed out and can't sign in. Nobody can disable themselves.
  - **Recent sign-in activity:** sign-ins, wrong passwords, lockouts, changes and resets, with who and from
    where.

**Password rules:**
- **At least 12 characters.** Any characters work, spaces included; symbols aren't required. A few
  unrelated words make a good one.
- **Refused:** common passwords ("password123", "qwerty…"), the username or your name, the product's own
  words ("vodafone…", "healthcheck…"), repeats and simple sequences.
- **No forced periodic changes.** You change it when you want or when it may be known.

These rules follow NIST SP 800-63B. The form shows the rules as you type; the server checks them again.

How it's protected:
- **Storage:** passwords are stored only as **scrypt** hashes with a unique salt each. They're never stored
  in plain text, never logged, and never sent back.
- **Session cookie:** the session is a random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie, so
  page scripts can't read it and other sites can't use it. The database keeps only a SHA-256 of the token.
- **New token on every sign-in**, and sign-out deletes the session on the server.
- **Session end:** after 8 hours idle or 24 hours in total.
- **Lockout:** **5 wrong passwords lock the account for 15 minutes.**
- **No username guessing:** an unknown username gets the same message, takes the same time, and locks the
  same way, so the replies never reveal which usernames exist.
- **Per computer:** one address gets at most 30 failures per 15 minutes.
- **CSRF:** every change must carry a header that another website can't add, so a malicious page can't act
  in your name.
- **Temporary passwords** are 16 random characters, expire, and must be replaced at first use.

### Servers

The landing page (**Fleet overview**) has three panels on top — a welcome card with **Add server**, a
**Fleet health** donut (the share of components running across all servers, with Running / Stopped /
Problems counts) and **Recent activity** (the latest jobs; click one to open its server) — and below them
your **servers**, each with its connection status, how many components are running, and a chip per
installed component. The white bar at the top of every page finds a server by name (type, then Enter) and
shows how many components are running overall; the sidebar's **Add server** button works from any page.
Open a server to control it: everything on its page —
Start All / Restart All / Stop All, the per-component buttons, statuses, logs — applies to that one
server only.

**Several servers at once.** Each server card on the overview has a tick box, and the bar above the cards has
**Select all** and **Start All / Restart All / Stop All** for the ticked servers. Each ticked server gets its
own run, exactly the one its own page's button would start: only the catalog services installed on that
server, in its own order and with the same checks (WildFly's datasource and traffic checks included). The
servers run side by side, and there's no order *between* servers. Restart All and Stop All ask for
confirmation first, naming the servers. Each run gets its own progress panel on the overview, titled with
its server. If several runs need an answer at the same time, their questions pop up **one at a time**, and
the others wait in their panel ("this one pops up as soon as that one is answered"). A server that already
has a run going is refused with the usual "A job is already running on this server" message, which is listed by server name,
and the other servers still go ahead. Leaving the page and coming back shows the runs still going.

The server page is written so that someone who isn't technical can read it:

- **A status box at the top:**
  - **One sentence** says what's wrong, naming the services: "You have issues with Artemis, Keycloak, WildFly
    (JBoss) and 6 more." With no problems it says "Everything is working", or "2 of 20 services are stopped".
    When it was last checked is on the right.
  - **Three count tiles**, always in the same order: **With a problem** (red), **Running** (green) and
    **Stopped** (grey). A tile at zero turns pale. A fourth, **Starting or stopping**, appears only while
    something is.
- **Right under it:** **Start All / Restart All / Stop All**, then **Check status**, set a little apart because
  it changes nothing.
- **Next to the server's name:** **Test connection** and **Stop watching this server**.
- **Below, services are grouped by what's wrong**, problems first, each group with a plain heading and one
  sentence on what to do: *Can't reach the database*, *Can't receive traffic*, *Database password expired*, *Stopped with an error*,
  *Couldn't be checked*, *Stopped*, *In progress*, then *Working normally* and *Not checked yet*.
- **Each service row** has **Start**, **Restart** and **Stop**.
  - **Red outline:** marks the obvious next step: Start when it's down, Restart when it runs but doesn't work
    (database or traffic problem).
  - **Greyed out:** Start when it's already running, Stop when it isn't.
  - **Confirmation:** Restart and Stop ask first.
  - **The ⋯ menu:** **Show its history**, **Show its log** and **Remove from this list**.
- **Show technical details** (bottom of the page) adds the SSH user/host/port, each service's start and stop
  step, and its raw state. The switch is remembered in that browser.
- **Find installed software** is at the bottom too.
- **Stop watching this server** (next to the name) makes Healthcheck stop managing the server; nothing on
  the machine itself is changed or stopped.

Colours: the UI is red, white and gray, plus one status colour. **Working** is green (a green check
mark), **has a problem** is red (a red "!"), **stopped** is gray (a gray square: nothing is broken, it just
isn't running, so it isn't listed under *Needs attention* and the headline doesn't count it as a problem).
Otherwise red is only used for action buttons.

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
  popup: process, pid, user, how long it has been up, whether it belongs to a systemd service or
  was started by hand from a terminal, and its command line (passwords and tokens in it are masked).
  When the holder can be dealt with, the popup gets a **Free port(s) … and retry** button: it stops
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
  come up healthy. Either way, once it is treated as a genuine expired-credential failure, the popup
  offers only **Continue without it** and **Roll back** (stops everything the run has started so
  far) — Retry and Stop the run are hidden, since neither helps here. Continue skips it and carries on
  with the rest (holding back only what depends on it through a condition). **One shared password behind
  several components** (a common Oracle account, for example) usually expires for all of them at once —
  each one still gets its own question, since Continuing past one doesn't tell you whether you'd want the
  same answer for the next; Roll back on any of them stops the whole run, including ones already
  answered. The unit is also stopped outright as soon as this is confirmed, before the operator even
  answers — otherwise `Restart=` just keeps bouncing it against the database, hitting it with the same
  bad password every few seconds, for as long as the run's SSH connection stays open.

  Its status reads **"Failed (due to expired password)"**, and stays that way — a scheduled
  heartbeat re-check on a component parked in this state does not overwrite it with a plain "Stopped" (it
  genuinely is stopped, that reading isn't wrong, just less useful than the reason already known); it only
  updates once the component comes back up for real, or a fresh Start/Restart records its own new outcome.
  The check that decides this looks at the last 300 log lines, not 40 — a Hibernate/Spring stack trace
  routinely runs past 40 lines once its "Caused by" chain is included, and a smaller window could evict
  the one line that says why before this ever got a chance to look at it (which is why the same expired
  password could show up correctly for one component and as a bare "Failed" for another, in the same run).

#### WildFly's database connections and traffic

WildFly can be "running" to systemd, and even log its own "started" line, while the connection pools to
its databases don't work (an expired database password, a locked account, a database that's down), or
while it isn't accepting requests. So for WildFly (any catalog entry whose name or unit mentions
WildFly/JBoss) Healthcheck runs two more checks in order, over the same SSH connection:
**first its database connections, then — only if those are all fine — whether it can receive traffic.**

**Database connections.** Healthcheck tests every datasource WildFly has:

1. It asks WildFly which datasources it has, so nothing has to be configured per market:
   `/subsystem=datasources:read-children-names(child-type=data-source)` (and `xa-data-source`).
   The loyalty, sales and usage servers each get their own datasources tested.
2. It runs `test-connection-in-pool` on each one, which borrows a real connection right now.

Each `jboss-cli.sh` start is a small Java program (about 2 CPU-seconds and 130–160 MB for a second), so
the whole check uses **two** of them, however many datasources there are. The first call lists the
datasources and reads WildFly's listening addresses for the traffic check. The second tests them all.
The commands are fed to `jboss-cli.sh` as a script on stdin. Unlike `--commands=a,b` or a CLI `for`
loop, which both stop at the first failing command, this way a failing datasource doesn't stop the rest,
and every test prints the same reply it would on its own. If a reply ever comes back missing or cut off,
that datasource is re-tested by itself. Tested against WildFly 26.1.3: the same datasources, the same
failures and the same error text as one call per datasource.

`jboss-cli.sh` is found at `WILDFLY_CLI_PATH`; it runs locally on the server, so no WildFly management
user is needed. If the listing itself can't run, the check is skipped and the step says why. It never
blocks a start because the check tool was unavailable.

**Receiving traffic.** Nothing about a market's hostname or domain is configured or hard-coded: Healthcheck
asks WildFly which address and port each of its listeners is actually bound to
(`/socket-binding-group=*/socket-binding=*:read-resource(include-runtime=true)`), and sends the requests
with `curl` on the server itself:

1. **Ready?** `GET http://<management-http address>/health/ready` (WildFly's own readiness check).
   HTTP 200 means ready. HTTP 503 means WildFly says it isn't ready. The reply is read in both shapes
   (WildFly's own health subsystem and MicroProfile Health), so the reason names the application that
   failed to deploy, the parts of it that didn't come up, and the root cause (shown under technical
   details). If that URL needs a login, isn't enabled (401/403/404) or doesn't answer,
   it's noted and only step 2 decides.
2. **Answers requests?** `GET` on the web listener (the `http` binding, else `https`). Any HTTP answer,
   even a 404, proves it accepts and serves requests; no answer at all means it can't take traffic.

After a start, readiness can lag the "started" log line by a few seconds while deployments finish, so this
is retried every 5 s for up to `WILDFLY_READY_TIMEOUT_S` (60 s) before it counts as a failure. If the
addresses can't be read, or `curl` isn't on the server, the check is skipped and the step says so.

When these run, and what happens if **even one** datasource fails or WildFly can't take traffic:

| When | What happens |
|---|---|
| **Start / Restart** of WildFly, after its log says it started | WildFly is **stopped immediately** and the step fails. |
| **Start All** or **Start** while WildFly is **already running** | Checked anyway (systemd "running" isn't enough); same as above. |
| **Check status** and the 2-hourly **heartbeat** | WildFly is **flagged, not stopped** (stopping a production server in the background, perhaps over a short database blip, is left to a person). Here both checks always run, so the traffic check still runs when a datasource has already failed. When the heartbeat finds a problem, a red **"WildFly has issues, please check"** warning pops up on whatever page of the tool is open (see below). |

When all is well, the step's log says so, e.g. "All 13 datasources passed a connection test. Ready to
receive traffic: WildFly says it's ready (/health/ready on 10.0.0.5:9990); it answers web requests on
10.0.0.5:8080."

If it **can't take traffic**, the popup reads **Can't receive traffic** with the reason, its status becomes
**Failed (can't receive traffic)**, and it's listed under that heading on the server page with a
**Restart** button.

If a **datasource** fails:

in a Start / Restart All run the popup reads **Database connection problem**, names the failing
datasources, gives the likely cause in plain words, and keeps the raw `WFLYJCA…`/`ORA-…` text under
**Show technical details**. If the failure text is an expired password, Retry is hidden, as for any
other expired password. WildFly's status becomes **Failed (database connection)**, and its row on the
server page lists the failing datasources (the **×** hides that list; it comes back if a different set
starts failing).

### Artemis: queues and memory

Healthcheck reads Artemis's **DLQ**, **ExpiryQueue** and **memory** at three moments:

| When | What you see |
|---|---|
| **Artemis's own beat**, every day at 08:00, 14:00 and 20:00 (`ARTEMIS_CHECK_CRON`), on every server that has Artemis | The line under Artemis on the server page updates. If memory is at **50% or more**, a red **"Artemis has issues, please check"** popup appears on any page, the same warning WildFly's heartbeat uses. It comes back at the next beat while the problem lasts. |
| **After Healthcheck starts or restarts it** (see below) | The report popup on the run, and the line updates. |
| **Check now**, on the line itself | The line updates (about 2 seconds). |

**The line under Artemis** on the server page shows the last reading:
`DLQ 32 · ExpiryQueue 0 · Memory 71 MB of 4 GB (1.7%) · today 14:00 (scheduled check) · Check now`.
- It turns red, starting with **Memory too high**, at or above the threshold.
- If Artemis wasn't running at that moment, the line says so, and nothing is raised. A stopped Artemis is
  already shown by its status.

The beat only reads, and never starts or stops anything. If Healthcheck itself was down at a scheduled time,
it catches up once on start, but only when the last scheduled reading is over 8 hours old, so restarting the
app doesn't re-read every broker. Readings are kept for 30 days.

#### Artemis report after a start

Each time Healthcheck **starts or restarts Artemis**, whether on its own or as part of Start All or
Restart All, and its log says it's live, a popup reports on it. A broker that was already running and left
untouched gets no popup. The report shows:

| | Where it comes from |
|---|---|
| **DLQ** and **ExpiryQueue**: messages in each | `artemis queue stat` (the broker's own CLI, run from its instance folder) |
| **Memory**: heap in use **out of** the heap Artemis is given | `jcmd <pid> GC.heap_info`, and `-Xmx` from its command line |
| Warnings and errors logged **since this start** | the catalog's log path, matched on Artemis's `AMQ222…` (warning) and `AMQ224…` (error) codes, which works whatever the log layout (plain text or JSON) |

- **Gray, "Artemis started":** the normal report.
- **Red, "Artemis is using too much memory":** heap in use is **50% or more** of what it's given
  (`ARTEMIS_MEMORY_DANGER_PERCENT`). For example, 2 GB used of 4 GB.
- **"Take a look":** something couldn't be read (the note says what, e.g. "the broker did not answer within
  60 s"), or errors were logged since the start.

The report never fails or pauses the run, because the start itself already succeeded. Its one-line summary
is also kept in the step's log ("Artemis report: DLQ 32 messages, ExpiryQueue 0. Memory 71 MB of 4 GB
(1.7%)."). The popup waits while a run's question is on screen. On the overview, with several runs going,
popups come one at a time. Once closed with **OK**, it doesn't show again in that browser.

Everything is gathered by one SSH command on the server, in about 2 seconds. The `artemis` CLI is a Java
program, about 2 CPU-seconds, and is limited to 60 s, because when it can't reach the broker it otherwise
retries forever. The broker process is found through its systemd unit's main PID (or, failing that, the
process running `...boot.Artemis run`). Its instance folder is read from that process, so nothing is set per
market.

### Start & stop order — Conditions

Each server has a **start order** and a **stop order**. Neither is edited by hand: both are worked out
from the rules on the **Conditions** page (sidebar → Configure → Conditions), and every server updates
as soon as a rule changes. Turn on **Show technical details** on a server page to see each service's
start step (the order Start / Restart All go in) and stop step (the order Stop All goes in).

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
  (default 3). If it still won't come up, the run **pauses** and a **popup** asks what to do (if several
  components fail together, you're asked about one at a time). The popup has a big icon and a plain title
  (*Database connection problem*, *Password expired*, *Port already in use*, *… didn't start*), one sentence
  on what happened, the technical text under **Show technical details**, and these buttons:
  - **Free port(s) … and retry** — only when the failure is a port already in use; see *Port already in use*.
  - **Try again** — try it again (e.g. after you fixed the password); you'll be asked again if it fails again.
  - **Continue without *component*** — leave it stopped and carry on with the rest. Only what depends on
    it through a condition is held back (the popup lists them; if nothing depends on it, nothing is).
  - **Stop the run** — start nothing further so you can look into it; the rest is left as it was.
    **Stop the run and Roll back take effect immediately**: components that were still coming up are
    no longer waited for (they show "Cancelled" / "Not waited for"), queued ones are dropped, and no retry
    or new start is issued. A rollback then stops what was started, including those in-flight ones.
  - **Roll back** (Start / Restart All only) — undo the run: stop **what this run has started so far**
    (plus the component that failed), in the stop order, like Stop All but only for those. Components that
    were already running before the run began are not touched. The job ends as *Rolled back*, and its message
    lists what was stopped. Hover the (i) next to the button to see exactly which components it will stop.

  **Look at the run first** tucks the popup away so you can read the job's steps and logs; an **Open the
  decision** button in the job panel brings it back, and a new question always pops up again.
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
  The message appears in a red box under Start All / Restart All / Stop All.
- **One job at a time per server.** While a job is running — or paused waiting for your answer — the Start /
  Restart / Stop buttons and **Check status** are disabled, and the server refuses another one, so two runs can
  never fight over the same components.
- **Start / Restart / Stop** on a single row does the same for just that item.
  Note: systemd stops anything that `Requires=` the unit you stop (e.g. stopping a
  rules selector also stops `rule-interpreter`). After a single **Restart**,
  Healthcheck starts back up whatever was running before and got taken down that way,
  as extra steps in the same job. A single **Stop** does not — it stops what you asked
  for, plus whatever systemd takes down with it.
- **Check status** (after Stop All) — read-only: looks at every component on the server and reports
  which are running and which are not. Changes nothing.
- **Find installed software** — looks for catalog components that are installed on the server
  but not in its list yet, and adds them (running or stopped). There is no way to add a
  component that isn't installed — a server lists installed components only.
- Any software found installed later (via the periodic background check) that
  isn't in the server's list yet shows up under **Found on this server but not watched yet**, with
  **Watch it** and **Ignore** — it's never added automatically without your say.

All of the above run as a tracked **job**. Its result appears in a compact panel right under
Start All / Restart All / Stop All (no scrolling): a summary bar with the outcome, what ran, how long it took and
counts (e.g. "9 ok · 5 running · 4 waiting · 1 failed"), then one line per component, updating live. A
component that is starting shows the latest lines of its log; a failed one shows its error or log excerpt
inline.

**The main buttons on the server page have a small (i) next to them** — hover it (or tap it) to read what
the button does.

- **Hide details / Show details** folds the panel down to just the summary bar. A run that finishes
  with nothing wrong folds itself down automatically; a failure stays open.
- **Only problems** (shown when something failed) hides the successful lines.
- **Clear** dismisses the panel. It's only the last result — the grouped list below always shows each
  component's current state.
- **Check status** is a report, not an operation: it finishes as "Done" even if components are
  stopped, and lists those as "not running" (or "database problem" for WildFly's datasources).

### Status and the heartbeat

Every component has a state. The server page shows it in plain words, as the group the component is
listed under; the dashboard's chips use the shorter status names:

| Server page | Status (dashboard) | Meaning |
|---|---|---|
| **Working normally** | **Running** | systemd reports the unit `active` (and, for WildFly, every datasource connects) |
| **Can't reach the database** | **Failed (database connection)** | WildFly is running, but one or more of its datasources fail `test-connection-in-pool` |
| **Can't receive traffic** | **Failed (can't receive traffic)** | WildFly is running and its datasources connect, but it says it isn't ready, or its web listener doesn't answer |
| **Database password expired** | **Failed (due to expired password)** | it stopped because its database password expired |
| **Stopped with an error** | **Failed** | systemd reports `failed`, or the last start didn't become healthy |
| **Stopped** | **Stopped** | installed, not running |
| **In progress** | **Starting** / **Stopping** | systemd is in the middle of it |
| **Not installed here** | **Not installed** | the unit doesn't exist on that server (Start/Restart/Stop All simply skip it) |
| **Couldn't be checked** | **Unreachable** | the server couldn't be reached over SSH |
| **Not checked yet** | **Not checked yet** | no status recorded yet |

A background **heartbeat** re-checks every component on every server every **2 hours** (see
`HEARTBEAT_INTERVAL_CRON`), and once shortly after the app starts. The line above the table shows the
interval and when the last check ran. Status is also refreshed immediately by **Check status**, by any
Start/Restart/Stop job (step by step while it runs), and right after a server is added or software is
discovered. The page re-reads statuses every 15 seconds, so a new beat appears on its own — no reload.
If a server is unreachable it's tried once per beat (not once per component), so a down host can't
stall the check. The status readings themselves are kept for 3 days; the **service history** (below) for 30 days (`SERVICE_HISTORY_DAYS`). For a running WildFly each beat also runs the
datasource and traffic checks (see *WildFly's database connections and traffic*), which add two `jboss-cli.sh` calls and two `curl` requests; a failure is
flagged, never acted on. A component parked as *Failed (due to expired password)*, *Failed (can't receive traffic)* or *Failed (database
connection)* keeps that status while it stays down, instead of turning into a bare "Stopped" at the next beat.

**The heartbeat's warning.** When a beat finds a running WildFly that can't receive traffic, or whose
datasources can't connect, a red **"WildFly has issues, please check"** popup appears on top of any page of
the tool. It names the server, says what's wrong in plain words (failing databases as chips), and offers
**Open <server>** or **Dismiss**. Nothing is stopped or restarted. A dismissed warning comes back at the next
beat if the problem is still there. The page asks `GET /api/alerts` every 30 seconds for what the latest beat
found. Problems found by a Start/Restart run don't use this popup, because the run already asks you in its own.
The warning only shows while the tool is open in a browser; it doesn't send email or chat messages.

**What a beat costs a server.** Nothing is installed on the servers, and nothing stays running between
beats. A beat runs short commands over one reused SSH connection. These figures were measured on an
8-core, 16 GB loyalty server:

| Part of the beat | How often | CPU | Memory (for its few seconds) |
|---|---|---|---|
| `systemctl show`, one per application (~20) | every beat | ~0.15 CPU-s in total | ~10 MB |
| WildFly: two `jboss-cli.sh` calls (list + addresses, then all datasource tests) | only while WildFly runs | ~2–3 CPU-s each, ~5 CPU-s in total | ~130–200 MB, one call at a time |
| WildFly: two `curl` requests (`/health/ready`, web port) | only while WildFly runs | ~0.02 CPU-s | ~10 MB |

A beat costs about 5–6 CPU-seconds when WildFly is running, mostly within a few seconds, and under 1
CPU-second when it isn't. Spread over 2 hours that's about 0.01% of an 8-core server. Each
datasource test also makes one small connection check against its database.

### Service history

A service's **⋯** menu → **Show its history** lists everything that happened to it in the last 30 days
(`SERVICE_HISTORY_DAYS`), newest first, grouped by day: **Started**, **Stopped**, **Restarted**, **Stopped with
an error**, **Failed to start**, **Kept crashing**, and settings changes (**Set to start with the server** / **not
to**, **Blocked from starting**). Each entry says who did it:

| The line says | Meaning |
|---|---|
| **In Healthcheck, by temp (Stop All)** | One of Healthcheck's runs did it, started by that person |
| **By sam in a terminal (pts/0)** + the command, e.g. `sudo systemctl start artemis.service` | A person ran it on the server with sudo (or typed their password for polkit). The name is their account on the server |
| **Outside Healthcheck, and not through sudo** | Someone with a root shell, a script or a scheduled job; the person isn't recorded. Root shells open at that moment are listed (e.g. "sam (sudo su -, pts/1, since 12:40)") as the likely candidates |
| **systemd restarted it automatically** / **Kept crashing** | It ended on its own and systemd's `Restart=` brought it back. Repeated crashes are one entry with how many times and until when, e.g. "5,245 times, until today 11:45. Each time: exit code 1" |
| **Nobody asked systemd to stop it** | It crashed or ended by itself (with the exit code, a signal, or "the server ran out of memory and killed it"). A `sudo kill` just before shows as "Probably by sam" |
| **When the server started up** / **The server restarted** | Started at boot / went down with a reboot |

**How it works:**
- **Where it comes from:** the server's journal. systemd logs every start, stop and crash of each service, and
  sudo logs every command with the person and their terminal. Healthcheck reads only systemd's lines about the
  watched services and the sudo / su / polkit / root-login lines, in the same SSH command as the status check:
  at every heartbeat (every 2 hours), at every **Check status**, and right after each Start / Restart / Stop
  run. Each read picks up where the last one stopped, so nothing in between is missed, and a Healthcheck run
  counts only for the services it actually started or stopped (a Check status never takes the credit).
- **Who may read the journal:** the account Healthcheck signs in with must be able to read the system journal.
  On Rocky / RHEL, members of `wheel` or `adm` can (as on loyalty_1); elsewhere add it to `systemd-journal`:
  `sudo usermod -aG systemd-journal <user>`. Without that, Healthcheck falls back to systemd's timestamps
  (`systemctl show`): when each service last started and stopped and how it ended. Then several stops and
  starts between two reads show as the latest ones, who did it in a terminal isn't known, and the history
  window says so.
- **Exact times:** times come from the journal, not from when Healthcheck happened to look. They're moved
  onto Healthcheck's clock if the server's clock differs.
- **What counts as an error:** a non-zero exit code or a signal is shown as an error. Two exceptions:
  - **Java's exit code 143 / 130** is how WildFly, Artemis and the Spring Boot services exit when asked to
    stop, so it counts as a normal stop.
  - **An odd exit code during a requested stop** is shown as a normal stop, with "it ended with exit code N".
- **Server restarts:** spotted from the server's boot id, so correcting the clock doesn't look like a restart.
- **Journals that don't survive a restart:** some servers (loyalty_1 among them) keep the journal only in
  memory, so what happened between the last read and a restart is lost; the history window says so. To keep
  it across restarts: `sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald`.

### Logs

Open a service's **⋯** menu and choose **Show its log** for a full-size log viewer (requires that catalog entry's
Log path to be set). It shows the last 100–2000 lines with line numbers, jumps to the newest
lines, colours errors/warnings, and has a **filter** box (matches highlighted), **Wrap**,
**Auto-refresh** (every 4 s), **Copy** and **Refresh**.

## 4. Security notes

- SSH private keys are generated locally and never leave the data directory;
  only the *public* key is ever sent anywhere (appended to the target server's
  `authorized_keys`).
- Everyone signs in (see *Signing in*). The tool still grants remote control
  of every configured server, so keep it on localhost or a trusted LAN. If you
  expose it more widely, serve it over **HTTPS** and set `COOKIE_SECURE=true`:
  over plain HTTP, passwords and the session cookie cross the network
  unencrypted.

## 5. Project layout

```
shared/   Types + zod validation schemas shared by server and web
server/   Express API, SQLite (node:sqlite), SSH connection pool, orchestrator
          defaults/defaults.json = the shipped software catalog + conditions
web/      React + Vite UI
```

See `PLAN.md` for the original architecture write-up.
