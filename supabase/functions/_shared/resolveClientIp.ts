// Single trusted-header resolution rule for client IP, shared across edge
// functions. cf-connecting-ip is set by Cloudflare from the actual TCP
// connection and cannot be forged by the client no matter what headers it
// sends; x-forwarded-for's leftmost entry can be entirely attacker-authored
// if the client pre-sets that header before the request ever reaches
// Cloudflare (a reverse proxy conventionally appends its own observed
// address to whatever list it received, rather than replacing it). So
// cf-connecting-ip must be checked first, with x-forwarded-for's first hop
// only as a fallback for requests that reach us without going through
// Cloudflare at all, then x-real-ip as a last resort.
//
// Found the hard way: every capture trigger built for the IP-audit
// initiative (2026-09) originally checked x-forwarded-for first, and this
// same ordering bug was independently duplicated three times in
// approve-withdrawal/index.ts. One shared function so this can't happen
// again -- no Welile security function should independently decide how to
// resolve client IP.
export function resolveTrustedClientIp(req: Request): string | null {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null
  );
}

export function getClientUserAgent(req: Request): string | null {
  return req.headers.get("user-agent") || null;
}
