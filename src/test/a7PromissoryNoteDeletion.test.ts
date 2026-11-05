// @vitest-environment node
/**
 * A7 Partner Commitments Receivable: derecognition on promissory note deletion (CFO request 2026-11-03,
 * supabase/migrations/20261103210000_a7_promissory_note_delete_derecognition.sql).
 *
 * PGlite with production's own code, verbatim (scripts/fixtures/a7-promissory-prod-2026-11-03.sql and the resolver
 * scripts/fixtures/sofp-prod-2026-11-02.sql), over a production replica (scripts/fixtures/a7-promissory-prod-2026-11-03.json,
 * read-only export 2026-11-03, partner names/phones removed): the 107 deleted notes that ever carried A7 (86 still do,
 * UGX 51,183,000; 21 were reversed), their recognition, reversal and bonus groups, their audit rows, and a sample of
 * 344 live notes with their recognition groups.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8').replace(/\r/g, '');
const MIGRATION = read('supabase/migrations/20261103210000_a7_promissory_note_delete_derecognition.sql');
const ROLLBACK = read('supabase/rollbacks/20261103210000_a7_promissory_note_delete_derecognition.rollback.sql');
const PROD = read('scripts/fixtures/a7-promissory-prod-2026-11-03.sql');
const SOFP_ALL = read('scripts/fixtures/sofp-prod-2026-11-02.sql');
const SOFP = SOFP_ALL.slice(SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.sofp_ledger_legs'),
  SOFP_ALL.indexOf('CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position'));
const HIST_BLOCK = MIGRATION.slice(MIGRATION.indexOf('DO $hist$'), MIGRATION.indexOf('END $hist$;') + 'END $hist$;'.length);

interface Leg { transaction_group_id: string; ledger_scope: string; direction: string; category: string; amount: number; source_id: string }
interface Note { id: string; agent_id: string; status: string; amount: number; total_collected: number }
const FIX = JSON.parse(read('scripts/fixtures/a7-promissory-prod-2026-11-03.json')) as {
  ddl: Record<string, Array<{ c: string; t: string; d: string | null }>>; notes: Note[]; legs: Leg[];
  audit: Array<{ record_id: string; action: string | null; reason: string | null; metadata: Record<string, unknown> }>;
  map: unknown[]; integrity: unknown[]; deleted_ids: string[];
};

const DEF_OK = /^(gen_random_uuid\(\)|now\(\)|true|false|-?\d+(\.\d+)?|'[^']*'::[\w ]+(\[\])?|CURRENT_DATE)$/;
const ddl = (t: string) => `create table public.${t} (${FIX.ddl[t].map((c) =>
  `"${c.c}" ${c.t}${c.d && DEF_OK.test(c.d) ? ` default ${c.d}` : ''}`).join(', ')});`;

const OPS = '00000000-0000-0000-0000-00000000a0a0';
const STANDINS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create type public.solvency_bypass_reason as enum ('cfo_override');
create type public.app_role as enum ('operations','partner_ops','cfo','coo','manager','ceo','super_admin');
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
${['general_ledger', 'ledger_account_map', 'ledger_integrity_config', 'promissory_notes', 'audit_logs'].map(ddl).join('\n')}
alter table public.promissory_notes add primary key (id);
alter table public.audit_logs alter column id set default gen_random_uuid();
alter table public.audit_logs alter column created_at set default now();
create table public.user_roles (user_id uuid, role public.app_role);
create function public.has_role(p_user uuid, p_role public.app_role) returns boolean language sql stable as $$ select exists (select 1 from public.user_roles where user_id = p_user and role = p_role) $$;
create function public.staff_mfa_ok() returns boolean language sql stable as $$ select true $$;
create table public.partner_self_commitments (promissory_note_id uuid);
create table public.funder_pending_portfolios (promissory_note_id uuid);
create table public.promissory_note_release_notices (note_id uuid);
create table public.promissory_note_pledge_notices (note_id uuid);
create table public.promissory_note_plan_intents (note_id uuid);
create table public.partner_note_overrides (note_id uuid);
create table public.partner_note_reversals (note_id uuid);
create table public.promissory_commission_events (note_id uuid);
create table public.pso_note_reversals (note_id uuid references public.promissory_notes(id) on delete restrict);
create table public.proxy_agent_assignments (agent_id uuid, is_active boolean, updated_at timestamptz);
create table public.proxy_partner_invites (proxy_agent_id uuid);
create table public.proxy_agent_identity (agent_user_id uuid);
create table public.wallets (id uuid default gen_random_uuid(), user_id uuid unique, withdrawable_balance numeric default 0);
create table public.wallet_fresh_start_anchors (user_id uuid, anchor_at timestamptz);
create table public.wallet_routing_violations (user_id uuid, category text, direction text, amount numeric, recipient_type text, reason text, context jsonb);
create table public.treasury_controls (control_key text, enabled boolean);
create table public.ledger_mapped_balance_violations (transaction_group_id uuid primary key, mapped_debits numeric, mapped_credits numeric, residual numeric, source_table text, leg_shape text, detected_at timestamptz default now());
create table public.smartphone_catalog (brand text, model_name text);
create table public.merchandise_recovery_plans (id uuid, item_name text); -- read by the resolver
create function public.wallet_route_for_category(p_user uuid, p_category text, p_direction text) returns table(bucket text, sign numeric) language sql stable as $$ select null::text, null::numeric where false $$;
create function public.assert_routing_compatible(p_category text, p_recipient text) returns void language sql as $$ select $$;
insert into public.treasury_controls values ('strict_mode', true);
insert into public.user_roles values ('${OPS}', 'partner_ops');
`;
const AFTER_LOAD = `
create trigger trg_validate_ledger_category before insert on public.general_ledger for each row execute function public.validate_ledger_category();
create constraint trigger trg_enforce_ledger_group_balance after insert on public.general_ledger deferrable initially deferred for each row execute function public.enforce_ledger_group_balance();
create constraint trigger trg_enforce_ledger_group_mapped_balance after insert on public.general_ledger deferrable initially deferred for each row execute function public.enforce_ledger_group_mapped_balance();
update public.ledger_integrity_config set mapped_balance_mode = 'enforce';  -- stricter than production ('log')
-- production's recognition triggers on promissory_notes
create trigger recognise_partner_receivable_on_activation after update of status on public.promissory_notes for each row
  when (((new.status = 'activated'::text) and (coalesce(old.status, ''::text) <> 'activated'::text))) execute function public.trg_recognise_partner_receivable();
create trigger recognise_partner_receivable_on_insert after insert on public.promissory_notes for each row
  when ((new.status = 'activated'::text)) execute function public.trg_recognise_partner_receivable();
`;

async function build(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STANDINS);
  await db.exec(PROD);
  await db.exec(SOFP);
  const load = async (t: string, rows: unknown[]) => {
    await db.query(`insert into public.${t} select * from json_populate_recordset(null::public.${t}, $1::json)`, [JSON.stringify(rows)]);
  };
  await load('ledger_account_map', FIX.map);
  await load('ledger_integrity_config', FIX.integrity);
  await load('promissory_notes', FIX.notes.map((n) => ({ ...n, partner_name: `Partner ${n.id.slice(0, 8)}`, whatsapp_number: '-' })));
  await load('general_ledger', FIX.legs);
  await load('audit_logs', FIX.audit);
  await db.exec(AFTER_LOAD);
  return db;
}

const num = (v: unknown) => Number(v);
async function rows<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
async function one<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(db, sql, params))[0];
}
const a7Net = async (db: PGlite, id: string) => num((await one<{ n: string }>(db, `select coalesce(sum(case when direction = 'cash_in' then amount else -amount end), 0) n
  from general_ledger where category = 'partner_receivable_created' and source_id = $1`, [id])).n);
const legCount = async (db: PGlite) => num((await one<{ n: string }>(db, `select count(*) n from general_ledger`)).n);
const resolverA7 = async (db: PGlite) => num((await one<{ n: string }>(db, `select coalesce(sum(dr) - sum(cr), 0) n from sofp_ledger_legs(now() + interval '1 day') where account_code = 'A7'`)).n);
async function asOps<T>(db: PGlite, f: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('test.uid', '${OPS}', false)`);
  try { return await f(); } finally { await db.exec(`select set_config('test.uid', '', false)`); }
}
async function newNote(db: PGlite, o: Partial<{ id: string; agent_id: string; status: string; amount: number; total_collected: number; approval_bonus_paid: boolean }> = {}) {
  const id = o.id ?? uuid();
  await db.query(`insert into promissory_notes (id, agent_id, partner_name, whatsapp_number, amount, status, total_collected, approval_bonus_paid,
      contribution_type, support_mode, follow_up_status, recorded_on, created_at, updated_at, activation_token)
    values ($1, $2, 'Test partner', '-', $3, $4, $5, $6, 'once_off', 'existing_support', 'not_started', current_date, now(), now(), 'x')`,
  [id, o.agent_id ?? uuid(), o.amount ?? 500_000, o.status ?? 'activated', o.total_collected ?? 0, o.approval_bonus_paid ?? false]);
  return id;
}

// expected per deleted note, straight from the replica's ledger rows
const NET = new Map<string, number>();
for (const l of FIX.legs) {
  if (l.category !== 'partner_receivable_created') continue;
  NET.set(l.source_id, (NET.get(l.source_id) ?? 0) + (l.direction === 'cash_in' ? 1 : -1) * num(l.amount));
}
const ORPHANS = FIX.deleted_ids.filter((id) => (NET.get(id) ?? 0) > 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const replicaOperational = sum(FIX.notes.filter((n) => n.status === 'activated').map((n) => Math.max(num(n.amount) - num(n.total_collected), 0)));

let db: PGlite;
beforeAll(async () => { db = await build(); }, 240_000);
afterAll(async () => { await db?.close(); });

describe('replica of production (2026-11-03)', () => {
  it('86 deleted notes still carry UGX 51,183,000 of A7; 21 deleted notes were reversed', () => {
    expect(ORPHANS.length).toBe(86);
    expect(sum(ORPHANS.map((id) => NET.get(id)!))).toBe(51_183_000);
    expect(FIX.deleted_ids.length - ORPHANS.length).toBe(21);
  });
  it('A7 = live activated notes net of collections + the deleted notes (resolver)', async () => {
    expect(await resolverA7(db)).toBe(replicaOperational + 51_183_000);
  });
});

describe('preflight', () => {
  it('refuses, changing nothing, when a delete function is not the production definition', async () => {
    const x = await build();
    await x.exec(`create or replace function public.bulk_delete_promissory_notes(p_note_ids uuid[], p_reason text) returns jsonb language sql as $$ select '{}'::jsonb $$`);
    const n0 = await legCount(x);
    await expect(x.exec(MIGRATION)).rejects.toThrow(/preflight refused/);
    expect(await legCount(x)).toBe(n0);
    expect((await one<{ t: string | null }>(x, `select to_regclass('public.promissory_note_derecognitions')::text t`)).t).toBeNull();
    await x.close();
  }, 240_000);
});

describe('migration: historical correction of the 86 deleted notes', () => {
  let n0: number; let before: string;
  beforeAll(async () => {
    n0 = await legCount(db);
    before = JSON.stringify(await rows(db, `select id, amount, category, direction, idempotency_key from general_ledger order by id`));
    await db.exec(MIGRATION);
  }, 240_000);

  it('posts one balanced DR L2 / CR A7 group per note, for exactly its net A7, linked to the note, editing nothing', async () => {
    const g = await rows<{ sid: string; n: string; a7: string; l2: string; key: string; ref: string; scopes: string[] }>(db, `
      select source_id sid, count(*) n,
        sum(amount) filter (where category = 'partner_receivable_created' and direction = 'cash_out' and ledger_scope = 'bridge') a7,
        sum(amount) filter (where category = 'partner_receivable_capital' and direction = 'cash_in' and ledger_scope = 'platform') l2,
        min(idempotency_key) key, min(reference_id) ref, array_agg(distinct ledger_scope) scopes
      from general_ledger where transaction_group_id in (select ledger_group_id from promissory_note_derecognitions) group by 1`);
    expect(g.length).toBe(86);
    for (const x of g) {
      expect(num(x.n)).toBe(2);
      expect(num(x.a7)).toBe(NET.get(x.sid));
      expect(num(x.l2)).toBe(NET.get(x.sid));
      expect(x.key).toBe(`partner_recv_rev:${x.sid}`);
      const recog = FIX.legs.find((l) => l.source_id === x.sid && l.category === 'partner_receivable_created' && l.direction === 'cash_in')!;
      expect(x.ref).toBe(recog.transaction_group_id);
      expect(x.scopes.sort()).toEqual(['bridge', 'platform']);
    }
    expect(sum(g.map((x) => num(x.a7)))).toBe(51_183_000);
    expect(await legCount(db)).toBe(n0 + 172);
    const after = JSON.stringify(await rows(db, `select id, amount, category, direction, idempotency_key from general_ledger
      where transaction_group_id not in (select ledger_group_id from promissory_note_derecognitions) order by id`));
    expect(after).toBe(before);
    for (const id of ORPHANS) expect(await a7Net(db, id)).toBe(0);
    expect((await rows(db, `select * from ledger_mapped_balance_violations`)).length).toBe(0);
  });

  it('A7 after = live activated notes net of collections (resolver); L2 falls by the same amount', async () => {
    expect(await resolverA7(db)).toBe(replicaOperational);
  });

  it('records the deletion evidence and review flags per note (no bonus recovered)', async () => {
    const r = await rows<{ note_id: string; flags: string[]; bonus_net: string; deleted_by: string | null; delete_reason: string | null; delete_action: string | null; a7_derecognised: string }>(db,
      `select * from promissory_note_derecognitions where origin = 'historical_correction'`);
    expect(r.length).toBe(86);
    expect(r.every((x) => x.deleted_by && x.delete_action && x.delete_reason)).toBe(true);
    expect(r.filter((x) => x.flags.includes('bonus_paid')).length).toBe(86);
    expect(r.filter((x) => x.flags.includes('outstanding_obligation')).length).toBe(86);
    expect(r.filter((x) => x.flags.includes('collections')).length).toBe(0);
    expect(r.filter((x) => x.flags.includes('ledger_differs')).length).toBe(0);
    expect(sum(r.map((x) => num(x.bonus_net)))).toBe(196_000);
    expect(r.filter((x) => x.delete_reason === 'WRRRRRRRRRRROG').length).toBe(10);
    // bonus legs untouched
    expect(num((await one<{ n: string }>(db, `select count(*) n from general_ledger where category in ('agent_commission','marketing_expense') and created_at > now() - interval '1 hour' and source_id = any($1::uuid[])`, [ORPHANS])).n)).toBe(0);
  });

  it('is idempotent: running the correction again posts nothing; a second apply is refused', async () => {
    const n1 = await legCount(db);
    await db.exec(HIST_BLOCK);
    expect(await legCount(db)).toBe(n1);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/preflight refused|already installed/);
  });

  it('keeps the helper and the table closed to app users (read-only to staff through RLS)', async () => {
    const f = await one<{ a: boolean; b: boolean }>(db, `select has_function_privilege('authenticated', 'public._partner_receivable_derecognise_deleted(uuid, text, text, text)', 'EXECUTE') a,
      has_table_privilege('authenticated', 'public.promissory_note_derecognitions', 'INSERT') b`);
    expect([f.a, f.b]).toEqual([false, false]);
  });
});

describe('every delete path derecognises in the same transaction, exactly once', () => {
  const pick = (k: number) => FIX.notes.filter((n) => n.status === 'activated' && num(n.total_collected) === 0)[k];
  const review = (id: string) => one<{ a7_derecognised: string; flags: string[]; delete_reason: string; deleted_by: string | null; origin: string } | undefined>(db,
    `select * from promissory_note_derecognitions where note_id = $1`, [id]);

  it('bulk_delete_promissory_notes (with its audit reason and actor)', async () => {
    const [a, b] = [pick(0), pick(1)];
    const netA = await a7Net(db, a.id); const netB = await a7Net(db, b.id);
    expect(netA).toBeGreaterThan(0);
    const r = await asOps(db, () => one<{ j: { deleted: number } }>(db, `select bulk_delete_promissory_notes($1::uuid[], 'duplicate entries found in audit') j`, [[a.id, b.id]]));
    expect(r.j.deleted).toBe(2);
    expect([await a7Net(db, a.id), await a7Net(db, b.id)]).toEqual([0, 0]);
    const ra = (await review(a.id))!;
    expect([num(ra.a7_derecognised), ra.delete_reason, ra.deleted_by, ra.origin]).toEqual([netA, 'duplicate entries found in audit', OPS, 'delete_trigger']);
    expect(num((await review(b.id))!.a7_derecognised)).toBe(netB);
    expect((await rows(db, `select 1 from audit_logs where action_type = 'a7_derecognised_on_delete' and record_id = $1`, [a.id])).length).toBe(1);
  });

  it('partner_ops_bulk_delete_proxy_agents (every note of the agent)', async () => {
    const agent = uuid();
    const ids = [await newNote(db, { agent_id: agent, amount: 300_000 }), await newNote(db, { agent_id: agent, amount: 200_000 }),
      await newNote(db, { agent_id: agent, status: 'pending', amount: 100_000 })];
    expect(await a7Net(db, ids[0])).toBe(300_000); // production recognises on insert
    await asOps(db, () => db.query(`select partner_ops_bulk_delete_proxy_agents($1::uuid[], 'proxy agent removed after review')`, [[agent]]));
    expect([await a7Net(db, ids[0]), await a7Net(db, ids[1]), await a7Net(db, ids[2])]).toEqual([0, 0, 0]);
    expect(num((await review(ids[0]))!.a7_derecognised)).toBe(300_000);
    expect(await review(ids[2])).toBeUndefined(); // pending, never recognised: nothing posted, nothing to review
  });

  it('a direct DELETE (any future path)', async () => {
    const id = await newNote(db, { amount: 750_000 });
    const n0 = await legCount(db);
    await db.query(`delete from promissory_notes where id = $1`, [id]);
    expect(await a7Net(db, id)).toBe(0);
    expect(await legCount(db)).toBe(n0 + 2);
    expect((await review(id))!.delete_reason).toBe('deleted without a recorded reason');
  });

  it('after derecognise_partner_receivable already ran: nothing posted twice', async () => {
    const id = await newNote(db, { amount: 400_000 });
    await db.query(`select derecognise_partner_receivable($1, 'reversed by the CFO before deletion')`, [id]);
    const n0 = await legCount(db);
    await db.query(`delete from promissory_notes where id = $1`, [id]);
    expect(await legCount(db)).toBe(n0);
    expect(await a7Net(db, id)).toBe(0);
    const r = (await review(id))!;
    expect(num(r.a7_derecognised)).toBe(0);
  });

  it('a note reversed, then recognised again, then deleted: removed once more under a new key', async () => {
    const id = await newNote(db, { amount: 600_000 });
    await db.query(`select derecognise_partner_receivable($1, 'reversed by the CFO before re-activation')`, [id]);
    await db.query(`select recognise_partner_receivable($1)`, [id]);
    expect(await a7Net(db, id)).toBe(600_000);
    await db.query(`delete from promissory_notes where id = $1`, [id]);
    expect(await a7Net(db, id)).toBe(0);
    expect((await one<{ k: string }>(db, `select idempotency_key k from general_ledger where source_id = $1 order by created_at desc, idempotency_key desc limit 1`, [id])).k)
      .toBe(`partner_recv_rev:${id}:deleted`);
  });

  it('deleting a pending (never recognised) note posts nothing', async () => {
    const id = await newNote(db, { status: 'pending' });
    const n0 = await legCount(db);
    await db.query(`delete from promissory_notes where id = $1`, [id]);
    expect(await legCount(db)).toBe(n0);
    expect(await review(id)).toBeUndefined();
  });

  it('a partly collected note: removes the A7 actually recognised (amount - collected) and is flagged', async () => {
    const id = await newNote(db, { amount: 1_000_000, total_collected: 300_000 });
    expect(await a7Net(db, id)).toBe(700_000);
    await db.query(`delete from promissory_notes where id = $1`, [id]);
    const r = (await review(id))!;
    expect(num(r.a7_derecognised)).toBe(700_000);
    expect(r.flags).toEqual(expect.arrayContaining(['collections', 'outstanding_obligation']));
  });

  it('a bonus-paid note and a note linked to a commitment are flagged, not blocked', async () => {
    const id = await newNote(db, { approval_bonus_paid: true });
    await db.query(`insert into partner_self_commitments values ($1)`, [id]);
    await db.query(`delete from promissory_notes where id = $1`, [id]);
    expect((await review(id))!.flags).toEqual(expect.arrayContaining(['bonus_paid', 'linked_commitment']));
  });

  it('atomic: if the delete fails, nothing is posted; if the accounting fails, the note is not deleted', async () => {
    const id = await newNote(db, { amount: 250_000 });
    await db.query(`insert into pso_note_reversals values ($1)`, [id]);
    const n0 = await legCount(db);
    await expect(db.query(`delete from promissory_notes where id = $1`, [id])).rejects.toThrow(/foreign key/);
    expect(await legCount(db)).toBe(n0);
    expect(await review(id)).toBeUndefined();
    await db.query(`delete from pso_note_reversals where note_id = $1`, [id]);
    // break the posting: the category is no longer allowlisted (strict mode raises)
    await db.exec(`alter function public.ledger_category_allowlist() rename to ledger_category_allowlist_real;
      create function public.ledger_category_allowlist() returns text[] language sql stable as $$ select array_remove(public.ledger_category_allowlist_real(), 'partner_receivable_capital') $$;`);
    await expect(db.query(`delete from promissory_notes where id = $1`, [id])).rejects.toThrow(/allowlist/);
    await db.exec(`drop function public.ledger_category_allowlist(); alter function public.ledger_category_allowlist_real() rename to ledger_category_allowlist;`);
    expect((await rows(db, `select 1 from promissory_notes where id = $1`, [id])).length).toBe(1);
    expect(await a7Net(db, id)).toBe(250_000);
  });

  it('A7 still equals the live notes net of collections after all of this (resolver)', async () => {
    const live = num((await one<{ n: string }>(db, `select coalesce(sum(greatest(amount - total_collected, 0)), 0) n from promissory_notes where status = 'activated'`)).n);
    expect(await resolverA7(db)).toBe(live);
  });
});

describe('rollback', () => {
  it('removes the trigger and functions; evidence and ledger entries stay', async () => {
    const x = await build();
    await x.exec(MIGRATION);
    await x.exec(ROLLBACK);
    expect(num((await one<{ n: string }>(x, `select count(*) n from promissory_note_derecognitions`)).n)).toBe(86);
    const id = await newNote(x, { amount: 100_000 });
    await x.query(`delete from promissory_notes where id = $1`, [id]);
    expect(await a7Net(x, id)).toBe(100_000); // back to production behaviour
    await x.close();
  }, 240_000);
});
