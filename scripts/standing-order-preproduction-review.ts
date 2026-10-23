// Local-only review: executes the unchanged payer in a VM with synthetic services.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import postgres from 'postgres';

const socket = process.env.STANDING_ORDER_TEST_SOCKET;
if (!socket?.startsWith('/tmp/standing-order-db.')) throw new Error('Disposable database required');
const options = { host: socket, port: 55439, username: process.env.STANDING_ORDER_TEST_USER, database: 'postgres', max: 1 };
const db = postgres(options);
const other = postgres(options);
const observer = postgres(options);
const id = '00000000-0000-0000-0000-000000000010';
const cfo = '00000000-0000-0000-0000-000000000001';
const admin = '00000000-0000-0000-0000-000000000002';
const tenant = '00000000-0000-0000-0000-000000000003';
const disabled = '00000000-0000-0000-0000-000000000004';
let count = 0;
function pass(label: string) { console.log(`PASS: ${label}`); count++; }
function barrier() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function row(sql = db) { const [r] = await sql`select to_jsonb(s) r from public.scheduled_payouts s where id=${id}::uuid`; return r.r; }
async function financial() {
  const [r] = await db`select (select jsonb_agg(to_jsonb(w)) from public.wallets w) wallets, (select jsonb_agg(to_jsonb(l)) from public.general_ledger l) ledger, (select jsonb_agg(to_jsonb(r)) from public.scheduled_payout_runs r) runs`;
  return r;
}
async function reset() {
  await db`delete from public.standing_order_audit_log`;
  await db`update public.staff_mfa_config set mode='all'`;
  await db`update public.scheduled_payouts set amount=100000, enabled=true, next_run_at='2026-10-23', last_run_at='2026-10-22' where id=${id}::uuid`;
}
async function edit(sql: any, before: any, amount: number, actor = cfo, aal = 'aal2') {
  return sql.begin(async (tx: any) => {
    await tx`select set_config('request.jwt.claim.sub',${actor},true),set_config('request.jwt.claim.aal',${aal},true)`;
    await tx`set local role authenticated`;
    const [r] = await tx`select public.standing_order_set_amount(${id}::uuid,${before.amount}::numeric,${before.updated_at}::text::timestamptz,${amount}::numeric,'Isolated preproduction review') result`;
    return r.result;
  });
}
async function waitForLock() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [r] = await observer`select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and (query like '%scheduled_payouts%' or query like '%standing_order_set_amount%')) waiting`;
    if (r.waiting) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Expected concurrent row-lock wait was not observed');
}

// All imports, HTTP, SMS, treasury and run writes are replaced BEFORE loading
// the unchanged source. No hosted URL, secret, payment endpoint or cron is used.
function loadPayer(sql: any, captured: ReturnType<typeof barrier>, release: ReturnType<typeof barrier>) {
  const calls: any[] = [];
  const runs: any[] = [];
  const scheduleWrites: any[] = [];
  let handler: ((req: Request) => Promise<Response>) | undefined;
  class Query {
    table: string; op = 'select'; values: any; filters: any[] = [];
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq(k: string, v: any) { this.filters.push([k, v]); return this; }
    lte() { return this; }
    gte() { return this; }
    maybeSingle() { return this; }
    update(v: any) { this.op = 'update'; this.values = v; return this; }
    insert(v: any) { this.op = 'insert'; this.values = v; return this; }
    async execute() {
      if (this.table === 'scheduled_payouts' && this.op === 'select') {
        const rows = await sql`select to_jsonb(s) r from public.scheduled_payouts s where id=${id}::uuid and enabled and next_run_at<=now()`;
        return { data: rows.map((r: any) => r.r), error: null };
      }
      if (this.table === 'scheduled_payouts' && this.op === 'update') {
        assert.deepEqual(Object.keys(this.values).sort(), ['last_run_at','next_run_at']);
        await sql`update public.scheduled_payouts set last_run_at=${this.values.last_run_at}::timestamptz,next_run_at=${this.values.next_run_at}::timestamptz where id=${id}::uuid`;
        scheduleWrites.push(this.values);
        return { error: null };
      }
      if (this.table === 'scheduled_payout_runs') {
        if (this.op === 'insert') runs.push(this.values);
        return { data: null, error: null };
      }
      if (this.table === 'profiles') return { data: { full_name: 'Synthetic recipient', phone: null }, error: null };
      throw new Error(`Unapproved payer request: ${this.table}/${this.op}`);
    }
    then(resolve: any, reject: any) { return this.execute().then(resolve, reject); }
  }
  const client = { from: (table: string) => new Query(table), rpc: () => { throw new Error('Unexpected payer RPC'); } };
  const source = readFileSync('supabase/functions/process-scheduled-payouts/index.ts', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = {
    exports: {}, console, Date, Response, Request, URLSearchParams,
    Deno: { env: { get: (k: string) => k === 'SUPABASE_URL' ? 'http://synthetic.invalid' : 'synthetic-not-a-credential' }, serve: (fn: any) => { handler = fn; } },
    require: (name: string) => {
      if (name.includes('supabase-js')) return { createClient: () => client };
      if (name.includes('treasuryGuard')) return { checkTreasuryGuard: async () => null };
      if (name.includes('yoolaPrimary')) return { attemptYoolaPrimary: () => { throw new Error('SMS forbidden'); } };
      if (name.includes('smsFooterInterceptor')) return {};
      throw new Error(`Unexpected import: ${name}`);
    },
    fetch: async (url: string, init: any) => {
      assert.equal(url, 'http://synthetic.invalid/functions/v1/cfo-direct-credit');
      calls.push(JSON.parse(init.body)); captured.resolve(); await release.promise;
      return new Response('{}', { status: 200 });
    },
  };
  vm.runInNewContext(compiled, context, { timeout: 5000 });
  if (!handler) throw new Error('Payer handler missing');
  return { calls, runs, scheduleWrites, run: () => handler?.(new Request('http://synthetic.invalid', { method: 'POST', body: JSON.stringify({ payout_id: id }) })) };
}

try {
  const financialBefore = await financial();
  // Replay the hosted helper logic, including the actual shadow-mode behavior.
  for (const mode of ['shadow','all','admin']) {
    for (const actor of [cfo,admin,tenant,disabled,'']) {
      for (const aal of ['aal1','aal2','']) {
        await reset(); await db`update public.staff_mfa_config set mode=${mode}`;
        const before = await row();
        const allowed = [cfo,admin].includes(actor) && (mode==='shadow' || aal==='aal2');
        let error: any;
        try { await edit(other,before,125000,actor,aal); } catch (e) { error=e; }
        if (allowed) {
          assert.equal(error,undefined); assert.equal((await row()).amount,125000);
          const [audit] = await db`select count(*)::int n from public.standing_order_audit_log`; assert.equal(audit.n,1);
        } else {
          assert.equal(error?.code,'42501'); assert.deepEqual(await row(),before);
          const [audit] = await db`select count(*)::int n from public.standing_order_audit_log`; assert.equal(audit.n,0);
        }
      }
    }
    pass(`${mode} MFA mode: 15 authenticated-role cases match hosted helper logic; all refusals leave configuration/audit unchanged`);
  }
  await reset();
  let captured = barrier(), release = barrier();
  let payer = loadPayer(other,captured,release);
  let running = payer.run(); await captured.promise;
  let before = await row();
  await edit(db,before,125000);
  assert.deepEqual({ ...await row(),amount:before.amount,updated_at:before.updated_at },before);
  assert.equal(payer.scheduleWrites.length,0); assert.equal(payer.runs.length,0);
  release.resolve(); await running;
  assert.equal(payer.calls[0].amount,100000); assert.equal(payer.runs[0].amount,100000);
  assert.equal((await row()).amount,125000); assert.equal(payer.scheduleWrites.length,1);
  pass('Payer captured UGX 100,000 before increase: edit changes no schedule/history; in-progress synthetic execution retains UGX 100,000 and its own schedule update preserves UGX 125,000');
  // A later independently due read must use the committed amount.
  await db`update public.scheduled_payouts set next_run_at='2026-10-23' where id=${id}::uuid`;
  captured=barrier(); release=barrier(); payer=loadPayer(other,captured,release);
  running=payer.run(); await captured.promise; release.resolve(); await running;
  assert.equal(payer.calls[0].amount,125000); assert.equal(payer.runs[0].amount,125000);
  pass('Later scheduled read uses revised UGX 125,000; independently marked due only by the test harness, never by amount editing');

  await reset(); before=await row(); captured=barrier(); release=barrier();
  payer=loadPayer(other,captured,release); let finishing: Promise<any> | undefined;
  await db.begin(async tx => {
    await tx`select set_config('request.jwt.claim.sub',${cfo},true),set_config('request.jwt.claim.aal','aal2',true)`;
    await tx`set local role authenticated`;
    await tx`select public.standing_order_set_amount(${id}::uuid,${before.amount}::numeric,${before.updated_at}::text::timestamptz,75000,'Concurrent local decrease')`;
    finishing=payer.run(); await captured.promise;
    assert.equal(payer.calls[0].amount,100000); release.resolve(); await waitForLock();
    assert.equal(payer.scheduleWrites.length,0);
  });
  await finishing;
  assert.equal((await row()).amount,75000); assert.equal(payer.runs[0].amount,100000);
  assert.equal(payer.scheduleWrites.length,1);
  pass('Payer reads old committed amount during uncommitted decrease; payer schedule update waits on real row lock, then preserves UGX 75,000');

  await reset(); before=await row(); captured=barrier(); release=barrier(); payer=loadPayer(other,captured,release);
  running=payer.run(); await captured.promise; release.resolve(); await running;
  const afterPayer=await row();
  await assert.rejects(edit(db,before,125000),(e: any)=>e.code==='40001');
  assert.deepEqual(await row(),afterPayer);
  const [noAudit] = await db`select count(*)::int n from public.standing_order_audit_log`; assert.equal(noAudit.n,0);
  pass('Payer schedule update before edit makes version stale: edit rejects without changing configuration or audit');

  await reset(); before=await row(); let competitor: Promise<any> | undefined;
  await db.begin(async tx => {
    await tx`select set_config('request.jwt.claim.sub',${cfo},true),set_config('request.jwt.claim.aal','aal2',true)`;
    await tx`set local role authenticated`;
    await tx`select public.standing_order_set_amount(${id}::uuid,${before.amount}::numeric,${before.updated_at}::text::timestamptz,125000,'First concurrent local edit')`;
    competitor=edit(other,before,75000).then(()=>({ code:'unexpected-success' }),e=>e);
    await waitForLock();
  });
  assert.equal((await competitor)?.code,'40001'); assert.equal((await row()).amount,125000);
  const [oneAudit] = await db`select count(*)::int n from public.standing_order_audit_log`; assert.equal(oneAudit.n,1);
  pass('Two concurrent editors: second waits, rejects stale version, and leaves exactly one committed amount/audit');
  assert.deepEqual(await financial(),financialBefore);
  pass('Wallets, ledger and historical run sentinels unchanged through all MFA and concurrency cases; every external request was intercepted');
  console.log(`FINAL REVIEW: ${count} groups passed (45 authorization/MFA cases plus actual-source payer concurrency).`);
} finally { await Promise.all([db.end(),other.end(),observer.end()]); }