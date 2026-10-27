import Link from "next/link";

/**
 * The mark is a flight recorder seen head-on: an orange box with a trace line
 * running through it.
 */
export function LogoMark({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="var(--accent)" />
      <path
        d="M5 14h3.2l1.6-5 2.4 9 2-6.5 1.3 2.5H19"
        fill="none"
        stroke="var(--accent-fg)"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 rounded-md font-semibold tracking-tight text-fg">
      <LogoMark />
      <span className="text-[15px]">Tracewright</span>
    </Link>
  );
}
