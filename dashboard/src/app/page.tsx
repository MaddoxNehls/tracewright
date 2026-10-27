import { GithubIcon } from "@/components/github-icon";
import Link from "next/link";
import { KindLegend, Waterfall } from "@/components/run/waterfall";
import { SiteHeader } from "@/components/site-header";
import { StatusBadge } from "@/components/status";
import { formatCost, formatDuration } from "@/lib/format";
import { DEMO_PROJECT_SLUG, REPO_URL } from "@/lib/site";
import { buildSpanTree, layoutWaterfall, timeTicks, traceWindow } from "@/lib/waterfall";
import { generateHeroRun } from "@/seed/research-agent";

const DEMO_HREF = `/p/${DEMO_PROJECT_SLUG}/runs`;

export default function LandingPage() {
  return (
    <>
      <SiteHeader>
        <nav aria-label="Main" className="ml-auto hidden items-center gap-1 sm:flex">
          <Link href={DEMO_HREF} className="rounded-md px-2.5 py-1.5 text-[13px] text-fg-muted hover:text-fg">
            Demo
          </Link>
          <Link href="/projects" className="rounded-md px-2.5 py-1.5 text-[13px] text-fg-muted hover:text-fg">
            Projects
          </Link>
          <a href={REPO_URL} className="rounded-md px-2.5 py-1.5 text-[13px] text-fg-muted hover:text-fg">
            GitHub
          </a>
        </nav>
      </SiteHeader>

      <main className="relative overflow-hidden">
        <div className="hero-grid pointer-events-none absolute inset-x-0 top-0 h-[720px]" aria-hidden />

        <section className="relative mx-auto max-w-[1200px] px-4 pb-10 pt-16 sm:px-6 sm:pt-24">
          <h1 className="max-w-[16ch] text-[40px] font-semibold leading-[1.04] tracking-[-0.03em] text-fg sm:text-[60px]">
            Every step your agent took, on one timeline.
          </h1>
          <p className="mt-6 max-w-[60ch] text-[16px] leading-relaxed text-fg-muted sm:text-[17px]">
            Tracewright is a flight recorder for AI agents. It captures each model call and tool call with its prompt, response,
            tokens, cost, and timing, so when a run goes wrong you can see which step broke and why.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href={DEMO_HREF}
              className="inline-flex h-11 items-center rounded-md bg-accent px-5 text-[15px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
            >
              Explore the live demo
            </Link>
            <a
              href={REPO_URL}
              className="inline-flex h-11 items-center gap-2 rounded-md border border-border-strong bg-surface px-5 text-[15px] font-medium text-fg transition-colors hover:bg-surface-2"
            >
              <GithubIcon className="size-4" />
              Read the source
            </a>
          </div>
          <p className="mt-4 text-[13px] text-fg-subtle">No sign-in. The demo is a read-only project with 32 recorded research-agent runs.</p>
        </section>

        <section className="relative mx-auto max-w-[1200px] px-4 pb-20 sm:px-6" aria-label="Example run">
          <HeroRun />
        </section>

        <section className="relative border-t border-border bg-surface/40">
          <div className="mx-auto grid max-w-[1200px] gap-10 px-4 py-16 sm:px-6 md:grid-cols-3">
            <Feature title="Records without getting in the way">
              Add a decorator to your agent and its tools. Spans ship in background batches; if the buffer fills, the SDK drops and
              counts them rather than slowing down or crashing your agent.
            </Feature>
            <Feature title="Shows the shape of a run">
              A waterfall of every span, nested by parent and colored by kind. Select a step to read the exact messages the model saw,
              what it answered, and what that call cost.
            </Feature>
            <Feature title="Speaks OpenTelemetry">
              Spans use the OpenTelemetry GenAI attribute names, so the same traces stay readable by the observability tools you
              already run.
            </Feature>
          </div>
          <div className="mx-auto max-w-[1200px] px-4 pb-16 sm:px-6">
            <p className="max-w-[72ch] border-l-2 border-accent pl-4 text-[14px] leading-relaxed text-fg-muted">
              Next on the roadmap: diff two runs to find the first step where they diverged, replay a run from any step with a
              different model or prompt, and fail CI when a change makes the agent worse, slower, or more expensive.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 px-4 py-6 text-[12.5px] text-fg-subtle sm:px-6">
          <span>Tracewright, built by Maddox Nehls.</span>
          <a href={REPO_URL} className="hover:text-fg">
            Source on GitHub
          </a>
        </div>
      </footer>
    </>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">{children}</p>
    </div>
  );
}

/** A generated run rendered with the real waterfall component. Static: no database needed for the landing page. */
function HeroRun() {
  const run = generateHeroRun();
  const spans = run.spans;
  const root = spans.find((s) => s.parentSpanId === null);
  const win = traceWindow(spans);
  const rows = layoutWaterfall(buildSpanTree(spans), win);
  const ticks = timeTicks(win.totalMs, 6);
  const cost = spans.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  const failed = spans.find((s) => s.status === "error" && s.kind === "tool");
  const retry = failed ? spans.find((s) => s.name === failed.name && s.status === "ok" && s.startTime > failed.startTime) : undefined;

  return (
    <figure className="overflow-hidden rounded-xl border border-border-strong bg-surface shadow-[0_24px_80px_-24px_rgb(0_0_0/0.55)]">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-[14px] font-semibold text-fg">{root?.name}</span>
          <StatusBadge status={run.status} />
        </div>
        <dl className="flex gap-5 text-[12.5px]">
          <Stat label="Duration" value={formatDuration(win.totalMs)} />
          <Stat label="Spans" value={String(spans.length)} />
          <Stat label="Cost" value={formatCost(cost)} />
        </dl>
      </div>
      <div className="border-b border-border px-3 py-2">
        <KindLegend />
      </div>
      <Waterfall rows={rows} timeWindow={win} ticks={ticks} reveal label="Spans of an example research-agent run" />
      {failed && retry && (
        <figcaption className="flex gap-3 border-t border-border bg-err-soft px-4 py-3 text-[13px] leading-relaxed text-fg-muted">
          <span className="mt-1.5 h-2 w-3.5 shrink-0 rounded-[2px] bar-error" aria-hidden />
          <span>
            <span className="font-medium text-fg">The run finished, but {formatDuration(win.totalMs)} is too slow.</span> The waterfall
            shows why: the first <span className="font-mono text-[12.5px] text-fg">{failed.name}</span> call hung for{" "}
            {formatDuration(failed.durationMs)} before timing out, and the retry answered in {formatDuration(retry.durationMs)}.
          </span>
        </figcaption>
      )}
    </figure>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="tabular font-medium text-fg">{value}</dd>
    </div>
  );
}
