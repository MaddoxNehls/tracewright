/**
 * pnpm seed: loads the public `demo` project (and a small private project) with
 * generated research-agent runs, written straight into `spans` and `runs`.
 *
 * Schema: for standalone dev this applies db/contract-dev.sql (IF NOT EXISTS
 * mirror of the contract). The canonical schema is the ingest service's
 * migrations; on a database migrated by ingest those statements are no-ops.
 *
 * Idempotent: re-running replaces the seeded projects' runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { generateDemoRuns, type GeneratedRun } from "../src/seed/research-agent";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://tracewright:tracewright@localhost:5442/tracewright";

interface SeedProject {
  slug: string;
  name: string;
  isPublic: boolean;
  members: string[];
  runs: GeneratedRun[];
}

function runRow(run: GeneratedRun) {
  const spans = run.spans;
  const root = spans.find((s) => s.parentSpanId === null);
  const earliest = [...spans].sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
  if (!earliest) throw new Error(`run ${run.traceId} has no spans`);
  const start = Math.min(...spans.map((s) => Date.parse(s.startTime)));
  const end = Math.max(...spans.map((s) => Date.parse(s.endTime)));
  const costs = spans.map((s) => s.costUsd).filter((c): c is number => c !== null);
  const rawTags = root?.attributes["tracewright.tags"];
  return {
    trace_id: run.traceId,
    // Same rules ingest applies: name/tags from the root, status from the root's status.
    name: (root ?? earliest).name,
    status: root?.status === "error" ? "error" : "ok",
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    duration_ms: end - start,
    span_count: spans.length,
    llm_call_count: spans.filter((s) => s.kind === "llm").length,
    tool_call_count: spans.filter((s) => s.kind === "tool").length,
    total_input_tokens: spans.reduce((n, s) => n + (s.inputTokens ?? 0), 0),
    total_output_tokens: spans.reduce((n, s) => n + (s.outputTokens ?? 0), 0),
    total_cost_usd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : null,
    tags: Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === "string") : [],
    models: [...new Set(spans.map((s) => s.model).filter((m): m is string => m !== null))].sort(),
  };
}

function spanRow(s: GeneratedRun["spans"][number]) {
  return {
    trace_id: s.traceId,
    span_id: s.spanId,
    parent_span_id: s.parentSpanId,
    name: s.name,
    kind: s.kind,
    start_time: s.startTime,
    end_time: s.endTime,
    status: s.status,
    error: s.error,
    attributes: s.attributes,
    input: s.input,
    output: s.output,
    model: s.model,
    input_tokens: s.inputTokens,
    output_tokens: s.outputTokens,
    cost_usd: s.costUsd,
  };
}

async function main() {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const root = join(import.meta.dirname, "..");
  try {
    await sql.unsafe(readFileSync(join(root, "db/contract-dev.sql"), "utf8"));
    await sql.unsafe(readFileSync(join(root, "db/dashboard.sql"), "utf8"));

    const anchor = Math.floor(Date.now() / 60_000) * 60_000;
    const demoRuns = generateDemoRuns(anchor);
    const projects: SeedProject[] = [
      { slug: "demo", name: "Research agent (demo)", isPublic: true, members: [], runs: demoRuns },
      // Private: only visible to listed GitHub logins once OAuth is configured.
      { slug: "internal-evals", name: "Internal evals", isPublic: false, members: ["maddoxnehls"], runs: generateDemoRuns(anchor, 7).slice(-6) },
    ];

    for (const project of projects) {
      await sql.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO projects (slug, name, is_public)
          VALUES (${project.slug}, ${project.name}, ${project.isPublic})
          ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, is_public = EXCLUDED.is_public
          RETURNING id`;
        if (!row) throw new Error(`failed to upsert project ${project.slug}`);
        const projectId = row.id;

        await tx`DELETE FROM spans WHERE project_id = ${projectId}`;
        await tx`DELETE FROM runs WHERE project_id = ${projectId}`;
        await tx`DELETE FROM project_members WHERE project_id = ${projectId}`;
        for (const login of project.members) {
          await tx`INSERT INTO project_members (project_id, github_login) VALUES (${projectId}, ${login.toLowerCase()})`;
        }

        // One JSON parameter per table: explicit column types, no per-row round trips.
        const spans = JSON.stringify(project.runs.flatMap((r) => r.spans.map(spanRow)));
        await tx.unsafe(
          `INSERT INTO spans (project_id, trace_id, span_id, parent_span_id, name, kind, start_time, end_time, status,
                              error, attributes, input, output, model, input_tokens, output_tokens, cost_usd)
           SELECT $1::uuid, r.trace_id, r.span_id, r.parent_span_id, r.name, r.kind, r.start_time, r.end_time, r.status,
                  nullif(r.error, 'null'::jsonb), r.attributes, nullif(r.input, 'null'::jsonb), nullif(r.output, 'null'::jsonb),
                  r.model, r.input_tokens, r.output_tokens, r.cost_usd
           FROM jsonb_to_recordset($2::text::jsonb) AS r(
             trace_id text, span_id text, parent_span_id text, name text, kind text, start_time timestamptz,
             end_time timestamptz, status text, error jsonb, attributes jsonb, input jsonb, output jsonb, model text,
             input_tokens bigint, output_tokens bigint, cost_usd numeric)`,
          [projectId, spans],
        );

        const runs = JSON.stringify(project.runs.map(runRow));
        await tx.unsafe(
          `INSERT INTO runs (project_id, trace_id, name, status, start_time, end_time, duration_ms, span_count,
                             llm_call_count, tool_call_count, total_input_tokens, total_output_tokens, total_cost_usd, tags, models)
           SELECT $1::uuid, r.trace_id, r.name, r.status, r.start_time, r.end_time, r.duration_ms, r.span_count,
                  r.llm_call_count, r.tool_call_count, r.total_input_tokens, r.total_output_tokens, r.total_cost_usd, r.tags, r.models
           FROM jsonb_to_recordset($2::text::jsonb) AS r(
             trace_id text, name text, status text, start_time timestamptz, end_time timestamptz, duration_ms double precision,
             span_count int, llm_call_count int, tool_call_count int, total_input_tokens bigint, total_output_tokens bigint,
             total_cost_usd numeric, tags text[], models text[])`,
          [projectId, runs],
        );
      });

      const spanCount = project.runs.reduce((n, r) => n + r.spans.length, 0);
      const errors = project.runs.filter((r) => r.status === "error").length;
      console.log(
        `seeded ${project.slug.padEnd(15)} ${project.isPublic ? "public " : "private"}  ${project.runs.length} runs, ${spanCount} spans, ${errors} failed`,
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
