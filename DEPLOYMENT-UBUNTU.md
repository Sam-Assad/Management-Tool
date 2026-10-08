# Deploying Healthcheck on Ubuntu

This guide installs Healthcheck on an **Ubuntu machine** (the "Healthcheck host") that can reach your
**Linux servers** over SSH. It runs as a systemd service under its own system account. For what the tool does
and how to use it, see [README.md](README.md). The Windows guide is [DEPLOYMENT.md](DEPLOYMENT.md).

Moving an existing Windows installation to Ubuntu (same machine or a new one)? **Do section 0 first, before
Windows is wiped.** Then follow sections 1 to 6.

```
  Healthcheck host (Ubuntu)                      Linux servers (one or many)
  ┌──────────────────────────┐   SSH (port 22   ┌────────────────────────────┐
  │ Node.js + Healthcheck    │ ───────────────► │ systemd units + a service  │
  │ browser → :4000          │  or your port)   │ account with sudo systemctl│
  └──────────────────────────┘                  └────────────────────────────┘
```

Layout used throughout this guide (change the paths if you like, but keep the application and the data apart):

| What | Where |
|---|---|
| Application (code, built files, `.env`) | `/opt/healthcheck` |
| Data (database, SSH key, `master.key`) | `/var/lib/healthcheck` |
| Account that runs it | `healthcheck` (system account, no login shell) |
| Service | `healthcheck.service` |

---

## 0. Moving from Windows: save the data first

Everything Healthcheck knows lives in two places on the Windows machine. Without them you would have to
re-create every account and re-add every server.

| On Windows | What it is |
|---|---|
| `server\data\` (or the folder `HEALTHCHECK_DATA_DIR` points to) | `healthcheck.sqlite` (+ `-wal`, `-shm`): servers, users, catalog, conditions, history. `healthcheck_id_rsa` / `.pub`: the SSH key installed on your servers. `master.key`: decrypts stored secrets. |
| `.env` in the project folder | Your settings, including `ARTEMIS_PASSWORD`. |

1. **Stop Healthcheck** so the database is complete on disk: close the window running it (`Ctrl+C`), or
   `nssm stop Healthcheck` if it runs as a service.
2. **Pack both into one file** (PowerShell, in the project folder; `tar` is built into Windows Server 2019):
   ```powershell
   cd C:\Users\sam\Desktop\Healthcheck
   tar -czf $HOME\healthcheck-move.tgz .env -C server data
   tar -tzf $HOME\healthcheck-move.tgz
   ```
   The list must show `.env`, `data/healthcheck.sqlite`, `data/master.key`, `data/healthcheck_id_rsa` and
   `data/healthcheck_id_rsa.pub`.

   **`Couldn't open data/healthcheck.sqlite: Permission denied`** means Healthcheck is still running. Windows
   locks the database while it's open, and `tar` still writes the file, just without the database. Stop
   Healthcheck (step 1) and run both commands again.
3. **Copy `healthcheck-move.tgz` off this machine** (a network share, a USB disk, or another server with
   `scp`). If the disk is going to be wiped for Ubuntu, this copy is the only one left.
4. **Treat the file like a password.** It holds the private key that logs in to your servers, and the
   Artemis password.

The servers need nothing: the same key keeps working from the Ubuntu machine. Only if a server's firewall or
`sshd` allows SSH just from the old machine's IP address, and the address changes, add the new one there.

---

## 1. Before you start: checklist

**On the Healthcheck host (Ubuntu 22.04 or 24.04 LTS)**

- [ ] `sudo` access.
- [ ] Network access from this machine to every Linux server on its SSH port. Check one:
      `nc -zv <server-ip> 22`
- [ ] A free port for the web page (default `4000`).
- [ ] Internet or an npm mirror (for `npm ci`), and git access to the repository.

**On every Linux server:** nothing new. The requirements are the same as on Windows (see
[DEPLOYMENT.md](DEPLOYMENT.md), section 1): systemd services, a service account, and `NOPASSWD` sudo for
`systemctl`.

---

## 2. Install Node.js 24

Ubuntu's own `nodejs` package is too old: Healthcheck needs **Node.js 22.13 or newer** for its built-in
database (`node:sqlite`). Install Node 24 from NodeSource:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v      # v24.x
```

If `apt` already had an older `nodejs` installed, remove it first: `sudo apt-get remove -y nodejs`.

---

## 3. Get the application and build it

```bash
sudo git clone --branch release-1 https://github.com/Sam-Assad/Management-Tool.git /opt/healthcheck
cd /opt/healthcheck
sudo npm ci
sudo npm run build
```

`npm warn allow-scripts …` lines about `esbuild` / `ssh2` are harmless. Copy only the source from git, never a
`node_modules` folder from Windows: some packages in it are built for Windows.

**The account that runs it, and the data folder:**

```bash
sudo useradd --system --home-dir /var/lib/healthcheck --shell /usr/sbin/nologin healthcheck
sudo install -d -o healthcheck -g healthcheck -m 700 /var/lib/healthcheck
```

---

## 4. Data and settings

### 4a. Moving from Windows (you made `healthcheck-move.tgz` in section 0)

Copy the file to the Ubuntu machine (for example to your home folder), then:

```bash
mkdir -p /tmp/hc-move && tar -xzf ~/healthcheck-move.tgz -C /tmp/hc-move
sudo cp -a /tmp/hc-move/data/. /var/lib/healthcheck/
sudo cp /tmp/hc-move/.env /opt/healthcheck/.env
sudo sed -i 's/\r$//' /opt/healthcheck/.env            # Windows line endings off
rm -rf /tmp/hc-move
cd /opt/healthcheck && sudo node server/dist/cli/settings.js   # adds any setting it lacks, keeps your values
```

Each server row still remembers the key at its old Windows location (`C:\...\server\data\healthcheck_id_rsa`).
That's expected: on its first connection Healthcheck finds the same key in `/var/lib/healthcheck` and
corrects the row.

### 4b. A fresh install

Write the settings file (every setting at its default, with a comment on each):

```bash
cd /opt/healthcheck && sudo node server/dist/cli/settings.js
```

### 4c. Settings (both cases)

All settings are in this one file, `/opt/healthcheck/.env`; Healthcheck reads nothing else. Each setting says
what it does and its default, and **(recommended)** means keep the default. Edit it with
`sudo nano /opt/healthcheck/.env`. These lines must be right on Ubuntu:

```ini
HEALTHCHECK_DATA_DIR=/var/lib/healthcheck
PORT=4000
HOST=127.0.0.1
PUBLIC_URL=http://<this machine's name or IP>:4000
ARTEMIS_PASSWORD=<the broker password>
```

- **Remove any Windows path** that came with a moved `.env`, such as `HEALTHCHECK_DATA_DIR=D:\...`.
- **`HOST`:** `127.0.0.1` means only this machine can open the page. To let other PCs in, see section 7.
- **`PUBLIC_URL`:** the address people type to open Healthcheck. The admin reset link starts with it.

The other settings have sensible defaults (README section 2).

### 4d. Ownership and permissions

The data folder holds the private SSH key, and `.env` holds the Artemis password. Only the service account
should read them:

```bash
sudo chown -R healthcheck:healthcheck /var/lib/healthcheck
sudo chmod 700 /var/lib/healthcheck
sudo find /var/lib/healthcheck -type f -exec chmod 600 {} +
sudo chown root:healthcheck /opt/healthcheck/.env
sudo chmod 640 /opt/healthcheck/.env
```

---

## 5. Run it as a service

Create `/etc/systemd/system/healthcheck.service` (`sudo nano /etc/systemd/system/healthcheck.service`):

```ini
[Unit]
Description=Healthcheck (loyalty platform ops console)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=healthcheck
Group=healthcheck
WorkingDirectory=/opt/healthcheck
ExecStart=/usr/bin/node server/dist/index.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5
# It only needs to write its data folder
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/healthcheck

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now healthcheck
systemctl status healthcheck --no-pager
journalctl -u healthcheck -n 30 --no-pager
```

The log should end with `Healthcheck server listening on http://127.0.0.1:4000`. Check from the machine
itself: `curl -s http://127.0.0.1:4000/api/auth/status` answers with a short JSON line.

`ProtectHome=true` hides `/home` from the service. Keep the application in `/opt` as shown, or remove that line
if you install it under a home folder.

---

## 6. First sign-in and checks

**Moved from Windows:**
- [ ] Sign in with your existing account (`sam1`); passwords didn't change. Everyone signs in again once.
- [ ] Open a server → **Check status**. Every service shows its real state (this also corrects the key's
      stored location, see 4a).
- [ ] The Artemis box shows its last readings, and the Users page lists the same people.

**Fresh install:**
- [ ] The page opens on **Create the first admin**.
- [ ] Add a second admin soon, so you can reset each other's password.
- [ ] Add servers as in [DEPLOYMENT.md](DEPLOYMENT.md), section 6.

**Both:**
- [ ] **Timezone.** The Artemis check runs at 08:00, 14:00 and 20:00 on this machine's clock:
      ```bash
      timedatectl                                   # shows the current zone
      sudo timedatectl set-timezone <Region/City>   # list them with: timedatectl list-timezones
      sudo systemctl restart healthcheck
      ```
- [ ] **Clock in sync.** Admins reset a forgotten password with codes from their authenticator app, which only
      work while this machine's clock is within about 30 seconds of the phone's. `timedatectl` must say
      `System clock synchronized: yes`. With no internet, point it at your company's time server: set
      `NTP=<time-server>` in `/etc/systemd/timesyncd.conf`, then
      `sudo systemctl restart systemd-timesyncd`.

---

## 7. Security and access from other PCs

- **Sign-in is required** for everyone (named accounts, permissions; see README, *Signing in*).
- **Opening it to other PCs:** set `HOST=0.0.0.0` in `.env`, restart the service, and allow only your
  operators' network through the firewall:
  ```bash
  sudo ufw allow from 10.20.30.0/24 to any port 4000 proto tcp
  sudo ufw enable        # if ufw isn't on yet; allow SSH first if you manage this machine over SSH: sudo ufw allow OpenSSH
  ```
- **HTTPS:** if you put it behind HTTPS (for example an nginx reverse proxy), set `COOKIE_SECURE=true` in `.env`.
- **The data folder holds the private SSH key** installed on your servers. Keep the permissions from 4d, and
  never copy one market's data folder to another market's machine.

---

## 8. Everyday commands

Run commands that touch the data **as the `healthcheck` account**. Otherwise new files in the data folder end
up owned by root, and the service can no longer write to them.

| Task | Command |
|---|---|
| Status / logs | `systemctl status healthcheck` · `journalctl -u healthcheck -f` |
| Restart (after editing `.env`) | `sudo systemctl restart healthcheck` |
| Admin forgot their password (no other admin) | `cd /opt/healthcheck && sudo -u healthcheck node server/dist/cli/resetPassword.js <username>`. It prints a one-time link. |
| Return to the shipped catalog and conditions | `cd /opt/healthcheck && sudo -u healthcheck node server/dist/tools/defaults.js reset`, then restart |
| Back up | `sudo systemctl stop healthcheck && sudo tar -czf ~/healthcheck-backup-$(date +%F).tgz -C /var/lib healthcheck && sudo systemctl start healthcheck` |

---

## 9. Upgrade

```bash
sudo systemctl stop healthcheck
cd /opt/healthcheck
sudo git pull
sudo npm ci
sudo npm run build
sudo node server/dist/cli/settings.js     # adds settings the new version brings, keeps your values
sudo systemctl start healthcheck
journalctl -u healthcheck -n 20 --no-pager
```

The database updates itself on start, and `/var/lib/healthcheck` is never touched by an upgrade. (The
settings line matters here: the `.env` file belongs to root, so Healthcheck itself can't add new settings to
it. Without it a new setting simply uses its default, and the start-up log says so.)

---

## 10. Uninstall

```bash
sudo systemctl disable --now healthcheck
sudo rm /etc/systemd/system/healthcheck.service && sudo systemctl daemon-reload
sudo rm -rf /opt/healthcheck
# keep or delete /var/lib/healthcheck (data), then: sudo userdel healthcheck
```

On each Linux server, remove Healthcheck's key: `sed -i '/healthcheck-generated-key/d' ~/.ssh/authorized_keys`.

---

## 11. Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| `No such built-in module: node:sqlite` | Node.js is too old (Ubuntu's own package). Install Node 24 (section 2) and check `node -v`. |
| Service fails with `EACCES` / `SQLITE_READONLY` / "permission denied" | The data folder or a file in it isn't owned by `healthcheck`, often after running a command with plain `sudo`. Run the `chown` / `chmod` lines in 4d again, then restart. |
| Every server says *Healthcheck's SSH key is missing* | The data folder wasn't copied, or isn't where `HEALTHCHECK_DATA_DIR` points. Copy `healthcheck_id_rsa` (+ `.pub`) and `master.key` from the backup into `/var/lib/healthcheck` (section 4a). |
| Servers say *unreachable* | Network or firewall between this machine and the server: `nc -zv <server-ip> 22`. If a server only allows SSH from the old machine's IP, add the new one there. |
| Page doesn't open from another PC | `HOST` is still `127.0.0.1`, or `ufw` blocks the port (section 7). |
| `EADDRINUSE` on start | Another program uses the port: `sudo ss -ltnp \| grep 4000`. Change `PORT` in `.env`. |
| `.env` changes have no effect | Restart the service. The file must be `/opt/healthcheck/.env`, readable by the `healthcheck` group (4d). |
| Artemis readings at the wrong hours | The machine's timezone (section 6). |
| Authenticator codes refused, "the time on your phone and on the Healthcheck server are about N minutes apart" | This machine's clock isn't synchronized (section 6, *Clock in sync*), or the phone's time is set by hand. |
| Page shows *Cannot GET /* or is blank | The web part isn't built: `cd /opt/healthcheck && sudo npm run build`. |
| Service won't start after a moved `.env` | A Windows path is still in it (for example `HEALTHCHECK_DATA_DIR=D:\...`), or Windows line endings: run the `sed` line in 4a. |
