import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { SignJWT } from 'npm:jose@5.9.6';
import { isVerifiedServiceRoleJwt, projectRefFromSupabaseUrl } from './serviceRoleJwt.ts';

const SECRET = 'test-jwt-secret-not-a-project-secret';
const KEY = new TextEncoder().encode(SECRET);
const OTHER_KEY = new TextEncoder().encode('different-secret');
const REF = 'byrzshwlentqvktcksem';

function b64url(value: unknown): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return btoa(json).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function sign(
  claims: Record<string, unknown>,
  options: { key?: Uint8Array; issuer?: string; expiresIn?: string } = {},
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(options.issuer ?? 'supabase')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '10y')
    .sign(options.key ?? KEY);
}

Deno.test('signed service_role JWT for this project is accepted', async () => {
  const token = await sign({ role: 'service_role', ref: REF });
  assertEquals(await isVerifiedServiceRoleJwt(token, SECRET, REF), true);
});

Deno.test('service_role JWT with no ref claim is accepted when the signature is valid', async () => {
  const token = await sign({ role: 'service_role' });
  assertEquals(await isVerifiedServiceRoleJwt(token, SECRET, REF), true);
});

Deno.test('ref claim for another project is rejected', async () => {
  const token = await sign({ role: 'service_role', ref: 'otherprojectref' });
  assertEquals(await isVerifiedServiceRoleJwt(token, SECRET, REF), false);
});

Deno.test('authenticated role, wrong secret, missing secret, and expiry are rejected', async () => {
  const user = await sign({ role: 'authenticated', sub: 'user-1', ref: REF });
  const anon = await sign({ role: 'anon', ref: REF });
  const wrongKey = await sign({ role: 'service_role', ref: REF }, { key: OTHER_KEY });
  const expired = await sign({ role: 'service_role', ref: REF }, { expiresIn: '-1h' });
  assertEquals(await isVerifiedServiceRoleJwt(user, SECRET, REF), false);
  assertEquals(await isVerifiedServiceRoleJwt(anon, SECRET, REF), false);
  assertEquals(await isVerifiedServiceRoleJwt(wrongKey, SECRET, REF), false);
  assertEquals(await isVerifiedServiceRoleJwt(expired, SECRET, REF), false);
  assertEquals(await isVerifiedServiceRoleJwt(await sign({ role: 'service_role', ref: REF }), undefined, REF), false);
  assertEquals(await isVerifiedServiceRoleJwt(await sign({ role: 'service_role', ref: REF }), '', REF), false);
});

Deno.test('a user-session issuer is rejected even when role is service_role', async () => {
  const token = await sign(
    { role: 'service_role', ref: REF },
    { issuer: `https://${REF}.supabase.co/auth/v1` },
  );
  assertEquals(await isVerifiedServiceRoleJwt(token, SECRET, REF), false);
});

Deno.test('unverified or tampered payloads are rejected', async () => {
  const unsigned = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    iss: 'supabase',
    role: 'service_role',
    ref: REF,
  })}.e30`;
  const forged = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    iss: 'supabase',
    role: 'service_role',
    ref: REF,
  })}.not-a-signature`;

  const authentic = await sign({ role: 'authenticated', ref: REF });
  const [header, payload, signature] = authentic.split('.');
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (payload.length % 4)) % 4);
  const decoded = JSON.parse(atob(padded));
  decoded.role = 'service_role';
  const tampered = `${header}.${b64url(decoded)}.${signature}`;

  assertEquals(await isVerifiedServiceRoleJwt(unsigned, SECRET, REF), false);
  assertEquals(await isVerifiedServiceRoleJwt(forged, SECRET, REF), false);
  assertEquals(await isVerifiedServiceRoleJwt(tampered, SECRET, REF), false);
  assertEquals(await isVerifiedServiceRoleJwt('not-a-jwt', SECRET, REF), false);
  assertEquals(await isVerifiedServiceRoleJwt('sb_secret_example', SECRET, REF), false);
  assert(authentic.split('.').length === 3);
});

Deno.test('project ref is read only from a supabase.co host', () => {
  assertEquals(
    projectRefFromSupabaseUrl('https://byrzshwlentqvktcksem.supabase.co'),
    'byrzshwlentqvktcksem',
  );
  assertEquals(projectRefFromSupabaseUrl('https://example.com'), null);
  assertEquals(projectRefFromSupabaseUrl(undefined), null);
  assertEquals(projectRefFromSupabaseUrl('not a url'), null);
});

Deno.test('handler keeps the strict key compare and the getUser path', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const gate = src.indexOf('if (bearer !== serviceKey)');
  const jwt = src.indexOf('isVerifiedServiceRoleJwt', gate);
  const getUser = src.indexOf('.auth.getUser(bearer)', gate);
  assert(gate > 0);
  assert(jwt > gate);
  assert(getUser > jwt);
  assert(src.includes("Deno.env.get('SUPABASE_JWT_SECRET')"));
  assert(src.includes(".in('role', ['hr', 'super_admin'])"));
});
