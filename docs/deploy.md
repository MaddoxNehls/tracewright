# Deploying Tracewright

| piece | where | why there |
|---|---|---|
| Postgres | **Neon** | managed Postgres with a pooled endpoint for serverless readers |
| Ingest (Go) | **Fly.io** | one long-lived machine: ingest buffers spans in memory and holds DB connections |
| Dashboard (Next.js) | **Vercel** | the framework's native host; reads Postgres directly |
| Sign-in | **GitHub OAuth app** | private projects; the public demo needs no sign-in |

Steps marked **(human)** need an account, a browser, or a secret, and can't be scripted
from this repo. Everything else is a command to copy. Budget: the free tiers of all four
cover the public demo, which makes no LLM calls.

## 1. Neon: the database

1. **(human)** Create a Neon account and a project (Postgres 17, region `aws-us-east-1`,
   near Fly's `iad`).
2. **(human)** From **Connect**, copy both connection strings for the default database:
   - **direct**: `postgresql://USER:PASSWORD@ep-xxx.us-east-1.aws.neon.tech/neondb?sslmode=require`
     for **ingest**. It is a long-lived process with a few connections, each writer holding
     one for a whole transaction, so it doesn't need a pooler.
   - **pooled** (host contains `-pooler`): for the **dashboard**. Serverless functions open
     connections per instance, and the pooler keeps that within Neon's limits. The
     dashboard's client already disables prepared statements (`prepare: false`), which
     PgBouncer's transaction mode requires.

There is no schema step: ingest applies its embedded migrations at startup, under an
advisory lock.

## 2. Fly.io: ingest

1. **(human)** Create a Fly account and install `flyctl`, then `fly auth login`.
2. Create the app and set its secret. App names are global, so change `app` in
   `ingest/fly.toml` if `tracewright-ingest` is taken:

   ```sh
   cd ingest
   fly apps create tracewright-ingest
   fly secrets set DATABASE_URL='postgresql://...direct...?sslmode=require'   # (human: the secret)
   fly deploy
   curl https://tracewright-ingest.fly.dev/healthz   # ok
   ```

   `fly.toml` keeps one machine always running (ingest holds accepted spans in memory),
   health-checks `/healthz`, caps per-machine concurrency, and gives graceful shutdown
   the 30 s it needs to drain its queue. The image is a static binary on distroless, about
   25 MB.
3. Create the public demo project and an API key. The admin commands talk to Postgres
   directly, so run them from a checkout with the direct URL:

   ```sh
   export DATABASE_URL='postgresql://...direct...?sslmode=require'
   go run ./cmd/tracewright-ingest admin create-project --slug demo --name "Research agent (demo)" --public
   go run ./cmd/tracewright-ingest admin create-key --project demo   # printed once; store it
   ```

## 3. Seed the demo with recorded runs

Use [`scripts/seed-demo.sh`](../scripts/seed-demo.sh): it runs the research agent's mock
scenarios, a replay that fixes one of them, and the eval suite (plus a deliberately
regressed eval run), all **through ingest**. The demo therefore shows data recorded the
same way a user's would be. No LLM is called. Without `TRACEWRIGHT_API_KEY` it creates
the project and a key from `DATABASE_URL` itself.

```sh
INGEST_URL=https://tracewright-ingest.fly.dev \
TRACEWRIGHT_API_KEY=tw_... \
DASHBOARD_URL=https://tracewright.vercel.app \
bash scripts/seed-demo.sh
```

It prints the seeded trace ids and dashboard links (run detail, a compare pair, and the
replay next to its original). The dashboard's synthetic `pnpm seed` stays a local-dev
tool; don't run it against production.

## 4. GitHub OAuth app (optional: private projects)

Without it the dashboard runs read-only, showing public projects only.

1. **(human)** GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**:
   - Homepage URL: `https://tracewright.vercel.app`
   - Authorization callback URL: `https://tracewright.vercel.app/api/auth/callback/github`
2. **(human)** Copy the client ID and generate a client secret.
3. Grant access to a private project by GitHub login (lowercase):

   ```sql
   INSERT INTO project_members (project_id, github_login)
   SELECT id, 'your-github-login' FROM projects WHERE slug = 'my-project';
   ```

## 5. Vercel: the dashboard

1. **(human)** Create a Vercel account and import the GitHub repository.
2. Project settings:
   - **Root Directory**: `dashboard`. Framework preset Next.js; the default install and
     build commands are right.
   - Leave **Include files outside the root directory in the Build Step** enabled. The
     dashboard depends on `link:../packages/run-diff`, and `pnpm build` builds that package
     first (its `prebuild` script).
3. Environment variables (Production and Preview):

   | variable | value |
   |---|---|
   | `DATABASE_URL` | Neon **pooled** connection string |
   | `DATABASE_POOL_MAX` | `2` (connections per serverless instance; default 5) |
   | `ENABLE_EXPERIMENTAL_COREPACK` | `1`, so Vercel uses the pnpm version pinned in `dashboard/package.json` (`pnpm@11.0.9`) |
   | `AUTH_SECRET` | `openssl rand -base64 32` **(human: generate and paste)** |
   | `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | from step 4, if you set it up |

   Or with the CLI:

   ```sh
   cd dashboard
   vercel link
   vercel env add DATABASE_URL production
   vercel env add AUTH_SECRET production
   vercel env add ENABLE_EXPERIMENTAL_COREPACK production
   vercel deploy --prod
   ```

This build is checked: a fresh `git clone` of the repo, then `pnpm install
--frozen-lockfile && pnpm build` in `dashboard/`, installs and builds `run-diff` through
the link and completes with no database configured. The build prerenders only static
shells; data is read at request time, so the build doesn't need `DATABASE_URL`.

## 6. CI wiring (optional)

For the [agent-eval workflow](../.github/workflows/agent-eval.yml) to send eval runs to the
deployment and link regressions to the dashboard, add these in GitHub → Settings → Secrets
and variables → Actions:

| kind | name | value |
|---|---|---|
| secret | `TRACEWRIGHT_API_KEY` | an API key for the project eval runs should land in |
| variable | `TRACEWRIGHT_ENDPOINT` | `https://tracewright-ingest.fly.dev` |
| variable | `TRACEWRIGHT_DASHBOARD_URL` | `https://tracewright.vercel.app` |
| variable | `TRACEWRIGHT_PROJECT` | that project's slug |

## Checklist

```sh
curl https://tracewright-ingest.fly.dev/healthz                                    # ok
curl -H "Authorization: Bearer $KEY" https://tracewright-ingest.fly.dev/v1/runs/$TRACE_ID   # 200
fly logs -a tracewright-ingest                                                     # "applied migrations" on first boot
```

Then open the dashboard: the demo project is listed without signing in, and the links
printed by the seed script open the run detail and compare views.

## Steps that need a human

1. Neon, Fly.io and Vercel accounts (and payment details if a free tier asks for them).
2. Copying the Neon connection strings, and pasting secrets into `fly secrets` and Vercel.
3. Registering the GitHub OAuth app, and generating `AUTH_SECRET`.
4. Importing the repository into Vercel (GitHub authorization).
5. Choosing global names: the Fly app and the Vercel project/domain.
