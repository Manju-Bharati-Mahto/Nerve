# Operations Guide

## Daily Backup

Run a one-off backup:

```bash
bash /srv/nerve/app/deploy/scripts/backup-postgres.sh
```

Add the cron job:

```bash
crontab -e
```

Cron entry:

```cron
0 2 * * * /usr/bin/bash /srv/nerve/app/deploy/scripts/backup-postgres.sh >> /var/log/nerve-backup.log 2>&1
```

What changed
- Creates compressed PostgreSQL dumps in `/srv/nerve/backups/postgres`
- Keeps 7 days of backups by default

How to verify
- `ls -lh /srv/nerve/backups/postgres`
- `tail -n 50 /var/log/nerve-backup.log`

Rollback steps
- Remove the cron entry
- Delete backup files if needed

## Restore

Restore into the live database:

```bash
bash /srv/nerve/app/deploy/scripts/restore-postgres.sh /srv/nerve/backups/postgres/nerve-YYYYMMDD-HHMMSS.sql.gz
```

Test restore into a throwaway database:

```bash
bash /srv/nerve/app/deploy/scripts/test-restore.sh /srv/nerve/backups/postgres/nerve-YYYYMMDD-HHMMSS.sql.gz
```

What changed
- Restore script streams a dump back into PostgreSQL
- Test restore validates a backup without touching production data

How to verify
- The test restore script prints a successful user count query
- The live restore script exits with code `0`

Rollback steps
- Re-run restore using the previous known-good backup

## Logs and Restart

API and DB containers:

```bash
cd /srv/nerve/app
docker compose --env-file /srv/nerve/shared/env/.env logs api --tail=100
docker compose --env-file /srv/nerve/shared/env/.env logs db --tail=100
docker compose --env-file /srv/nerve/shared/env/.env restart api
docker compose --env-file /srv/nerve/shared/env/.env restart db
```

Nginx:

```bash
systemctl status nginx --no-pager
journalctl -u nginx -n 100 --no-pager
```

What changed
- Standardized where to look for runtime issues
- Added safe restart commands for each layer

How to verify
- `docker compose ... ps`
- `curl http://173.230.138.42/api/health`

Rollback steps
- Restart the previous failing service again after restoring env or release symlink

## Updating the App

```bash
bash /srv/nerve/app/deploy/scripts/deploy.sh
```

What changed
- Pulls latest `DB-Integration`
- Runs `npm ci`, `lint`, `test`, `build`
- Rebuilds containers and publishes the new SPA release

How to verify
- New release directory appears in `/srv/nerve/releases`
- Browser reflects the new version

Rollback steps
- Point `/srv/nerve/releases/current` to the previous release
- Redeploy the previous git commit if the API schema changed
