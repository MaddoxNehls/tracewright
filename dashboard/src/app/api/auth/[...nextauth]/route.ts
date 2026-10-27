import type { NextRequest } from "next/server";
import { authEnabled, handlers } from "@/server/auth";

const disabled = () => Response.json({ error: "GitHub sign-in is not configured on this deployment" }, { status: 404 });

export function GET(req: NextRequest) {
  return authEnabled ? handlers.GET(req) : disabled();
}

export function POST(req: NextRequest) {
  return authEnabled ? handlers.POST(req) : disabled();
}
