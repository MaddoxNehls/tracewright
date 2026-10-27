import "server-only";
import { cache } from "react";
import type { Project } from "@/lib/types";
import { query } from "./db";
import { toProject, type ProjectRow } from "./rows";
import { buildVisibleProjectQuery, buildVisibleProjectsQuery } from "./sql/projects";
import { getViewer } from "./viewer";

export async function listVisibleProjects(): Promise<Project[]> {
  const rows = await query<ProjectRow>(buildVisibleProjectsQuery(await getViewer()));
  return rows.map(toProject);
}

/** The project, if the current viewer may see it. Callers treat null as 404 so private slugs don't leak. */
// cache(): the layout and the page both resolve the project; one query per request.
export const getVisibleProject = cache(async (slug: string): Promise<Project | null> => {
  const rows = await query<ProjectRow>(buildVisibleProjectQuery(slug, await getViewer()));
  return rows[0] ? toProject(rows[0]) : null;
});
