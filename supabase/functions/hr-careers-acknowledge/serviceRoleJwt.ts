import { decodeJwt, jwtVerify } from 'npm:jose@5.9.6';

/**
 * True when `token` is an HS256 JWT signed with this project's JWT secret
 * and its verified role claim is `service_role`.
 *
 * The secret is `SUPABASE_JWT_SECRET` when the caller passes that env value.
 * There is no shared verifier under supabase/functions/_shared that checks a
 * signature (requireServiceRole.ts only compares the env key or probes the
 * auth admin API). A decoded payload is never trusted: jwtVerify must succeed
 * before `role` is read. A missing secret, a non-JWT, a bad signature, an
 * unexpected algorithm, or any role other than service_role returns false.
 *
 * Legacy service-role API keys use issuer `supabase`. User session tokens,
 * which are signed with the same secret, use the Auth issuer and role
 * `authenticated`, so they stay on the caller's existing getUser path.
 * When both a project ref and a `ref` claim are present they must match.
 *
 * When that secret is not available, `isProvenLegacyServiceRoleJwt` is the
 * fallback. Decoding the payload is still not proof.
 */
export async function isVerifiedServiceRoleJwt(
  token: string,
  jwtSecret: string | undefined,
  projectRef?: string | null,
): Promise<boolean> {
  if (!jwtSecret) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return false;

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      algorithms: ['HS256'],
      issuer: 'supabase',
    });
    if (payload.role !== 'service_role') return false;
    if (projectRef && 'ref' in payload && payload.ref !== projectRef) return false;
    return true;
  } catch {
    return false;
  }
}

/** Project ref from `https://<ref>.supabase.co`, or null for any other host. */
export function projectRefFromSupabaseUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (!host.endsWith('.supabase.co')) return null;
    const ref = host.split('.')[0];
    return ref || null;
  } catch {
    return null;
  }
}

/**
 * SHA-256 hashes of tokens this isolate has already proven. The token itself
 * is never stored. Failures are not cached, so a later 200 can still succeed.
 */
const provenLegacyServiceRoleHashes = new Set<string>();

/** Drops in-memory proofs. Tests call this so cases do not share a cache. */
export function clearProvenLegacyServiceRoleCache(): void {
  provenLegacyServiceRoleHashes.clear();
}

function untrustedPayload(token: string): Record<string, unknown> | null {
  try {
    return decodeJwt(token) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * True when an unverified payload's role claim is `service_role`.
 * This is not authentication. Callers use it only to keep a failed legacy
 * proof on the 401 path instead of treating the token as a user session.
 */
export function hasUntrustedServiceRoleClaim(token: string): boolean {
  return untrustedPayload(token)?.role === 'service_role';
}

/**
 * Structural checks only. A true result means the token may be sent to Auth
 * for proof. A false result must not cause a fetch.
 */
function legacyClaimsAllowProof(
  token: string,
  supabaseUrl: string | undefined,
  nowMs: number,
): boolean {
  const projectRef = projectRefFromSupabaseUrl(supabaseUrl);
  if (!projectRef) return false;
  const payload = untrustedPayload(token);
  if (!payload) return false;
  if (payload.role !== 'service_role') return false;
  if (payload.ref !== projectRef) return false;
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  // `exp` is seconds since the epoch. The token is expired at that instant.
  if (exp <= Math.floor(nowMs / 1000)) return false;
  return true;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type LegacyServiceRoleProofOptions = {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  nowMs?: number;
};

/**
 * Prove a legacy service_role JWT when signature verification is unavailable.
 *
 * The payload is decoded and not trusted. `role` must be `service_role`,
 * `ref` must equal the project ref in `supabaseUrl`, and `exp` must still be
 * in the future. Only then is the token presented to this project's
 * service-role-only Auth admin API (`GET /auth/v1/admin/users?per_page=1`,
 * `apikey` and `Authorization` set from the token). HTTP 200 is the only
 * acceptance. A positive result is cached for the life of this isolate under
 * a hash of the token. The token is never logged.
 */
export async function isProvenLegacyServiceRoleJwt(
  token: string,
  supabaseUrl: string | undefined,
  options: LegacyServiceRoleProofOptions = {},
): Promise<boolean> {
  const nowMs = options.nowMs ?? Date.now();
  if (!legacyClaimsAllowProof(token, supabaseUrl, nowMs)) return false;

  const base = supabaseUrl?.replace(/\/+$/, '');
  if (!base) return false;

  let hash: string;
  try {
    hash = await sha256Hex(token);
  } catch {
    return false;
  }
  if (provenLegacyServiceRoleHashes.has(hash)) return true;

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${base}/auth/v1/admin/users?per_page=1`, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: {
        apikey: token,
        Authorization: `Bearer ${token}`,
      },
    });
    try {
      await res.body?.cancel();
    } catch {
      // Discarding the body must not change the status decision.
    }
    if (res.status !== 200) return false;
    provenLegacyServiceRoleHashes.add(hash);
    return true;
  } catch {
    return false;
  }
}
