import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { SignJWT } from 'npm:jose@5.9.6';
import {
  clearProvenLegacyServiceRoleCache,
  hasUntrustedServiceRoleClaim,
  isProvenLegacyServiceRoleJwt,
  isVerifiedServiceRoleJwt,
  projectRefFromSupabaseUrl,
} from './serviceRoleJwt.ts';

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
  const proven = src.indexOf('isProvenLegacyServiceRoleJwt', jwt);
  const claimGate = src.indexOf('hasUntrustedServiceRoleClaim', proven);
  const getUser = src.indexOf('.auth.getUser(bearer)', claimGate);
  assert(gate > 0);
  assert(jwt > gate);
  assert(proven > jwt);
  assert(claimGate > proven);
  assert(getUser > claimGate);
  assert(src.includes("Deno.env.get('SUPABASE_JWT_SECRET')"));
  assert(src.includes('!jwtSecret &&'));
  assert(src.includes(".in('role', ['hr', 'super_admin'])"));
  assert(src.includes('enqueue_email'));
  assert(!/console\.(log|error|warn|info|debug)\([^)\n]*bearer/.test(src));
  const helper = await Deno.readTextFile(new URL('./serviceRoleJwt.ts', import.meta.url));
  assert(!helper.includes('console.'));
});

const PROJECT_URL = `https://${REF}.supabase.co`;
const NOW_MS = 1_700_000_000_000;

function legacyToken(claims: Record<string, unknown>, exp = Math.floor(NOW_MS / 1000) + 3600): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    iss: 'supabase',
    exp,
    ...claims,
  })}.sig`;
}

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(status: number, calls: FetchCall[], explode = false): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    calls.push({ url: input, init });
    if (explode) return Promise.reject(new Error('network down'));
    return Promise.resolve(new Response('{"users":[]}', { status }));
  };
}

function silenceConsole(): () => void {
  const methods = ['log', 'error', 'warn', 'info', 'debug'] as const;
  const previous = methods.map((name) => console[name]);
  for (const name of methods) console[name] = () => {};
  return () => {
    methods.forEach((name, index) => {
      console[name] = previous[index];
    });
  };
}

Deno.test('legacy service_role JWT is accepted only when Auth returns 200', async () => {
  clearProvenLegacyServiceRoleCache();
  const token = legacyToken({ role: 'service_role', ref: REF });
  const calls: FetchCall[] = [];
  const restore = silenceConsole();
  try {
    const accepted = await isProvenLegacyServiceRoleJwt(token, PROJECT_URL, {
      nowMs: NOW_MS,
      fetchImpl: mockFetch(200, calls),
    });
    assertEquals(accepted, true);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, `${PROJECT_URL}/auth/v1/admin/users?per_page=1`);
    assert(!calls[0].url.includes(token));
    assertEquals(calls[0].init?.method, 'GET');
    assertEquals(calls[0].init?.redirect, 'manual');
    const headers = new Headers(calls[0].init?.headers);
    assertEquals(headers.get('apikey'), token);
    assertEquals(headers.get('Authorization'), `Bearer ${token}`);

    const again = await isProvenLegacyServiceRoleJwt(token, `${PROJECT_URL}/`, {
      nowMs: NOW_MS,
      fetchImpl: mockFetch(401, calls),
    });
    assertEquals(again, true);
    assertEquals(calls.length, 1);

    const slashCalls: FetchCall[] = [];
    const other = legacyToken({ role: 'service_role', ref: REF, jti: 'trailing-slash' });
    assertEquals(await isProvenLegacyServiceRoleJwt(other, `${PROJECT_URL}/`, {
      nowMs: NOW_MS,
      fetchImpl: mockFetch(200, slashCalls),
    }), true);
    assertEquals(slashCalls.length, 1);
    assertEquals(slashCalls[0].url, `${PROJECT_URL}/auth/v1/admin/users?per_page=1`);
    assert(!slashCalls[0].url.includes(other));
  } finally {
    restore();
    clearProvenLegacyServiceRoleCache();
  }
});

Deno.test('Auth 401 and 403 reject a legacy service_role JWT and are not cached', async () => {
  for (const status of [401, 403]) {
    clearProvenLegacyServiceRoleCache();
    const token = legacyToken({ role: 'service_role', ref: REF });
    const calls: FetchCall[] = [];
    const first = await isProvenLegacyServiceRoleJwt(token, PROJECT_URL, {
      nowMs: NOW_MS,
      fetchImpl: mockFetch(status, calls),
    });
    const second = await isProvenLegacyServiceRoleJwt(token, PROJECT_URL, {
      nowMs: NOW_MS,
      fetchImpl: mockFetch(status, calls),
    });
    assertEquals(first, false);
    assertEquals(second, false);
    assertEquals(calls.length, 2);
  }
  clearProvenLegacyServiceRoleCache();
});

Deno.test('a non-200 success and a network failure are rejected', async () => {
  clearProvenLegacyServiceRoleCache();
  const token = legacyToken({ role: 'service_role', ref: REF });
  const calls: FetchCall[] = [];
  assertEquals(await isProvenLegacyServiceRoleJwt(token, PROJECT_URL, {
    nowMs: NOW_MS,
    fetchImpl: mockFetch(204, calls),
  }), false);
  assertEquals(await isProvenLegacyServiceRoleJwt(token, PROJECT_URL, {
    nowMs: NOW_MS,
    fetchImpl: mockFetch(500, calls, true),
  }), false);
  assertEquals(calls.length, 2);
  clearProvenLegacyServiceRoleCache();
});

Deno.test('wrong role, wrong ref, missing ref, and expiry are rejected before fetch', async () => {
  clearProvenLegacyServiceRoleCache();
  const calls: FetchCall[] = [];
  const fetchImpl = mockFetch(200, calls);
  const future = Math.floor(NOW_MS / 1000) + 60;
  const cases = [
    legacyToken({ role: 'authenticated', ref: REF }, future),
    legacyToken({ role: 'anon', ref: REF }, future),
    legacyToken({ role: 'service_role', ref: 'otherprojectref' }, future),
    legacyToken({ role: 'service_role' }, future),
    legacyToken({ role: 'service_role', ref: REF }, Math.floor(NOW_MS / 1000)),
    legacyToken({ role: 'service_role', ref: REF }, Math.floor(NOW_MS / 1000) - 1),
    `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
      iss: 'supabase',
      role: 'service_role',
      ref: REF,
    })}.sig`,
    'not-a-jwt',
  ];
  for (const token of cases) {
    assertEquals(await isProvenLegacyServiceRoleJwt(token, PROJECT_URL, { nowMs: NOW_MS, fetchImpl }), false);
  }
  assertEquals(
    await isProvenLegacyServiceRoleJwt(
      legacyToken({ role: 'service_role', ref: REF }, future),
      'https://example.com',
      { nowMs: NOW_MS, fetchImpl },
    ),
    false,
  );
  assertEquals(calls.length, 0);
  assertEquals(hasUntrustedServiceRoleClaim(cases[0]), false);
  assertEquals(hasUntrustedServiceRoleClaim(cases[2]), true);
  assertEquals(hasUntrustedServiceRoleClaim('not-a-jwt'), false);
  clearProvenLegacyServiceRoleCache();
});
