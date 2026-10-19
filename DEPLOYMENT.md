# Deployment Runbook

This document is the step-by-step runbook for deploying Nerve on an Ubuntu VPS with Docker, Nginx, and PostgreSQL hosted on the same server.

## Phase 0: Preflight Checks

Commands:

```bash
ssh root@x.x.x.x
whoami && hostname && lsb_release -a
```

What changed
- Confirmed the target VPS is Ubuntu `24.04.3 LTS`.
- Confirmed the deployment source is `https://github.com/Manju-Bharati-Mahto/Nerve.git` on branch `main`.
- Locked the first public URL to `http://x.x.x.x`.

How to verify
- `whoami` returns `root`
- `lsb_release -a` shows `Ubuntu 24.04`

Rollback steps
- None needed. This phase is read-only.

## Phase 1: Ubuntu Hardening + Prerequisites

Commands:

```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg nginx ufw certbot python3-certbot-nginx git rsync
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
mkdir -p /srv/nerve/{app,releases,shared/env,data/postgres,backups/postgres,scripts}
```

What changed
- Installed Docker Engine, Docker Compose plugin, Nginx, UFW, Certbot, Git, and Rsync.
- Opened only SSH, HTTP, and HTTPS in the firewall.
- Created the persistent directory layout under `/srv/nerve`.

How to verify
- `docker --version`
- `docker compose version`
- `systemctl status nginx --no-pager`
- `ufw status`
- `find /srv/nerve -maxdepth 2 -type d | sort`

Rollback steps
- `ufw disable`
- `apt remove -y nginx certbot python3-certbot-nginx docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`
- `rm -rf /srv/nerve`

## Phase 2: Database Deployment

Copy the repo and env file:

```bash
git clone --branch main https://github.com/Manju-Bharati-Mahto/Nerve.git /srv/nerve/app
cp /srv/nerve/app/.env.example /srv/nerve/shared/env/.env
nano /srv/nerve/shared/env/.env
```

Set at least:
- `APP_BASE_URL=http://x.x.x.x`
- `API_PORT=3001`
- `COOKIE_SECURE=false`
- `POSTGRES_DB=nerve`
- `POSTGRES_USER=nerve_app`
- `POSTGRES_PASSWORD=<strong-random-password>`
- `DATABASE_URL=postgres://nerve_app:<same-password>@db:5432/nerve`
- `SESSION_SECRET=<long-random-secret>`
- `SUPER_ADMIN_EMAIL=super@parul.ac.in`
- `SUPER_ADMIN_PASSWORD=<initial-login-password>`
- `POSTGRES_DATA_DIR=/srv/nerve/data/postgres`

Start the stack:

```bash
cd /srv/nerve/app
docker compose --env-file /srv/nerve/shared/env/.env up -d --build db api
```

What changed
- Started a private PostgreSQL container using `pgvector/pgvector:pg16`.
- Started the API container on `127.0.0.1:3001`.
- Bootstrapped schema, seeded teams, users, and sample entries.

How to verify
- `docker compose --env-file /srv/nerve/shared/env/.env ps`
- `docker compose --env-file /srv/nerve/shared/env/.env logs api --tail=50`
- `docker compose --env-file /srv/nerve/shared/env/.env exec db psql -U nerve_app -d nerve -c "SELECT COUNT(*) FROM users;"`

Rollback steps
- `docker compose --env-file /srv/nerve/shared/env/.env down`
- `rm -rf /srv/nerve/data/postgres/*`

## Phase 3: App Deployment

Install Node and deploy:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
cp /srv/nerve/app/nginx/nerve.conf /etc/nginx/sites-available/nerve
ln -sfn /etc/nginx/sites-available/nerve /etc/nginx/sites-enabled/nerve
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
bash /srv/nerve/app/deploy/scripts/deploy.sh
```

> **The `cp` line above is first-install only — do not re-run it on a live host.**
> Once certbot has issued a certificate it edits the vhost in place, so the live
> file terminates TLS, speaks HTTP/2 and sets HSTS/CSP. `nginx/nerve.conf` in this
> repo has none of that and listens on plain `:80`; copying it over a live vhost
> drops TLS and takes the site down. To change routing on a running host, patch the
> live file instead — `deploy/scripts/add-portal-routes.sh` does exactly that for the
> public portals: it backs up, inserts, runs `nginx -t`, and restores the backup if
> validation fails.

### Upload limits and direct-to-Drive CSP (live vhost)

nginx refuses any request body over 1 MB by default, with an HTML 413 that the
app shows as "Request failed." / "Upload failed.". The live vhost's CSP also has
no `connect-src`, so the browser may not send outreach videos straight to Google
Drive. `deploy/scripts/set-upload-limits.sh` fixes both in the live file, in place:

- every `/api` location gets `client_max_body_size 2100m`, `client_body_timeout 300s`,
  `proxy_request_buffering on`, `proxy_send_timeout 300s`, `proxy_read_timeout 900s`
  (existing values are replaced, never duplicated);
- every `add_header Content-Security-Policy` line in the vhost, or in a file only
  the vhost includes, gets `connect-src 'self' https://www.googleapis.com` —
  nothing else in the policy changes;
- a CSP it must not edit — set at http level (`nginx.conf`, `conf.d/`), in another
  server block for the same `server_name`, or in a snippet another enabled site
  also includes — is reported with its file, line and the corrected line, never
  edited;
- it warns if there is no `location /uploads/` block.

It backs up to `/srv/nerve/backups/nginx/`, runs `nginx -t`, restores the backup
if that fails, and reloads only when something changed. A second run is a no-op.

**How it reaches the server.** `deploy.sh` deploys `main` only, so the script is
not on the server until this branch is merged to `main`. After the merge, the next
`deploy.sh` run applies it automatically — `deploy.sh` calls it after publishing
the release, on every deploy — so there is nothing to run by hand. Deploy as usual:

```bash
bash /srv/nerve/app/deploy/scripts/deploy.sh
```

To re-run it on its own later (e.g. after a hand edit or a certbot rewrite of the
vhost) — `/srv/nerve/app` holds whatever `main` the last deploy checked out:

```bash
sudo bash /srv/nerve/app/deploy/scripts/set-upload-limits.sh
```

Verify (run one at a time):

```bash
head -c 5000000 /dev/zero | curl -sS -o /dev/null -w '%{http_code}\n' -X POST --data-binary @- https://nerve.paruluniversity.ac.in/api/brandops/materials
```

```bash
curl -sI https://nerve.paruluniversity.ac.in/ | grep -i content-security
```

The first must print `401` (anything but `413`); the second must show
`connect-src 'self' https://www.googleapis.com`.

Exit codes: `0` done; `1` failed, nothing changed (or restored from backup);
`2` limits applied but a CSP line in the vhost is in a shape the script will not
edit; `3` limits applied but the CSP is set outside the vhost. For `2` and `3` the
output ends with the file and line (and, for `3`, the exact corrected line) —
edit it by hand, then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

What changed
- Built the frontend and published it into `/srv/nerve/releases/current`.
- Configured Nginx to serve the SPA and proxy `/api` to the local API container.
- Added an atomic symlink-based frontend release switch.

How to verify
- `curl -I http://x.x.x.x`
- `curl http://x.x.x.x/api/health`
- Open `http://x.x.x.x/login` in the browser

Rollback steps
- Point `/srv/nerve/releases/current` back to the previous release directory
- `systemctl reload nginx`
- `docker compose --env-file /srv/nerve/shared/env/.env up -d api`

### Rolling back past a new role

`bootstrapDatabase()` drops and re-creates `users_role_check` on every boot,
using the role list of the build that is starting. If the database already
holds a user whose role that build does not know, the re-create fails and the
API **does not start at all** (every department is down, not only the one that
added the role). The outreach State User (`outreach_state_user`) is such a role:
any build older than the one that introduced it cannot boot against a database
that has State Users. The same applies to any server on another branch (a
second worktree, a staging copy) pointed at the same database.

Before rolling back past it, park the State Users so the old build's constraint
can be added; they cannot sign in while parked (`getSessionUser` admits only
`status = 'active'`), and their assigned states stay in `outreach_user_states`:

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS outreach_state_user_parked AS
  SELECT id, role, status FROM users WHERE false;
INSERT INTO outreach_state_user_parked (id, role, status)
  SELECT id, role, status FROM users WHERE role = 'outreach_state_user';
UPDATE users SET role = 'user', status = 'inactive' WHERE role = 'outreach_state_user';
COMMIT;
```

After redeploying a build that has the role again, restore them:

```sql
BEGIN;
UPDATE users u SET role = p.role, status = p.status
  FROM outreach_state_user_parked p WHERE u.id = p.id;
DROP TABLE outreach_state_user_parked;
COMMIT;
```

## Phase 4: HTTPS Later

Once you have a domain pointing to the VPS:

```bash
certbot --nginx -d your-domain.example
```

Then set:
- `APP_BASE_URL=https://your-domain.example`
- `COOKIE_SECURE=true`

`APP_BASE_URL` must be exactly the address people open Nerve on (same `https://` and host). Outreach videos upload straight from the browser to Google Drive, and Google only accepts the browser's upload from the origin Nerve names here — on any other address the upload quietly falls back to going through the server.

Redeploy:

```bash
bash /srv/nerve/app/deploy/scripts/deploy.sh
```

What changed
- Enabled TLS termination at Nginx.
- Switched session cookies to secure mode.

How to verify
- `curl -I https://your-domain.example`
- Browser shows a valid lock icon

Rollback steps
- `certbot delete --cert-name your-domain.example`
- Restore the previous Nginx config and env values
- Reload Nginx and redeploy

## Local Development

Use the current checkout for feature work and deployment testing instead of pulling into `/srv/nerve/app`.

Commands:

```bash
cp .env.local.example .env.local
nano .env.local
npm run dev:local
```

Expected ports
- Frontend: `http://127.0.0.1:8080`
- API: `http://127.0.0.1:3001`
- PostgreSQL: `127.0.0.1:5432`

What changed
- Starts PostgreSQL in Docker using the local override compose file.
- Runs the API and Vite dev server from the current branch and working tree.
- Keeps local dev credentials in `.env.local` instead of the VPS shared env path.

How to verify
- `curl http://127.0.0.1:3001/api/health`
- Open `http://127.0.0.1:8080/login` in the browser
- Sign in with the `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` values from `.env.local`

Rollback steps
- Press `Ctrl+C` in the `npm run dev:local` terminal
- If needed, run `docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.local down`
