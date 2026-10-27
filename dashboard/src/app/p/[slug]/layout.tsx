import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ProjectTabs } from "@/components/project-tabs";
import { SiteHeader } from "@/components/site-header";
import { getVisibleProject } from "@/server/projects";

export default function ProjectLayout({ children, params }: LayoutProps<"/p/[slug]">) {
  return (
    <>
      <SiteHeader>
        <Suspense fallback={<span className="skeleton h-4 w-40" aria-hidden />}>
          <ProjectNav params={params} />
        </Suspense>
      </SiteHeader>
      <main className="mx-auto w-full max-w-[1600px] px-4 pb-16 pt-6 sm:px-6">{children}</main>
    </>
  );
}

async function ProjectNav({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getVisibleProject(slug);
  if (!project) notFound();

  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="hidden text-border-strong sm:inline" aria-hidden>
        /
      </span>
      <div className="hidden min-w-0 items-center gap-2 sm:flex">
        <span className="truncate text-[13px] font-medium text-fg">{project.name}</span>
        {project.isPublic && (
          <span
            className="hidden shrink-0 rounded border border-border-strong px-1.5 py-px text-[11px] text-fg-muted md:inline"
            title="Anyone can view this project. Nothing can be changed."
          >
            Public, read-only
          </span>
        )}
      </div>
      <span className="hidden text-border-strong sm:inline" aria-hidden>
        /
      </span>
      <ProjectTabs slug={project.slug} />
    </div>
  );
}
