// In-memory stand-in for supabase-js (Partner Returns Phase 4 edge handler tests, design v2 section 10.2).
// import_map.json maps every supabase-js specifier the edge functions use onto this file, so the real
// index.ts files run unchanged. Extends the security branch's fake (5e2ad5e930,
// promissory_note_link_security/edge) with:
//   * an rpc dispatch table (unknown functions answer { data: null, error: null } unless
//     state.unknownRpcIsMissing is set, then PGRST202 like PostgREST);
//   * insert/update/upsert/delete with .select() returning the stored rows, defaultToNull, onConflict,
//     ignoreDuplicates, table hooks (the Partner Returns gate is one) and injected failures;
//   * PostgREST filters: eq, neq, gt, gte, lt, lte, in, is, not, or, like, ilike, contains, match, filter;
//     order, limit, range, single, maybeSingle, count/head;
//   * column projection for select lists (embedded resources are read from the row itself);
//   * auth.getUser (JWT from the argument or the client's Authorization header), auth.admin.*;
//   * functions.invoke capture;
//   * per-client headers (x-welile-actor, Authorization) recorded on every logged call;
//   * an ordered log of every write, rpc and invoke, and a read log of every select.
// deno-lint-ignore-file no-explicit-any
export type Row = Record<string, any>;
export interface ApiError { code?: string; message: string; details?: string | null; hint?: string | null; status?: number }
export interface ClientMeta { id: number; key: string; role: "service" | "anon" | "other"; headers: Record<string, string> }
export interface LogEntry {
  kind: "insert" | "update" | "upsert" | "delete" | "rpc" | "invoke" | "fetch" | "auth";
  table?: string;
  name?: string;
  payload?: any;
  stored?: Row[];
  filters?: string[];
  options?: any;
  client?: ClientMeta;
  rows?: number;
  error?: ApiError | null;
  result?: any;
}
export interface ReadEntry { table: string; select: string; filters: string[]; client: ClientMeta; rows: number; error?: ApiError | null }
export interface RpcCtx { client: ClientMeta; state: FakeState; uid: string | null }
export type RpcHandler = (args: any, ctx: RpcCtx) => { data?: any; error?: ApiError | null } | Promise<{ data?: any; error?: ApiError | null }>;
export interface InsertCtx { client: ClientMeta; state: FakeState; batch: Row[]; index: number; options: any }
export interface FakeState {
  tables: Record<string, Row[]>;
  log: LogEntry[];
  reads: ReadEntry[];
  rpc: Record<string, RpcHandler>;
  /** JWT -> user object (auth.getUser). */
  users: Map<string, Row>;
  /** auth.admin users. */
  authUsers: Row[];
  clients: ClientMeta[];
  serviceKey: string;
  anonKey: string;
  /** Called for every row about to be stored (after defaults). Return the row to store, or an error. */
  onInsert: Record<string, (row: Row, ctx: InsertCtx) => Row | ApiError>;
  /** Called after a batch is stored (e.g. the gate queues CFO requests). */
  afterInsert: Record<string, (rows: Row[], ctx: InsertCtx) => void>;
  /** Injected failures. Return an error to fail the whole statement. */
  failInsert?: (table: string, rows: Row[], options: any) => ApiError | null;
  failUpdate?: (table: string, payload: Row, filters: string[]) => ApiError | null;
  failSelect?: (table: string, filters: string[]) => ApiError | null;
  /** Reverse the order of rows returned by insert().select() (tests that results are matched by id). */
  reverseInsertReturn: boolean;
  /** Unique keys per table (insert conflicts -> 23505; upsert default conflict target). */
  unique: Record<string, string[][]>;
  invoke: Record<string, (body: any) => { data?: any; error?: any }>;
  authCreateUser?: (attrs: Row) => { data: any; error: any } | null;
  unknownRpcIsMissing: boolean;
  /** Hook run before every update (race simulations). */
  beforeUpdate?: (table: string) => void;
  /** auth.getUser waits for this before answering (tests that a read runs in parallel with it). */
  getUserGate?: () => Promise<void>;
  uuidCounter: number;
  clock: () => string;
}

const freshState = (): FakeState => ({
  tables: {},
  log: [],
  reads: [],
  rpc: {},
  users: new Map(),
  authUsers: [],
  clients: [],
  serviceKey: "service-role-key",
  anonKey: "anon-key",
  onInsert: {},
  afterInsert: {},
  failInsert: undefined,
  failUpdate: undefined,
  failSelect: undefined,
  authCreateUser: undefined,
  beforeUpdate: undefined,
  getUserGate: undefined,
  reverseInsertReturn: false,
  unique: { user_roles: [["user_id", "role"]] },
  invoke: {},
  unknownRpcIsMissing: false,
  uuidCounter: 0,
  clock: () => new Date().toISOString(),
});

export const state: FakeState = freshState();

export function reset(): FakeState {
  Object.assign(state, freshState());
  return state;
}

export function table(name: string): Row[] {
  return state.tables[name] ?? (state.tables[name] = []);
}

/** Deterministic ids for rows the fake creates itself. */
export function fakeUuid(): string {
  state.uuidCounter++;
  return `f0000000-0000-4000-8000-${String(state.uuidCounter).padStart(12, "0")}`;
}

export const ok = (data: any) => ({ data, error: null });
export const fail = (code: string, message: string) => ({ data: null, error: { code, message, details: null, hint: null } });

// ---------------------------------------------------------------------------------------------------
// Filters

const parseValue = (v: string): unknown => {
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
};

const looseEq = (a: unknown, b: unknown) => {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
};

const cmp = (a: unknown, b: unknown): number => {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  const na = Number(a), nb = Number(b);
  if (typeof a !== "string" || typeof b !== "string") {
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  }
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

const likeToRegex = (pattern: string, flags: string) =>
  new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$", flags);

function contains(container: unknown, part: unknown): boolean {
  if (part === null || typeof part !== "object") return looseEq(container, part);
  if (Array.isArray(part)) {
    return Array.isArray(container) && part.every((p) => container.some((c) => contains(c, p)));
  }
  if (!container || typeof container !== "object") return false;
  return Object.entries(part as Row).every(([k, v]) => contains((container as Row)[k], v));
}

function opFilter(col: string, op: string, value: unknown): (r: Row) => boolean {
  switch (op) {
    case "eq": return (r) => looseEq(r[col], value);
    case "neq": return (r) => !looseEq(r[col], value);
    case "gt": return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], value) > 0;
    case "gte": return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], value) >= 0;
    case "lt": return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], value) < 0;
    case "lte": return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], value) <= 0;
    case "is": return (r) => (r[col] ?? null) === value;
    case "like": return (r) => typeof r[col] === "string" && likeToRegex(String(value), "").test(r[col]);
    case "ilike": return (r) => typeof r[col] === "string" && likeToRegex(String(value), "i").test(r[col]);
    case "in": {
      const list = Array.isArray(value)
        ? value
        : String(value).replace(/^\(|\)$/g, "").split(",").map((s) => parseValue(s.trim().replace(/^"|"$/g, "")));
      return (r) => list.some((v) => looseEq(r[col], v));
    }
    case "cs": return (r) => contains(r[col], typeof value === "string" ? JSON.parse(value) : value);
    default: throw new Error(`fake_supabase: unsupported filter op ${op}`);
  }
}

function orFilter(expr: string): (r: Row) => boolean {
  const parts = expr.split(",").map((p) => {
    const [c, op, ...rest] = p.trim().split(".");
    return opFilter(c, op, parseValue(rest.join(".")));
  });
  return (r) => parts.some((f) => f(r));
}

// ---------------------------------------------------------------------------------------------------
// Projection

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

export function project(row: Row, select: string | undefined): Row {
  const sel = (select ?? "*").replace(/\s+/g, " ").trim();
  if (sel === "" || sel === "*") return { ...row };
  const out: Row = {};
  for (const item of splitTop(sel)) {
    if (item === "*") { Object.assign(out, row); continue; }
    const paren = item.indexOf("(");
    if (paren >= 0) {
      // alias:relation!hint(cols)  -> the embedded value is stored on the row under alias or relation
      const head = item.slice(0, paren);
      const inner = item.slice(paren + 1, item.lastIndexOf(")"));
      const [aliasOrRel, maybeRel] = head.split(":");
      const rel = (maybeRel ?? aliasOrRel).split("!")[0].trim();
      const key = maybeRel ? aliasOrRel.trim() : rel;
      const v = row[key] ?? row[rel];
      out[key] = v === undefined || v === null
        ? null
        : Array.isArray(v) ? v.map((x) => project(x, inner)) : project(v, inner);
      continue;
    }
    const [alias, col] = item.includes(":") ? item.split(":").map((x) => x.trim()) : [item, item];
    const c = col.split("::")[0];
    out[alias] = row[c] === undefined ? null : row[c];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Query builder

type Op = "select" | "insert" | "update" | "upsert" | "delete";

class Query {
  private op: Op = "select";
  private payload: any;
  private options: any;
  private selectCols: string | undefined = "*";
  private selectOpts: { count?: string; head?: boolean } | undefined;
  private returning = false;
  private filters: ((r: Row) => boolean)[] = [];
  private filterLog: string[] = [];
  private orderBy: { col: string; asc: boolean }[] = [];
  private limitN: number | null = null;
  private rangeFT: [number, number] | null = null;
  private mode: "many" | "single" | "maybe" = "many";

  constructor(private tableName: string, private client: ClientMeta) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") { this.selectCols = cols ?? "*"; this.selectOpts = opts; }
    else { this.returning = true; this.selectCols = cols ?? "*"; }
    return this;
  }
  insert(p: any, o?: any) { this.op = "insert"; this.payload = p; this.options = o ?? {}; return this; }
  update(p: any, o?: any) { this.op = "update"; this.payload = p; this.options = o ?? {}; return this; }
  upsert(p: any, o?: any) { this.op = "upsert"; this.payload = p; this.options = o ?? {}; return this; }
  delete(o?: any) { this.op = "delete"; this.options = o ?? {}; return this; }

  private add(f: (r: Row) => boolean, log: string) { this.filters.push(f); this.filterLog.push(log); return this; }
  eq(c: string, v: unknown) { return this.add(opFilter(c, "eq", v), `${c}=eq.${v}`); }
  neq(c: string, v: unknown) { return this.add(opFilter(c, "neq", v), `${c}=neq.${v}`); }
  gt(c: string, v: unknown) { return this.add(opFilter(c, "gt", v), `${c}=gt.${v}`); }
  gte(c: string, v: unknown) { return this.add(opFilter(c, "gte", v), `${c}=gte.${v}`); }
  lt(c: string, v: unknown) { return this.add(opFilter(c, "lt", v), `${c}=lt.${v}`); }
  lte(c: string, v: unknown) { return this.add(opFilter(c, "lte", v), `${c}=lte.${v}`); }
  is(c: string, v: unknown) { return this.add(opFilter(c, "is", v), `${c}=is.${v}`); }
  like(c: string, v: string) { return this.add(opFilter(c, "like", v), `${c}=like.${v}`); }
  ilike(c: string, v: string) { return this.add(opFilter(c, "ilike", v), `${c}=ilike.${v}`); }
  in(c: string, v: unknown[]) { return this.add(opFilter(c, "in", v), `${c}=in.(${(v ?? []).join(",")})`); }
  contains(c: string, v: unknown) { return this.add(opFilter(c, "cs", v), `${c}=cs.${JSON.stringify(v)}`); }
  match(obj: Row) { for (const [k, v] of Object.entries(obj)) this.eq(k, v); return this; }
  not(c: string, op: string, v: unknown) {
    const f = opFilter(c, op, v);
    return this.add((r) => !f(r), `${c}=not.${op}.${v}`);
  }
  or(expr: string) { return this.add(orFilter(expr), `or=(${expr})`); }
  filter(c: string, op: string, v: unknown) {
    if (op.startsWith("not.")) return this.not(c, op.slice(4), parseValue(String(v)));
    return this.add(opFilter(c, op, typeof v === "string" ? parseValue(v) : v), `${c}=${op}.${v}`);
  }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy.push({ col, asc: o?.ascending !== false }); return this; }
  limit(n: number) { this.limitN = n; return this; }
  range(from: number, to: number) { this.rangeFT = [from, to]; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  abortSignal() { return this; }
  returns() { return this; }
  throwOnError() { return this; }

  then<T>(resolve: (v: any) => T, reject?: (e: unknown) => T) {
    return Promise.resolve().then(() => this.exec()).then(resolve, reject);
  }

  private match_(r: Row) { return this.filters.every((f) => f(r)); }

  private shape(rows: Row[], count?: number) {
    const projected = rows.map((r) => project(r, this.selectCols));
    if (this.mode === "single") {
      return projected.length === 1
        ? { data: projected[0], error: null, count: count ?? null }
        : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, count: null };
    }
    if (this.mode === "maybe") {
      if (projected.length > 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple rows returned" }, count: null };
      return { data: projected[0] ?? null, error: null, count: count ?? null };
    }
    return { data: projected, error: null, count: count ?? null };
  }

  private exec(): any {
    const rows = table(this.tableName);
    if (this.op === "select") {
      const injected = state.failSelect?.(this.tableName, this.filterLog) ?? null;
      if (injected) {
        state.reads.push({ table: this.tableName, select: String(this.selectCols), filters: this.filterLog, client: this.client, rows: 0, error: injected });
        return { data: null, error: injected, count: null };
      }
      let found = rows.filter((r) => this.match_(r));
      for (const o of [...this.orderBy].reverse()) {
        found = [...found].sort((a, b) => (o.asc ? 1 : -1) * cmp(a[o.col], b[o.col]));
      }
      const total = found.length;
      if (this.rangeFT) found = found.slice(this.rangeFT[0], this.rangeFT[1] + 1);
      if (this.limitN !== null) found = found.slice(0, this.limitN);
      state.reads.push({ table: this.tableName, select: String(this.selectCols), filters: this.filterLog, client: this.client, rows: found.length });
      if (this.selectOpts?.head) return { data: null, error: null, count: total };
      return this.shape(found, this.selectOpts?.count ? total : undefined);
    }

    if (this.op === "insert") return this.execInsert(rows);

    if (this.op === "update") {
      state.beforeUpdate?.(this.tableName);
      const injected = state.failUpdate?.(this.tableName, this.payload, this.filterLog) ?? null;
      if (injected) {
        state.log.push({ kind: "update", table: this.tableName, payload: this.payload, filters: this.filterLog, client: this.client, rows: 0, error: injected });
        return { data: null, error: injected };
      }
      const hit = rows.filter((r) => this.match_(r));
      hit.forEach((r) => Object.assign(r, this.payload));
      state.log.push({ kind: "update", table: this.tableName, payload: this.payload, filters: this.filterLog, client: this.client, rows: hit.length });
      return this.returning ? this.shape(hit.map((r) => ({ ...r }))) : { data: null, error: null };
    }

    if (this.op === "delete") {
      const keep = rows.filter((r) => !this.match_(r));
      const n = rows.length - keep.length;
      state.tables[this.tableName] = keep;
      state.log.push({ kind: "delete", table: this.tableName, filters: this.filterLog, client: this.client, rows: n });
      return { data: null, error: null };
    }

    // upsert
    const list: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
    const target = this.options?.onConflict
      ? String(this.options.onConflict).split(",").map((s) => s.trim())
      : (state.unique[this.tableName]?.[0] ?? ["id"]);
    const injected = state.failInsert?.(this.tableName, list, this.options) ?? null;
    if (injected) {
      state.log.push({ kind: "upsert", table: this.tableName, payload: this.payload, options: this.options, client: this.client, rows: 0, error: injected });
      return { data: null, error: injected };
    }
    let n = 0;
    const stored: Row[] = [];
    for (const r of list) {
      const existing = rows.find((x) => target.every((c) => looseEq(x[c], r[c])));
      if (existing) {
        if (!this.options?.ignoreDuplicates) { Object.assign(existing, r); n++; stored.push({ ...existing }); }
      } else {
        const row = { ...r };
        if (row.id === undefined) row.id = fakeUuid();
        if (row.created_at === undefined) row.created_at = state.clock();
        rows.push(row);
        stored.push({ ...row });
        n++;
      }
    }
    state.log.push({ kind: "upsert", table: this.tableName, payload: this.payload, options: this.options, client: this.client, rows: n, stored });
    return this.returning ? this.shape(stored) : { data: null, error: null };
  }

  private execInsert(rows: Row[]) {
    const input: Row[] = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r: Row) => ({ ...r }));
    // PostgREST bulk insert: every row gets the union of keys; missing ones are NULL unless
    // defaultToNull is false (then the column default applies).
    if (Array.isArray(this.payload) && this.options?.defaultToNull !== false) {
      const keys = new Set<string>();
      input.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
      input.forEach((r) => keys.forEach((k) => { if (!(k in r)) r[k] = null; }));
    }
    const injected = state.failInsert?.(this.tableName, input, this.options) ?? null;
    if (injected) {
      state.log.push({ kind: "insert", table: this.tableName, payload: this.payload, options: this.options, client: this.client, rows: 0, error: injected });
      return { data: null, error: injected };
    }
    const toStore: Row[] = [];
    for (let i = 0; i < input.length; i++) {
      let row = input[i];
      if (row.id === null || row.created_at === null) {
        const col = row.id === null ? "id" : "created_at";
        const error = { code: "23502", message: `null value in column "${col}" of relation "${this.tableName}" violates not-null constraint` };
        state.log.push({ kind: "insert", table: this.tableName, payload: this.payload, options: this.options, client: this.client, rows: 0, error });
        return { data: null, error };
      }
      if (row.id === undefined) row.id = fakeUuid();
      if (row.created_at === undefined) row.created_at = state.clock();
      const hook = state.onInsert[this.tableName];
      if (hook) {
        const res = hook(row, { client: this.client, state, batch: input, index: i, options: this.options });
        if ("message" in res && !("id" in res)) {
          state.log.push({ kind: "insert", table: this.tableName, payload: this.payload, options: this.options, client: this.client, rows: 0, error: res as ApiError });
          return { data: null, error: res };
        }
        row = res as Row;
      }
      for (const key of state.unique[this.tableName] ?? []) {
        const clash = [...rows, ...toStore].some((x) => key.every((c) => looseEq(x[c], row[c])));
        if (clash) {
          const error = { code: "23505", message: `duplicate key value violates unique constraint on ${this.tableName} (${key.join(", ")})` };
          state.log.push({ kind: "insert", table: this.tableName, payload: this.payload, options: this.options, client: this.client, rows: 0, error });
          return { data: null, error };
        }
      }
      toStore.push(row);
    }
    rows.push(...toStore);
    const ctx = { client: this.client, state, batch: toStore, index: -1, options: this.options };
    state.log.push({
      kind: "insert", table: this.tableName, payload: this.payload, options: this.options, client: this.client,
      rows: toStore.length, stored: toStore.map((r) => ({ ...r })),
    });
    state.afterInsert[this.tableName]?.(toStore, ctx);
    if (!this.returning) return { data: null, error: null };
    const back = toStore.map((r) => ({ ...r }));
    return this.shape(state.reverseInsertReturn ? back.reverse() : back);
  }
}

// ---------------------------------------------------------------------------------------------------
// rpc

class RpcCall {
  private mode: "many" | "single" | "maybe" = "many";
  constructor(private name: string, private args: any, private client: ClientMeta) {}
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  select() { return this; }
  abortSignal() { return this; }
  throwOnError() { return this; }
  then<T>(resolve: (v: any) => T, reject?: (e: unknown) => T) {
    return Promise.resolve().then(() => this.exec()).then(resolve, reject);
  }
  private async exec() {
    const uid = uidOf(this.client);
    const h = state.rpc[this.name];
    let res: { data?: any; error?: ApiError | null };
    if (h) res = await h(this.args, { client: this.client, state, uid });
    else if (state.unknownRpcIsMissing) res = fail("PGRST202", `Could not find the function public.${this.name} in the schema cache`);
    else res = { data: null, error: null };
    const out = { data: res.data ?? null, error: res.error ?? null };
    state.log.push({ kind: "rpc", name: this.name, payload: this.args ?? null, client: this.client, error: out.error, result: out.data });
    if (!out.error && this.mode !== "many" && Array.isArray(out.data)) {
      out.data = out.data[0] ?? null;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------
// client

function bearerOf(client: ClientMeta): string | null {
  const h = client.headers.Authorization ?? client.headers.authorization ?? "";
  const t = h.replace(/^Bearer\s+/i, "").trim();
  return t || null;
}

/** The auth uid PostgREST would see for this client (user JWT only). */
export function uidOf(client: ClientMeta): string | null {
  const t = bearerOf(client);
  if (!t) return null;
  return state.users.get(t)?.id ?? null;
}

let clientSeq = 0;

export function createClient(_url: string, key: string, opts?: { global?: { headers?: Record<string, string> } }) {
  const meta: ClientMeta = {
    id: ++clientSeq,
    key,
    role: key === state.serviceKey ? "service" : key === state.anonKey ? "anon" : "other",
    headers: { ...(opts?.global?.headers ?? {}) },
  };
  state.clients.push(meta);
  const getUser = (jwt?: string) => {
    const token = jwt ?? bearerOf(meta);
    const user = token ? state.users.get(token) : undefined;
    state.log.push({ kind: "auth", name: "getUser", client: meta, payload: token ? "token" : null });
    const answer = user
      ? { data: { user }, error: null }
      : { data: { user: null }, error: { message: "invalid JWT", status: 401 } };
    const gate = state.getUserGate;
    return gate ? gate().then(() => answer) : Promise.resolve(answer);
  };
  return {
    from: (t: string) => new Query(t, meta),
    rpc: (name: string, args?: any) => new RpcCall(name, args, meta),
    auth: {
      getUser,
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      admin: {
        getUserById: (id: string) => {
          const u = state.authUsers.find((x) => x.id === id);
          return Promise.resolve(u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "User not found", status: 404 } });
        },
        createUser: (attrs: Row) => {
          state.log.push({ kind: "auth", name: "admin.createUser", payload: { email: attrs.email }, client: meta });
          const custom = state.authCreateUser?.(attrs);
          if (custom) return Promise.resolve(custom);
          if (state.authUsers.some((u) => String(u.email).toLowerCase() === String(attrs.email).toLowerCase())) {
            return Promise.resolve({ data: { user: null }, error: { message: "A user with this email address has already been registered", status: 422 } });
          }
          const user = { id: fakeUuid(), email: attrs.email, user_metadata: attrs.user_metadata ?? {} };
          state.authUsers.push(user);
          return Promise.resolve({ data: { user }, error: null });
        },
        updateUserById: (id: string, attrs: Row) => {
          state.log.push({ kind: "auth", name: "admin.updateUserById", payload: { id, attrs }, client: meta });
          return Promise.resolve({ data: { user: { id, ...attrs } }, error: null });
        },
        deleteUser: (id: string) => {
          state.log.push({ kind: "auth", name: "admin.deleteUser", payload: { id }, client: meta });
          return Promise.resolve({ data: {}, error: null });
        },
        listUsers: () => Promise.resolve({ data: { users: state.authUsers }, error: null }),
        generateLink: (attrs: Row) => Promise.resolve({ data: { properties: { action_link: `https://link/${attrs?.email}` } }, error: null }),
      },
    },
    functions: {
      invoke: (name: string, o?: { body?: any }) => {
        state.log.push({ kind: "invoke", name, payload: o?.body ?? null, client: meta });
        const h = state.invoke[name];
        const res = h ? h(o?.body) : { data: { success: true }, error: null };
        return Promise.resolve({ data: res.data ?? null, error: res.error ?? null });
      },
    },
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: { path: "x" }, error: null }),
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://storage/${p}` } }),
        createSignedUrl: (p: string) => Promise.resolve({ data: { signedUrl: `https://storage/${p}?signed` }, error: null }),
      }),
    },
  };
}

export type SupabaseClient = ReturnType<typeof createClient>;
export default { createClient };
