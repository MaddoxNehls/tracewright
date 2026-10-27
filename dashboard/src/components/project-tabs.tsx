"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function ProjectTabs({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/p/${slug}`;
  const tabs = [
    { href: base, label: "Overview", active: pathname === base },
    { href: `${base}/runs`, label: "Runs", active: pathname.startsWith(`${base}/runs`) || pathname.startsWith(`${base}/compare`) },
  ];
  return (
    <nav aria-label="Project" className="flex h-14 items-stretch gap-1">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? "page" : undefined}
          className={`relative flex items-center px-2.5 text-[13px] font-medium transition-colors ${
            tab.active
              ? "text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
              : "text-fg-muted hover:text-fg"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
