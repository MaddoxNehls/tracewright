#!/usr/bin/env bash
# Populate the public demo project with genuinely recorded runs: the research agent's
# mock scenarios, a replay that fixes one of them, and the eval suite (plus a regressed
# eval run), all sent through the ingest service like any real agent's spans.
#
# Usage (from anywhere in the repo):
#   INGEST_URL=https://tracewright-ingest.fly.dev \
#   DATABASE_URL=postgres://... \
#   bash scripts/seed-demo.sh
#
# Environment:
#   INGEST_URL            ingest base URL (default http://localhost:4318)
#   TRACEWRIGHT_API_KEY   key for the demo project; if unset, DATABASE_URL is used to
#                         create the public "demo" project (if needed) and a new key
#   DATABASE_URL          Postgres URL; needed only when TRACEWRIGHT_API_KEY is unset
#   DASHBOARD_URL         optional; prints links to the seeded runs
#   DEMO_SLUG             project slug (default demo)
#
# Needs: bash, curl, uv, and Go (only to create the project/key). Makes no LLM calls:
# every run uses the deterministic mock backend. Re-running adds another set of runs.
set -euo pipefail

INGEST_URL="${INGEST_URL:-http://localhost:4318}"
INGEST_URL="${INGEST_URL%/}"
DEMO_SLUG="${DEMO_SLUG:-demo}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$REPO_ROOT/examples/research-agent"
HINT="Write calculator expressions with plain numbers only."

log() { printf '\n==> %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

curl -fsS "$INGEST_URL/healthz" >/dev/null || die "ingest is not reachable at $INGEST_URL"

if [ -z "${TRACEWRIGHT_API_KEY:-}" ]; then
  [ -n "${DATABASE_URL:-}" ] || die "set TRACEWRIGHT_API_KEY, or DATABASE_URL to create one"
  log "Creating the public '$DEMO_SLUG' project and an API key"
  admin() { (cd "$REPO_ROOT/ingest" && go run ./cmd/tracewright-ingest admin "$@"); }
  if ! out=$(admin create-project --slug "$DEMO_SLUG" --name "Demo" --public 2>&1); then
    grep -q "already exists" <<<"$out" || die "$out"
    echo "project '$DEMO_SLUG' already exists" >&2
  fi
  TRACEWRIGHT_API_KEY=$(admin create-key --project "$DEMO_SLUG")
  echo "created key ${TRACEWRIGHT_API_KEY:0:11}... (store it if you want to seed again)" >&2
fi
export TRACEWRIGHT_API_KEY TRACEWRIGHT_ENDPOINT="$INGEST_URL"

cd "$AGENT_DIR"
uv sync --locked --quiet

# Run the agent CLI and print the trace id it reports.
agent() {
  local out
  out=$(uv run research-agent "$@" 2>&1) || { echo "$out" >&2; die "research-agent $* failed"; }
  echo "$out" | sed -n 's/^trace \([0-9a-f]\{32\}\) .*/\1/p' | tail -1
}

# Ingest writes asynchronously after its 202; wait until a run is readable.
wait_for_run() {
  for _ in $(seq 1 50); do
    if curl -fsS -o /dev/null -H "Authorization: Bearer $TRACEWRIGHT_API_KEY" \
      "$INGEST_URL/v1/runs/$1"; then
      return 0
    fi
    sleep 0.2
  done
  die "run $1 did not become readable"
}

log "Recording the mock scenarios"
apollo=$(agent --scenario apollo-gap)
recovery=$(agent --scenario calculator-recovery)
parallel=$(agent --scenario parallel-lookup)
careful=$(agent --scenario calculator-recovery --model mock-2)
# The same task with a wasted tool loop: a run pair for the dashboard's compare view.
apollo_slow=$(agent --scenario apollo-gap --mock-double-check)

log "Replaying calculator-recovery from step 3 with a prompt fix"
wait_for_run "$recovery"
replay_out=$(uv run research-agent --replay "$recovery" --from-step 3 \
  --override-system-append "$HINT" 2>&1) || { echo "$replay_out" >&2; die "replay failed"; }
replayed=$(echo "$replay_out" | sed -n 's/^trace \([0-9a-f]\{32\}\) .*/\1/p' | tail -1)
echo "$replay_out" | grep -E "calls served|diverged" >&2 || true

log "Running the eval suite, then a regressed run of it"
results_dir=$(mktemp -d)
uv run tracewright eval run evals/suite.yaml -o "$results_dir/baseline.json"
RESEARCH_AGENT_MOCK_DOUBLE_CHECK=1 \
  uv run tracewright eval run evals/suite.yaml -o "$results_dir/regressed.json"
uv run tracewright eval compare --baseline "$results_dir/baseline.json" \
  --current "$results_dir/regressed.json" --thresholds evals/thresholds.yaml \
  ${DASHBOARD_URL:+--dashboard-url "$DASHBOARD_URL" --project "$DEMO_SLUG"} \
  > "$results_dir/report.md" || true   # exits 1: the regression is the point
echo "eval report: $results_dir/report.md" >&2

for id in "$apollo" "$parallel" "$careful" "$apollo_slow" "$replayed"; do
  wait_for_run "$id"
done

log "Seeded the '$DEMO_SLUG' project"
cat <<EOF
apollo-gap               $apollo
calculator-recovery      $recovery   (tool error, recovered)
parallel-lookup          $parallel
careful model            $careful
apollo-gap, extra loop   $apollo_slow
replay of recovery       $replayed   (from step 3, no tool error)
EOF
if [ -n "${DASHBOARD_URL:-}" ]; then
  base="${DASHBOARD_URL%/}/p/$DEMO_SLUG"
  cat <<EOF

run detail:   $base/runs/$recovery
compare:      $base/compare?a=$apollo&b=$apollo_slow
replay diff:  $base/compare?a=$recovery&b=$replayed
EOF
fi
