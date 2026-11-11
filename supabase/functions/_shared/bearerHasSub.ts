// Calling auth.getUser() with the anon key, an empty token or a token without a
// user (no "sub" claim) always fails with 403 "invalid claim: missing sub
// claim". These helpers skip that network call and return the same "no user"
// shape, so each function's existing "not signed in" path runs instead.

/** True when the Authorization header (or raw token) is a JWT that names a user. */
export function bearerHasSub(headerOrToken: string | null | undefined): boolean {
  const raw = String(headerOrToken ?? "").replace(/^Bearer\s+/i, "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  try {
    let s = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const claims = JSON.parse(atob(s));
    return typeof claims?.sub === "string" && claims.sub.length > 0;
  } catch {
    return false;
  }
}

/** Same result shape as a failed auth.getUser(). */
// deno-lint-ignore no-explicit-any
export function noUserResult(): Promise<any> {
  return Promise.resolve({
    data: { user: null },
    error: { name: "AuthSessionMissingError", message: "Auth session missing!", status: 401 },
  });
}
