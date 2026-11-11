import { jwtVerify } from 'npm:jose@5.9.6';

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
