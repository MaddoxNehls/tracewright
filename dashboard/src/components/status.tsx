import { CircleAlert, CircleCheck } from "lucide-react";
import type { RunStatus } from "@/lib/types";

/** Status is always icon + word, never color alone. */
export function StatusBadge({ status, size = "sm" }: { status: RunStatus; size?: "sm" | "md" }) {
  const Icon = status === "error" ? CircleAlert : CircleCheck;
  const text = size === "md" ? "text-[13px]" : "text-xs";
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${text} ${status === "error" ? "text-err" : "text-ok"}`}>
      <Icon className={size === "md" ? "size-4" : "size-3.5"} aria-hidden />
      {status === "error" ? "Error" : "OK"}
    </span>
  );
}
