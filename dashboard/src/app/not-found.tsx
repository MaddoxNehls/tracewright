import Link from "next/link";
import { SiteHeader } from "@/components/site-header";

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-xl flex-col items-start gap-3 px-6 py-24">
        <p className="font-mono text-[12px] text-fg-subtle">404</p>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Nothing recorded here</h1>
        <p className="text-[14px] text-fg-muted">
          This project or run doesn&apos;t exist, or it&apos;s private and you aren&apos;t a member. The public demo is always open.
        </p>
        <div className="mt-2 flex gap-2">
          <Link href="/p/demo/runs" className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-[13px] font-semibold text-accent-fg hover:bg-accent-hover">
            Open the demo
          </Link>
          <Link href="/projects" className="inline-flex h-9 items-center rounded-md border border-border-strong px-4 text-[13px] font-medium text-fg hover:bg-surface-2">
            All projects
          </Link>
        </div>
      </main>
    </>
  );
}
