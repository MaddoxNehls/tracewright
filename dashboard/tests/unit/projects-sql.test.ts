import { describe, expect, it } from "vitest";
import { buildVisibleProjectQuery, buildVisibleProjectsQuery } from "@/server/sql/projects";

describe("project visibility", () => {
  it("anonymous viewers only see public projects", () => {
    const q = buildVisibleProjectsQuery(null);
    expect(q.text).toContain("WHERE projects.is_public");
    expect(q.text).not.toContain("project_members");
    expect(q.values).toEqual([]);
  });

  it("signed-in viewers also see projects they are members of, matched case-insensitively", () => {
    const q = buildVisibleProjectQuery("internal-evals", { login: "MaddoxNehls" });
    expect(q.text).toContain("projects.slug = $1 AND (projects.is_public OR EXISTS");
    expect(q.text).toContain("m.github_login = $2");
    expect(q.values).toEqual(["internal-evals", "maddoxnehls"]);
  });
});
