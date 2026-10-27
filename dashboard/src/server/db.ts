import "server-only";
import { connection } from "next/server";
import postgres from "postgres";
import type { BuiltQuery } from "./sql/builder";

export const DEFAULT_DATABASE_URL = "postgres://tracewright:tracewright@localhost:5442/tracewright";

type Sql = ReturnType<typeof postgres>;

// Reuse one pool across dev hot reloads instead of leaking a pool per edit.
const globalForDb = globalThis as unknown as { __twSql?: Sql };

function client(): Sql {
  globalForDb.__twSql ??= postgres(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, {
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // safe behind transaction poolers (Neon, PgBouncer)
  });
  return globalForDb.__twSql;
}

/**
 * Runs a parameterized query. Every read is request-time data, so this first
 * opts the render out of prerendering (Cache Components would otherwise try to
 * bake a query result into the static shell at build time).
 */
export async function query<Row extends object>(q: BuiltQuery): Promise<Row[]> {
  await connection();
  const rows = await client().unsafe(q.text, q.values as postgres.ParameterOrJSON<never>[]);
  return rows as unknown as Row[];
}
