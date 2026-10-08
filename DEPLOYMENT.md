# Deploying Healthcheck on another machine

This guide installs Healthcheck on a **Windows machine** (the "Healthcheck host") that can reach your
**Linux servers** over SSH. It takes about 15 minutes. For what the tool does and how to use it, see
[README.md](README.md).

> **Installing on Ubuntu, or moving a Windows installation to Ubuntu?** See
> [DEPLOYMENT-UBUNTU.md](DEPLOYMENT-UBUNTU.md).

```
  Healthcheck host (Windows)                     Linux servers (one or many)
  ┌──────────────────────────┐   SSH (port 22   ┌───────────────────────────┐
  │ Node.js + Healthcheck    │ ───────────────► │ systemd units + a service │
  │ browser → :4000          │  or your port)   │ account with sudo systemctl│
  └──────────────────────────┘                  └───────────────────────────┘
```

Healthcheck installs nothing on the Linux servers. It logs in as a service account and runs
`systemctl` — that's all.

---

## 1. Before you start — checklist

**On the Healthcheck host (Windows)**

- [ ] **Node.js 22.13 or newer** (the current LTS is fine). Check with `node -v`; download from
      <https://nodejs.org>.
- [ ] Network access from this machine to every Linux server on its SSH port.
- [ ] A free port for the web page (default `4000`).
- [ ] Either `git` + internet/npm access (route A below), or the release zip (route B).

**On every Linux server** (the full explanation is in README section 1)

- [ ] Every component runs as a **systemd service**.
- [ ] A **service account** exists, and you know its password (used once, never stored).
- [ ] That account may run `systemctl` through sudo **without a password** — in
      `/etc/sudoers.d/healthcheck` (edit with `visudo -f`):
      ```
      svc_user ALL=(root) NOPASSWD: /usr/bin/systemctl
      ```
      Check it while logged in as that user; this must **not** ask for a password:
      ```
      sudo -n systemctl status sshd
      ```
      (Use the path `which systemctl` prints. If sudo says "you must have a tty", also add
      `Defaults:svc_user !requiretty`.)
- [ ] For the full service history (who stopped what from a terminal), that account can read the system
      journal: `journalctl -n 1 _PID=1` prints a line. On Rocky / RHEL `wheel` or `adm` members can;
      otherwise `sudo usermod -aG systemd-journal svc_user`. Optional: Healthcheck works without it, with a
      shorter history.

---

## 2. Get the application onto the machine

Pick **one** route. Both were tested from a clean folder.

### Route A — from the git repository (needs internet or an npm mirror)

Customers install from the **`release-1`** branch, the repository's default branch: the tested release,
with the shipped catalog and conditions, the current UI, and none of your own servers:

```powershell
git clone --branch release-1 https://github.com/Sam-Assad/Management-Tool.git C:\Healthcheck
cd C:\Healthcheck
npm ci
npm run build
```

(`--branch release-1` is optional, since it is the default branch, but it keeps the command correct even if
the default ever changes.)

### Route B — from a release zip (no git; only the runtime packages are downloaded)

**Build the zip once, on the development machine:**

```powershell
cd C:\Users\sam\Desktop\Healthcheck
npm run build

$out = "$env:TEMP\healthcheck-release"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $out, "$out\shared", "$out\server", "$out\web" | Out-Null
Copy-Item package.json, package-lock.json, tsconfig.base.json, README.md, DEPLOYMENT.md $out
Copy-Item shared\package.json "$out\shared\";  Copy-Item shared\dist "$out\shared\dist" -Recurse
Copy-Item server\package.json "$out\server\";  Copy-Item server\dist "$out\server\dist" -Recurse
Copy-Item server\defaults "$out\server\defaults" -Recurse      # the shipped catalog + conditions
Copy-Item web\package.json    "$out\web\";     Copy-Item web\dist    "$out\web\dist"    -Recurse
Compress-Archive "$out\*" healthcheck-release-1.zip -Force
```

The zip is under 1 MB. It **must** contain `server\defaults` (your catalog and conditions). **Never** add `server\data`, `.env` or `Services\` to it — they hold your keys,
your servers and passwords.

**On the Healthcheck host:**

```powershell
Expand-Archive healthcheck-release-1.zip C:\Healthcheck
cd C:\Healthcheck
npm ci --omit=dev
```

`npm ci --omit=dev` downloads about 28 MB of runtime packages. If the host has no internet access, run
that command on a staging Windows machine with the same Node version, copy the whole folder across, and
check it starts (step 4).

> You will see `npm warn allow-scripts …` lines about `esbuild` / `ssh2`. They are harmless: the build
> still works, and SSH uses its built-in JavaScript crypto.

---

## 3. Configure

All settings are in **one file, `C:\Healthcheck\.env`**. Healthcheck writes it itself, with every setting at
its default and a comment on each. Have it written now, then open it:

```powershell
npm run settings
notepad .env
```

Each setting says what it does and its default. **(recommended)** means keep the default. The ones to set
for a new install:

```ini
PORT=4000
HOST=127.0.0.1
HEALTHCHECK_DATA_DIR=D:\HealthcheckData
ARTEMIS_PASSWORD=<the broker password>
```

| Setting | What to put |
|---|---|
| `PORT` | The port for the web page. |
| `HOST` | `127.0.0.1` = only this machine can open the page (recommended). See **Security** below before changing it. |
| `HEALTHCHECK_DATA_DIR` | A folder **outside** the application folder, so upgrades never touch it. It is created on first start. If you leave it out, the data goes to `server\data` inside the application folder (it is excluded from git, but a re-install of the folder would delete it). |
| `ARTEMIS_PASSWORD` | The Artemis broker password, for the report after each start. |

Leave the other settings (retry counts, parallel starts, heartbeat interval …) at their defaults unless you
have a reason. The file is never committed (it holds the password). When an upgrade brings a new setting,
Healthcheck adds it to the file at its default and keeps your values.

---

## 4. Start it and check

```powershell
cd C:\Healthcheck
npm start
```

You should see:

```
Settings: C:\Healthcheck\.env
Healthcheck server listening on http://127.0.0.1:4000
```

Open **http://localhost:4000** in a browser on that machine. You should see the *Your servers* page
with no servers. Stop it with `Ctrl+C` once you have seen that — the next step makes it permanent.

---

## 5. Keep it running (Windows service)

Use [NSSM](https://nssm.cc) (a small free service wrapper). Run PowerShell **as Administrator**:

```powershell
nssm install Healthcheck "C:\Program Files\nodejs\node.exe" "server\dist\index.js"
nssm set Healthcheck AppDirectory C:\Healthcheck
nssm set Healthcheck Start SERVICE_AUTO_START
nssm set Healthcheck AppStdout C:\Healthcheck\healthcheck.log
nssm set Healthcheck AppStderr C:\Healthcheck\healthcheck.log
nssm start Healthcheck
```

The service reads the same `.env`. Restart the service after changing it:
`nssm restart Healthcheck`. (No NSSM? A Task Scheduler task "At startup" running
`node server\dist\index.js` in `C:\Healthcheck` does the same job.)

---

## 6. Add your first server

1. Open the page → **+ Add server**.
2. Enter a name, the host/IP, the SSH port, the service account's user name and its **password**.
3. Healthcheck creates its own SSH key, installs it on that server using the password, and never keeps
   the password. It then finds which of the catalog's components are installed there and lists them.
4. Open the server and click **Check status**. Everything installed should appear with its state.
5. Before trusting a **Start All** in production, try a single **Start / Stop** on a non-critical
   component first.

The **software catalog and the conditions arrive with the application** (`server\defaults\defaults.json`):
a new install already has every component, log path, success pattern and start/stop rule you set up, so
there is nothing to enter by hand. A market whose paths or names differ can edit them in **Software
Catalog** / **Conditions**; those local edits are kept when you upgrade.

---

## 7. Security

- **Everyone signs in** with a named account and only gets the permissions an admin gave them (README,
  *Signing in*). The tool can still start and stop production software, so by default it only listens
  on `127.0.0.1`. To let other PCs open it, set `HOST=0.0.0.0` **and** limit who can reach the port:
  ```powershell
  New-NetFirewallRule -DisplayName "Healthcheck" -Direction Inbound -Protocol TCP -LocalPort 4000 `
    -Action Allow -RemoteAddress 10.20.30.0/24
  ```
- The data folder contains the **private SSH key** that is installed on your servers. Protect it like a
  password: only the account that runs the service (and administrators) should be able to read it.
- Never copy one customer's data folder to another customer's machine.

---

## 8. Data, backup, moving to another machine

Everything Healthcheck remembers is in `HEALTHCHECK_DATA_DIR`:

| File | What it is |
|---|---|
| `healthcheck.sqlite` (+ `-wal`, `-shm`) | Servers, software catalog, conditions, job history, statuses. |
| `healthcheck_id_rsa` / `.pub` | The SSH key installed on your servers (created when you add the first one). |
| `master.key` | Encryption key for stored secrets. |

- **Back up:** stop the service, copy the whole folder, start the service.
- **Move to a new machine:** install as above, stop the service, copy the data folder over, point
  `HEALTHCHECK_DATA_DIR` at it, start. The servers keep working with no re-adding, as long as the new
  machine can reach them.
- **Lost the data folder:** install fresh and add the servers again. The old key stays in each server's
  `~/.ssh/authorized_keys` until you remove it (see *Uninstall*).

---

## 9. Upgrade

```powershell
nssm stop Healthcheck
cd C:\Healthcheck
# Route A:  git fetch origin ; git checkout release-1 ; git pull   then:  npm ci ; npm run build
# Route B:  unpack the new zip over the folder                       then:  npm ci --omit=dev
nssm start Healthcheck
```

The database updates itself on start, and the data folder is untouched. Newer catalog/conditions in the
release are merged in on start; anything the customer edited or deleted locally is respected (details in
README, *The catalog and conditions ship with the repo*). To discard local edits and return to the shipped
catalog and conditions: `npm run defaults:reset`, then restart the service.

---

## 10. Uninstall

```powershell
nssm stop Healthcheck
nssm remove Healthcheck confirm
Remove-Item C:\Healthcheck -Recurse         # the application
# keep or delete the data folder (HEALTHCHECK_DATA_DIR) as you prefer
```

On each Linux server, remove Healthcheck's key so it can no longer log in:

```
sed -i '/healthcheck-generated-key/d' ~/.ssh/authorized_keys
```

Nothing else was installed there.

---

## 11. Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| `No such built-in module: node:sqlite` when starting | Node.js is too old. Install 22.13 or newer. |
| `EADDRINUSE` / "address already in use" on start | Another program uses that port on the Windows machine. Change `PORT` in `.env`. |
| Page shows *Cannot GET /* or is blank | The web part isn't built (`web\dist` is missing). Run `npm run build` (route A) or re-unpack the zip (route B). |
| My `.env` changes have no effect | The service wasn't restarted, or you edited another file: the start-up log line `Settings: …` names the one Healthcheck reads (`C:\Healthcheck\.env`). |
| Adding a server says *unreachable* | Wrong host or port, or a firewall between the two machines. Test with `Test-NetConnection <host> -Port 22`. |
| Adding a server says *authentication failed* | Wrong user name or password for the service account. |
| Start/Stop fails mentioning sudo or a password | The `NOPASSWD` rule is missing for `systemctl` (section 1). |
| The catalog and conditions are empty on a new install | The release is missing `server\defaults\defaults.json` (route B zip built without it). The start-up log says *Could not apply the shipped catalog and conditions*. Add the folder and restart. |
| Every component shows *not installed* | Its systemd unit doesn't exist under the name in the Software Catalog. Check `systemctl list-unit-files`. |
| A start times out although the service is up | The catalog's *Success pattern* isn't what that log prints. Fix it in Software Catalog, or use **Mark as started** on the running line. |
| `npm ci` fails behind a company proxy | `npm config set proxy http://proxy:port` and `npm config set https-proxy http://proxy:port`. |

---

## 12. For the maintainer — publishing changes

Customers install from the **`release-1`** branch (the default branch on GitHub), so that is where
finished changes go:

```powershell
git switch release-1
# ... change and test ...
git add -A
git commit -m "What changed"
git push
```

- **New catalog / conditions:** tune them in the UI on your own installation, then
  `npm run build` and `npm run defaults:export`, commit `server/defaults/defaults.json` and push
  (README, *The catalog and conditions ship with the repo*). Customers pick it up when they upgrade (section 9).
- **Never commit** `server/data`, `.env` or `Services/` (they hold keys and passwords; all three are in
  `.gitignore`). Check with `git status` before a commit.
- **A new major version:** create `release-2` from `release-1`, and tell customers to use
  `--branch release-2` from then on.
- **Keep the release branch working:** before pushing, run `npm run build` once and start the app
  (`npm start`) to be sure it comes up.
