import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    {
      source:
        "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
      // Next.js prefetches every visible <Link> in the viewport, including a
      // burst of them the moment a backgrounded tab regains focus. Each one
      // used to hit this proxy and call supabase.auth.getUser(), and several
      // concurrent calls near the access token's refresh window race on the
      // same (single-use) refresh token -- only the first succeeds, the rest
      // get rejected and look like the user was logged out. Excluding
      // prefetch requests here removes that race; real navigations are
      // unaffected, and every page/Server Action still re-checks getUser()
      // itself regardless.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
