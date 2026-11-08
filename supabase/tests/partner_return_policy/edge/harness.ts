// Shared harness for the Partner Returns Phase 4 edge handler tests (design v2 section 10.2).
// * captures Deno.serve so the real index.ts files can be imported and called as handlers;
// * stubs fetch (email dispatch, SMS providers, notify-managers, the AI gateway) and records each call
//   in the fake's ordered log;
// * makes a run deterministic (fixed clock, seeded Math.random / crypto) so the origin/lovable copy and
//   the new file can be compared call by call (E11);
// * models the Partner Returns gate on investor_portfolios (Phase 1/2) for the switch off and on.
// deno-lint-ignore-file no-explicit-any
import { fakeUuid, type LogEntry, reset, type Row, state, table, uidOf } from "./fake_supabase.ts";

export { fail, ok, reset, state, table } from "./fake_supabase.ts";
export type { LogEntry, Row } from "./fake_supabase.ts";

export const SUPABASE_URL = "http://supabase.test";
export const SERVICE_KEY = "service-role-key";
export const ANON_KEY = "anon-key";

for (const [k, v] of Object.entries({
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SUPABASE_ANON_KEY: ANON_KEY,
  LOVABLE_API_KEY: "lovable-key",
  YOOLA_SMS_API_KEY: "yoola-key",
  AFRICASTALKING_API_KEY: "at-key",
  AFRICASTALKING_USERNAME: "welile",
  MAILGUN_API_KEY: "mg-key",
  MAILGUN_DOMAIN: "mg.test",
  ASSISTANT_SCOPE_PRECHECK: "on",
})) Deno.env.set(k, v);

// ---------------------------------------------------------------------------------------------------
// fetch stub (installed before any edge module loads, so smsFooterInterceptor wraps it)

export type FetchAnswer = { status?: number; json?: unknown; text?: string };
export const fetchRoutes: { match: (url: string) => boolean; answer: (url: string, body: any) => FetchAnswer }[] = [];
/** Queue of AI gateway replies (chat completions), consumed in order. */
export const aiReplies: unknown[] = [];
export const aiRequests: any[] = [];

function parseBody(body: unknown): unknown {
  if (body === undefined || body === null) return null;
  const text = typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : null;
  if (text === null) return "[binary]";
  try { return JSON.parse(text); } catch { /* form or text */ }
  if (text.includes("=") && !text.includes(" ")) return Object.fromEntries(new URLSearchParams(text));
  return text;
}

const stubFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const body = parseBody(init?.body);
  const entry: LogEntry = { kind: "fetch", name: url, payload: body, options: { method: init?.method ?? "GET" } };
  state.log.push(entry);
  let ans: FetchAnswer | null = null;
  for (const r of fetchRoutes) if (r.match(url)) { ans = r.answer(url, body); break; }
  if (!ans) {
    if (url.includes("ai.gateway.lovable.dev")) {
      aiRequests.push(body);
      const next = aiReplies.shift();
      ans = next ? { json: next } : { status: 500, json: { error: "no AI reply queued" } };
    } else if (url.includes("yoolasms.com")) ans = { json: { status: "success" } };
    else if (url.includes("africastalking.com")) ans = { status: 201, json: { SMSMessageData: { Recipients: [{ status: "Success" }] } } };
    else ans = { json: { success: true } };
  }
  const text = ans.text ?? JSON.stringify(ans.json ?? {});
  return Promise.resolve(new Response(text, { status: ans.status ?? 200, headers: { "Content-Type": "application/json" } }));
};
Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: stubFetch });

// ---------------------------------------------------------------------------------------------------
// Deno.serve capture + handler loading

export type Handler = (req: Request) => Promise<Response>;
let captured: Handler | null = null;
Object.defineProperty(Deno, "serve", {
  configurable: true,
  writable: true,
  value: (a: unknown, b?: unknown) => {
    captured = (typeof a === "function" ? a : b) as Handler;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {} };
  },
});

const FUNCTIONS = new URL("../../../functions/", import.meta.url);
const ORIGIN = new URL("./fixtures/origin/functions/", import.meta.url);
const handlerCache = new Map<string, Handler>();

/** Imports supabase/functions/<fn>/index.ts (or the origin/lovable copy) once and returns its handler.
 *  The specifier is computed, so the edge files are not type-checked as part of the test graph. */
export async function loadHandler(fn: string, which: "new" | "origin" = "new"): Promise<Handler> {
  const url = new URL(`${fn}/index.ts`, which === "new" ? FUNCTIONS : ORIGIN).href;
  const hit = handlerCache.get(url);
  if (hit) return hit;
  captured = null;
  await import(url);
  if (!captured) throw new Error(`${fn} (${which}) did not call Deno.serve`);
  handlerCache.set(url, captured);
  return captured;
}

/** Loads a variant of <fn>/index.ts (new or origin copy) whose source text `edit` changes (e.g. a disabled
 *  flag turned on), without writing a file: the edited text is imported from a data: URL with its relative
 *  imports made absolute, so it shares every other module (and its state) with the real file. */
export async function loadHandlerVariant(fn: string, which: "new" | "origin", edit: (src: string) => string): Promise<Handler> {
  const file = new URL(`${fn}/index.ts`, which === "new" ? FUNCTIONS : ORIGIN);
  const before = await Deno.readTextFile(file);
  const src = edit(before);
  if (src === before) throw new Error(`${fn} (${which}): the edit changed nothing`);
  const absolute = src.replace(/((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (_m, pre, q, spec) => `${pre}${q}${new URL(spec, file).href}${q}`);
  const bytes = new TextEncoder().encode(absolute);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  // A data: URL module is evaluated once per specifier, so the same variant is cached like loadHandler.
  const url = `data:application/typescript;base64,${btoa(bin)}`;
  const hit = handlerCache.get(url);
  if (hit) return hit;
  captured = null;
  await import(url);
  if (!captured) throw new Error(`${fn} (${which}, variant) did not call Deno.serve`);
  handlerCache.set(url, captured);
  return captured;
}

/** Imports a module from supabase/functions (same URL the edge files use, so module state is shared). */
export function functionsModule(path: string): Promise<any> {
  return import(new URL(path, FUNCTIONS).href);
}

// ---------------------------------------------------------------------------------------------------
// determinism

export const FIXED_NOW = Date.parse("2026-11-07T09:00:00.000Z");
const RealDate = Date;
const realRandom = Math.random;
const realUuid = crypto.randomUUID.bind(crypto);
const realGrv = crypto.getRandomValues.bind(crypto);
let seed = 1;
const prng = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

class FixedDate extends RealDate {
  constructor(...args: any[]) {
    super(...((args.length === 0 ? [FIXED_NOW] : args) as [any]));
  }
  static override now() { return FIXED_NOW; }
}

let depth = 0;
function patch() {
  if (depth++ > 0) return;
  seed = 1;
  let uuidN = 0;
  (globalThis as any).Date = FixedDate;
  Math.random = prng;
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true, writable: true,
    value: () => `c0000000-0000-4000-8000-${String(++uuidN).padStart(12, "0")}`,
  });
  Object.defineProperty(crypto, "getRandomValues", {
    configurable: true, writable: true,
    value: <T extends ArrayBufferView>(arr: T): T => {
      const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(prng() * 256);
      return arr;
    },
  });
}
function unpatch() {
  if (--depth > 0) return;
  (globalThis as any).Date = RealDate;
  Math.random = realRandom;
  Object.defineProperty(crypto, "randomUUID", { configurable: true, writable: true, value: realUuid });
  Object.defineProperty(crypto, "getRandomValues", { configurable: true, writable: true, value: realGrv });
}

/** Runs fn under the same fixed clock and seeds as call() (e.g. to prime the policy cache). */
export async function deterministic<T>(fn: () => Promise<T>): Promise<T> {
  patch();
  try { return await fn(); } finally { unpatch(); }
}

const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
export const consoleBuffer: string[] = [];
function silence() {
  const keep = (...a: unknown[]) => { consoleBuffer.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.log = keep; console.warn = keep; console.error = keep; console.info = keep;
}
function unsilence() { Object.assign(console, quiet); }

/** Lets fire-and-forget work (unawaited inserts, fetches) finish before the log is read. */
export async function flush() {
  let last = -1, stable = 0;
  for (let i = 0; i < 60 && stable < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (state.log.length === last) stable++;
    else { stable = 0; last = state.log.length; }
  }
}

export interface CallResult { status: number; body: any; headers: Headers }

export async function call(h: Handler, opts: {
  body?: unknown;
  jwt?: string;
  headers?: Record<string, string>;
  method?: string;
  rawBody?: string;
} = {}): Promise<CallResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  if (opts.jwt) headers.Authorization = `Bearer ${opts.jwt}`;
  const method = opts.method ?? "POST";
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  patch();
  silence();
  try {
    const res = await h(new Request("http://edge.test/fn", { method, headers, body }));
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* text */ }
    await flush();
    return { status: res.status, body: parsed, headers: res.headers };
  } finally {
    unsilence();
    unpatch();
  }
}

// ---------------------------------------------------------------------------------------------------
// the Partner Returns policy and gate (models Phase 1/2 for the fake database)

export const POLICY_OFF = {
  enabled: false, new_contract_rate: 15, policy_rate: 10, legacy_rate: 15, existing_partner_mode: "own",
  existing_partner_cap: null, employee_rate: 20, cutoff_at: null, enabled_at: null, updated_at: "2026-11-05T00:00:00Z",
};
export const POLICY_ON = {
  ...POLICY_OFF, enabled: true, new_contract_rate: 10,
  cutoff_at: "2026-11-06T00:00:00Z", enabled_at: "2026-11-06T00:00:00Z", updated_at: "2026-11-06T00:00:00Z",
};
/** Switched on once (the cut-off is set and never moves), then off again: personal-rate rules still hold. */
export const POLICY_OFF_AFTER_CUTOFF = {
  ...POLICY_ON, enabled: false, new_contract_rate: 15, updated_at: "2026-11-06T12:00:00Z",
};

export interface GateConfig {
  enabled: boolean;
  /** The person's own rate and basis when the switch is on (default: new partner, 10). */
  person?: (investorId: string | null) => { rate: number; basis: string };
}

/** The database gate on investor_portfolios: a missing rate gets the person's rate; a typed rate that
 *  differs (switch on) is stored at the person's rate and queued for the CFO with the requester from
 *  the x-welile-actor header (service role) or auth.uid() (user JWT). */
export function installPortfolioGate(cfg: GateConfig) {
  state.onInsert.investor_portfolios = (input, ctx) => {
    // Column default: the database generates an activation token when none is sent.
    const row: Row = { ...input, activation_token: input.activation_token ?? `token-${input.id}` };
    const typed = row.roi_percentage === undefined || row.roi_percentage === null ? null : Number(row.roi_percentage);
    if (!cfg.enabled) {
      return { ...row, roi_percentage: typed ?? 15, rate_basis: typed === null ? "switch_off" : "typed_switch_off" };
    }
    const person = row.investor_id
      ? (cfg.person?.(row.investor_id) ?? { rate: 10, basis: "new" })
      : { rate: 10, basis: "new_no_investor" };
    if (typed !== null && Math.round(typed * 100) !== Math.round(person.rate * 100)) {
      const requester = ctx.client.role === "service"
        ? (ctx.client.headers["x-welile-actor"] ?? null)
        : uidOf(ctx.client);
      table("portfolio_rate_approvals").push({
        id: fakeUuid(), portfolio_id: row.id, requested_rate: typed, current_rate: person.rate,
        status: "pending", source: "new_portfolio", requested_by: requester,
      });
    }
    return { ...row, roi_percentage: person.rate, rate_basis: person.basis };
  };
}

export function policyRpc(policy: unknown) {
  state.rpc.get_partner_return_policy = () => ({ data: policy, error: null });
}

/** partner_confirmed_login_emails from a user id -> email map. */
export function loginEmailsRpc(map: Record<string, string>) {
  state.rpc.partner_confirmed_login_emails = (args: { p_ids: string[] }) => ({
    data: (args?.p_ids ?? []).filter((id) => map[id]).map((id) => ({ user_id: id, email: map[id] })),
    error: null,
  });
}

/** A signed-in user: JWT -> user, plus roles. */
export function signIn(jwt: string, user: Row, roles: string[] = []) {
  state.users.set(jwt, user);
  for (const role of roles) table("user_roles").push({ id: fakeUuid(), user_id: user.id, role, enabled: true });
}

// ---------------------------------------------------------------------------------------------------
// log helpers

export const writes = (kind?: LogEntry["kind"], name?: string) =>
  state.log.filter((e) => (!kind || e.kind === kind) && (!name || e.table === name || e.name === name));
export const rpcCalls = (name: string) => state.log.filter((e) => e.kind === "rpc" && e.name === name);
export const emails = () =>
  state.log.filter((e) => e.kind === "fetch" && String(e.name).endsWith("/functions/v1/send-transactional-email"))
    .map((e) => e.payload);
export const invokes = (name: string) => state.log.filter((e) => e.kind === "invoke" && e.name === name).map((e) => e.payload);
export const inserted = (t: string) => state.log.filter((e) => e.kind === "insert" && e.table === t && !e.error);

export function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(canon(actual)), b = JSON.stringify(canon(expected));
  if (a !== b) throw new Error(`${what}:\n  expected ${b}\n  got      ${a}`);
}
export function ok_(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

/** Canonical form: object keys sorted, undefined dropped (JSON semantics). */
export function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Row = {};
    for (const k of Object.keys(v as Row).sort()) if ((v as Row)[k] !== undefined) out[k] = canon((v as Row)[k]);
    return out;
  }
  return v;
}

export { reset as resetFake, uidOf };
