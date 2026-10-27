import type { Session } from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import { auth, authEnabled } from "@/server/auth";
import { queryOutsideRender } from "@/server/db";
import { buildVisibleProjectQuery } from "@/server/sql/projects";

/**
 * Answers unknown and private project URLs with a real HTTP 404.
 *
 * Project pages are partially prerendered: the static shell starts streaming
 * (and commits a 200) before the project lookup in the layout finishes, so
 * notFound() there can only render not-found UI. Checking here, before
 * rendering starts, is the one place a status code can still be chosen. The
 * layout keeps its own check for client-side navigations.
 */
async function gate(req: NextRequest & { auth?: Session | null }): Promise<NextResponse> {
  const slug = decodeURIComponent(req.nextUrl.pathname.split("/")[2] ?? "");
  const login = req.auth?.user?.login;
  const rows = await queryOutsideRender<{ id: string }>(buildVisibleProjectQuery(slug, login ? { login } : null));
  if (rows.length > 0) return NextResponse.next();
  // An unmatched path renders the app's not-found page with status 404.
  return NextResponse.rewrite(new URL("/_project-not-found", req.url), { status: 404 });
}

export const proxy = authEnabled ? auth(gate) : gate;

export const config = {
  matcher: ["/p/:slug", "/p/:slug/:path*"],
};
