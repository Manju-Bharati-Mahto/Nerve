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

## Phase 4: HTTPS Later

Once you have a domain pointing to the VPS:

```bash
certbot --nginx -d your-domain.example
```

Then set:
- `APP_BASE_URL=https://your-domain.example`
- `COOKIE_SECURE=true`

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

## Phase 5: Google Sign-In for the Public Portals

The external casting and media-request portals authenticate applicants with Google
Identity Services. Verification is server-side: the browser hands over an ID token
and the API checks it against Google before believing anything, so no client secret
exists and none is needed.

In Google Cloud Console, inside the university Workspace organisation:

1. Configure the OAuth consent screen — user type **Internal** (only
   `@paruluniversity.ac.in` accounts are admitted, and Internal avoids Google's
   verification review). Set the app name, a monitored support email, a developer
   contact, and authorized domain `paruluniversity.ac.in`.
2. Create credentials → OAuth client ID → application type **Web application**.
3. Authorized JavaScript origins: the site origin only, e.g.
   `https://nerve.paruluniversity.ac.in` — no path, no trailing slash.
4. Authorized redirect URIs: **leave empty**. The portals use the ID-token
   callback, never a redirect, so no redirect URI is involved.

Then on the server:

```bash
# 1. the client id — note this must ALSO be listed in docker-compose.yml's
#    api.environment block, or Compose will not inject it into the container
echo 'GOOGLE_OAUTH_CLIENT_ID=<id>.apps.googleusercontent.com' >> /srv/nerve/shared/env/.env

# 2. redeploy so the API picks it up
bash /srv/nerve/app/deploy/scripts/deploy.sh

# 3. let Google's script through the Content-Security-Policy
sudo bash /srv/nerve/app/deploy/scripts/enable-google-signin-csp.sh
```

Step 3 is not optional: the hardened policy is `script-src 'self' 'unsafe-inline'`,
which blocks `https://accounts.google.com/gsi/client`, so the sign-in button never
renders however the client id is set.

Never set `ALLOW_DEV_CASTING_IDENTITY` in production. It is already inert there —
it is refused when `NODE_ENV=production` and again whenever a real client id is
configured — but leave it unset regardless.

How to verify
- `curl -sI https://your-domain.example/casting/register/<token> | grep -i content-security`
  shows `accounts.google.com`
- The Google button renders on a fresh casting link
- A `@gmail.com` sign-in is refused with HTTP 403 and creates no record

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
