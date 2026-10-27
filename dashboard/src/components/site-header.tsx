import { Suspense, type ReactNode } from "react";
import { AuthButton, AuthButtonSkeleton } from "./auth-button";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";

/** Top bar shared by every page. `children` is the page-specific middle (breadcrumbs, project nav). */
export function SiteHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4 sm:gap-5 sm:px-6">
        <Logo />
        <div className="flex min-w-0 flex-1 items-center gap-4">{children}</div>
        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <Suspense fallback={<AuthButtonSkeleton />}>
            <AuthButton />
          </Suspense>
        </div>
      </div>
    </header>
  );
}
