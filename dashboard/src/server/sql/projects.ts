/**
 * Project visibility rules, as SQL. A project is visible when it is public, or
 * when the signed-in GitHub login is listed in project_members.
 */
import { Params, type BuiltQuery } from "./builder";

export interface Viewer {
  /** GitHub login, lowercased. */
  login: string;
}

/** WHERE fragment over an unaliased `projects` table. */
export function visibilityClause(p: Params, viewer: Viewer | null): string {
  if (!viewer) return "projects.is_public";
  return (
    "(projects.is_public OR EXISTS (" +
    "SELECT 1 FROM project_members m " +
    `WHERE m.project_id = projects.id AND m.github_login = ${p.add(viewer.login.toLowerCase())}))`
  );
}

const PROJECT_COLUMNS = "projects.id, projects.slug, projects.name, projects.is_public";

export function buildVisibleProjectsQuery(viewer: Viewer | null): BuiltQuery {
  const p = new Params();
  const text = `SELECT ${PROJECT_COLUMNS} FROM projects WHERE ${visibilityClause(p, viewer)} ORDER BY projects.is_public, projects.name`;
  return { text, values: p.values };
}

export function buildVisibleProjectQuery(slug: string, viewer: Viewer | null): BuiltQuery {
  const p = new Params();
  const text = `SELECT ${PROJECT_COLUMNS} FROM projects WHERE projects.slug = ${p.add(slug)} AND ${visibilityClause(p, viewer)} LIMIT 1`;
  return { text, values: p.values };
}
