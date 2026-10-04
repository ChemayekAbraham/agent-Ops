/**
 * Guard for edge functions that are only ever called by the system itself
 * (pg_net from a SQL function / pg_cron) and must never be callable by a
 * browser or anyone holding the public anon key.
 *
 * The anon key ships in the client bundle, so "has a Bearer token" is not
 * authentication. This requires the SERVICE ROLE key: either an exact match
 * with SUPABASE_SERVICE_ROLE_KEY, or a token the auth admin API accepts (which
 * only a service-role key passes), so a legacy-format key kept in the vault
 * still works after a key rotation.
 *
 * Returns a Response to send back when the caller is refused, or null to go on.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function requireServiceRole(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const refuse = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return refuse(401, 'Unauthorized');

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (serviceKey && safeEqual(token, serviceKey)) return null;

  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/admin/users?per_page=1`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel();
    if (res.ok) return null;
  } catch (_) {
    // fall through to refuse
  }
  return refuse(401, 'Unauthorized');
}
