# Environment Variables

## Shared Variables

Set these in `/srv/nerve/shared/env/.env` on the VPS.

| Variable | Required | Purpose | Example |
| --- | --- | --- | --- |
| `APP_BASE_URL` | Yes | Public URL used by the API and docs | `http://173.230.138.42` |
| `API_PORT` | Yes | Internal API port mapped to loopback | `3001` |
| `COOKIE_SECURE` | Yes | Use `false` on HTTP/IP, `true` after HTTPS | `false` |
| `SESSION_SECRET` | Yes | Session signing secret | long random string |
| `DATABASE_URL` | Yes | API connection string | `postgres://nerve_app:password@db:5432/nerve` |
| `POSTGRES_DB` | Yes | Database name for the db container | `nerve` |
| `POSTGRES_USER` | Yes | Database user | `nerve_app` |
| `POSTGRES_PASSWORD` | Yes | Database password | strong random password |
| `POSTGRES_DATA_DIR` | Yes | Host path for persistent PostgreSQL data | `/srv/nerve/data/postgres` |
| `SUPER_ADMIN_EMAIL` | Yes | Seeded super-admin login email | `super@parul.ac.in` |
| `SUPER_ADMIN_PASSWORD` | Yes | Seeded super-admin login password | strong temporary password |

## AI Provider Variables (optional)

The AI layer is **disabled unless configured**. With none of these set, the API
boots and every existing feature — including the current AI Assist page — behaves
exactly as before.

| Variable | Required | Purpose | Example |
| --- | --- | --- | --- |
| `AI_PROVIDER` | No | Adapter selecting the wire format. Defaults to `openai-compatible` | `openai-compatible` |
| `AI_BASE_URL` | No | API root of any OpenAI-compatible endpoint | `https://api.openai.com/v1` |
| `AI_API_KEY` | No | Provider credential. **Server-only** | `sk-...` |
| `AI_MODEL` | No | Model id as the provider names it | `gpt-4o-mini` |
| `AI_TIMEOUT_MS` | No | Request timeout, clamped to 1000–120000 | `30000` |
| `AI_MAX_OUTPUT_TOKENS` | No | Default output cap | `1024` |
| `AI_DAILY_REQUEST_LIMIT` | No | Per-user requests per Nerve calendar day | `50` |
| `AI_PRICING` | No | Per-model rates, JSON. Unset ⇒ cost is not estimated | see below |

### Production: OpenAI

```bash
AI_PROVIDER=openai
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=            # REQUIRED — set the exact model id; there is no default
AI_API_KEY=          # server-only secret, never VITE_-prefixed
```

`AI_MODEL` has no default deliberately. With it unset the layer reports itself
unconfigured and `/ai/ask` returns `AI_NOT_CONFIGURED`, rather than silently
choosing a model and its billing rate on someone's behalf.

Ask Nerve AI is **Admin-only**. Employees, Team Leads, SMC members and the
Operations Coordinator receive 403 from the endpoint regardless of the UI.

#### Cost estimation

No price is built in for any model. Supply rates from your own OpenAI billing
page and costs appear in `mo_ai_requests.estimated_cost`; leave it unset and the
column stays NULL:

```bash
AI_PRICING='{"<model-id>":{"inputPerMillion":0.00,"outputPerMillion":0.00,"currency":"USD"}}'
```

#### OpenAI data-handling notes

Deployment facts, not assurances — verify each against your organisation's own
OpenAI account settings and current terms before relying on it:

- This integration uses the **OpenAI API**, not consumer ChatGPT. OpenAI states
  that API business data is not used to train its models by default unless an
  organisation explicitly opts into data sharing. **Confirm the opt-in state on
  your own account.**
- **Do not assume zero data retention.** ZDR is a separate arrangement that must
  be granted to your organisation; absent it, assume standard API retention.
- **Do not assume India data residency.** Residency is a configured option where
  supported; verify it for your account and region.
- What Nerve sends is bounded by `server/ai/egress.ts`. Approved categories for
  this release are identity (name, designation, team, role), work (project,
  deliverable, deadline, priority, status), My Day and overdue-deliverable data.
  Credentials, tokens and personal contact details are stripped before egress
  and are never sent.
- Retention of Nerve's own AI telemetry (`mo_ai_requests`) is currently
  unbounded; a 13-month policy is recommended and not yet implemented.

All four of `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` must be present together;
set only some and the layer stays off and reports which one is missing.

Because the provider is chosen by base URL, the same adapter serves OpenAI,
Azure-style deployments, Groq, Together, vLLM and Ollama:

```bash
AI_BASE_URL=https://api.groq.com/openai/v1     AI_MODEL=llama-3.1-8b-instant
AI_BASE_URL=http://127.0.0.1:11434/v1          AI_MODEL=llama3.1     # local Ollama
```

`AI_BASE_URL` must use `https` for any remote host. Plain `http` is accepted only
for a loopback address, so the key is never sent over the wire in plaintext.

Verify configuration as an Admin:

```
GET  /api/v1/media/ai/status           # never returns the key
POST /api/v1/media/ai/test-connection  # reachability + auth + model check
```

## Frontend Variables

Local development or build-time variables:

| Variable | Required | Purpose | Default |
| --- | --- | --- | --- |
| `VITE_API_BASE_URL` | Yes | Frontend API base URL | `/api` |

## Local Development

Copy `.env.local.example` to `.env.local` in the repo root for local feature work.

Recommended local values:

| Variable | Required | Purpose | Example |
| --- | --- | --- | --- |
| `APP_BASE_URL` | Yes | Browser URL used by the host API | `http://127.0.0.1:8080` |
| `API_PORT` | Yes | Host API port for `npm run dev:server` | `3001` |
| `DATABASE_URL` | Yes | Host connection string to the Docker PostgreSQL container | `postgres://nerve_app:password@127.0.0.1:5432/nerve` |
| `POSTGRES_DATA_DIR` | Yes | Local persistent PostgreSQL data path | `./.local/postgres-data` |
| `SUPER_ADMIN_EMAIL` | Yes | Seeded local super-admin login email | `super@parul.ac.in` |
| `SUPER_ADMIN_PASSWORD` | Yes | Seeded local super-admin login password | strong temporary password |

Local dev entrypoint:

```bash
npm run dev:local
```

## Secret Handling

What changed
- Secrets are kept out of git and loaded from `/srv/nerve/shared/env/.env`
- `.env.example` documents the required keys without real secrets

How to verify
- `cat /srv/nerve/shared/env/.env`
- `docker compose --env-file /srv/nerve/shared/env/.env config`

Rollback steps
- Restore the previous `.env` from your password manager or server backup
- Re-run the deploy script
