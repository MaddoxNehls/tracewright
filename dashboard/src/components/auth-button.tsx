import { GithubIcon } from "./github-icon";
import { signIn, signOut } from "@/server/auth";
import { getViewerState } from "@/server/viewer";

const buttonClass =
  "inline-flex h-8 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2";

/** Sign-in state for the header. Reads the session, so render it inside <Suspense>. */
export async function AuthButton() {
  const { authEnabled, viewer } = await getViewerState();

  if (!authEnabled) {
    return (
      <span className="group relative inline-flex" tabIndex={0} aria-describedby="signin-disabled-tip">
        <button type="button" disabled className={`${buttonClass} pointer-events-none opacity-50`}>
          <GithubIcon className="size-3.5" />
          <span className="max-sm:sr-only">Sign in</span>
        </button>
        <span
          id="signin-disabled-tip"
          role="tooltip"
          className="pointer-events-none absolute right-0 top-full z-50 mt-2 w-64 rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-xs leading-relaxed text-fg-muted opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          GitHub sign-in isn&apos;t configured on this deployment. Public projects, like the demo, are open to everyone.
        </span>
      </span>
    );
  }

  if (!viewer) {
    return (
      <form
        action={async () => {
          "use server";
          await signIn("github");
        }}
      >
        <button type="submit" className={buttonClass}>
          <GithubIcon className="size-3.5" />
          Sign in with GitHub
        </button>
      </form>
    );
  }

  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
      className="flex items-center gap-2"
    >
      <span className="hidden text-[13px] text-fg-muted sm:inline">{viewer.login}</span>
      <button type="submit" className={buttonClass}>
        Sign out
      </button>
    </form>
  );
}

export function AuthButtonSkeleton() {
  return <span className="skeleton block h-8 w-[84px]" aria-hidden />;
}
