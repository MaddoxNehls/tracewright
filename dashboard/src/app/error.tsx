"use client";

import { ErrorPanel } from "@/components/error-panel";

export default function RootError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="px-4">
      <ErrorPanel {...props} />
    </main>
  );
}
