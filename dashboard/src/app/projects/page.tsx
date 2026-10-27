import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeading } from "@/components/page-heading";
import { SiteHeader } from "@/components/site-header";
import { authEnabled } from "@/server/auth";
import { listVisibleProjects } from "@/server/projects";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[1100px] px-4 pb-16 pt-8 sm:px-6">
        <PageHeading
          title="Projects"
          description={
            authEnabled
              ? "Public projects, plus any private project your GitHub account is a member of."
              : "Public projects. Private projects need GitHub sign-in, which isn't configured on this deployment."
          }
        />
        <Suspense fallback={<ProjectGridSkeleton />}>
          <ProjectGrid />
        </Suspense>
      </main>
    </>
  );
}

async function ProjectGrid() {
  const projects = await listVisibleProjects();
  if (projects.length === 0) {
    return <EmptyState title="No projects to show" body="Run pnpm seed to load the public demo project, or sign in to see your private projects." />;
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {projects.map((p) => (
        <li key={p.id}>
          <Link
            href={`/p/${p.slug}`}
            className="flex h-full flex-col gap-1 rounded-lg border border-border bg-surface px-4 py-3.5 transition-colors hover:border-border-strong hover:bg-surface-2"
          >
            <span className="flex items-center gap-2 text-[14px] font-semibold text-fg">
              {p.name}
              {!p.isPublic && <Lock className="size-3.5 text-fg-subtle" aria-label="Private" />}
            </span>
            <span className="font-mono text-[12px] text-fg-subtle">{p.slug}</span>
            <span className="mt-1 text-[12.5px] text-fg-muted">{p.isPublic ? "Public, read-only" : "Private to members"}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ProjectGridSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
      <span className="skeleton h-[92px]" />
      <span className="skeleton h-[92px]" />
    </div>
  );
}
