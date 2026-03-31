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
- Confirmed the deployment source branch is `DB-Integration`.
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
git clone --branch DB-Integration https://github.com/khushveer007/Nerve.git /srv/nerve/app
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
