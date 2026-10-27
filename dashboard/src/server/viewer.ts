import "server-only";
import { connection } from "next/server";
import { auth, authEnabled } from "./auth";
import type { Viewer } from "./sql/projects";

export type { Viewer };

/**
 * Reads the Auth.js session. A session is request-time data, so this opts the
 * render out of prerendering first (Auth.js touches crypto before it touches cookies).
 */
async function readSession() {
  await connection();
  return auth();
}

/** The signed-in GitHub user, or null for anonymous visitors (always null when OAuth is not configured). */
export async function getViewer(): Promise<Viewer | null> {
  if (!authEnabled) return null;
  const session = await readSession();
  const login = session?.user?.login;
  return login ? { login } : null;
}

export interface ViewerState {
  authEnabled: boolean;
  viewer: (Viewer & { name: string | null; image: string | null }) | null;
}

export async function getViewerState(): Promise<ViewerState> {
  if (!authEnabled) return { authEnabled, viewer: null };
  const session = await readSession();
  const login = session?.user?.login;
  if (!login) return { authEnabled, viewer: null };
  return { authEnabled, viewer: { login, name: session.user.name ?? null, image: session.user.image ?? null } };
}
