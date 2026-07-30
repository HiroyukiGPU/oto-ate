import { NextResponse } from "next/server";

// Runs per-request (never statically cached) so this can't get baked into a
// build-time-optimized response. Only server/host-server.ts ever sets
// OTO_ATE_HOST_MODE — Vercel never does — so on the deployed site this
// proxy is a provable no-op and every page keeps using firebaseBackend.
// See src/lib/sync/backend.ts for the client-side read of this cookie.
export function proxy() {
  const response = NextResponse.next();
  if (process.env.OTO_ATE_HOST_MODE === "1") {
    response.cookies.set("oto-ate-mode", "local", { httpOnly: false, sameSite: "lax" });
  }
  return response;
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
