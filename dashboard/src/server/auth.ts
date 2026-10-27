import NextAuth, { type DefaultSession } from "next-auth";
import GitHub from "next-auth/providers/github";

declare module "next-auth" {
  interface Session {
    user: { login?: string } & DefaultSession["user"];
  }
}

/**
 * GitHub OAuth is optional. Without credentials the dashboard still runs:
 * only public projects are listed and sign-in is shown as unavailable.
 */
export const authEnabled = Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: authEnabled ? [GitHub] : [],
  session: { strategy: "jwt" },
  trustHost: true,
  callbacks: {
    jwt({ token, profile }) {
      // `profile` is only present on the sign-in callback; persist the login into the JWT.
      if (profile && typeof profile.login === "string") token.login = profile.login.toLowerCase();
      return token;
    },
    session({ session, token }) {
      if (typeof token.login === "string") session.user.login = token.login;
      return session;
    },
  },
});
