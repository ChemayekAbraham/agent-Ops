// Run: node scripts/test-asset-register.mjs   (needs @electric-sql/pglite; exit code 1 on any failure)
// Applies supabase/migrations/20261026200000_asset_register_stage1.sql and
// 20261026200100_asset_register_stage1_storage_policies.sql to an embedded Postgres (PGlite) that stands in for the
// Supabase pieces they touch (auth.uid/jwt, anon/authenticated/service_role, storage.buckets/objects owned by
// supabase_storage_admin), with the role and MFA helpers loaded verbatim from production
// (scripts/fixtures/asset-register-helpers.sql). Then runs supabase/tests/asset_register_stage1.sql and the
// access, import, storage-policy and rollback scenarios below. A local pass does not prove production.
import fs from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => fs.readFileSync(here(p), 'utf8').replace(/\r/g, '');
const CORE = read('../supabase/migrations/20261026200000_asset_register_stage1.sql');
const STORAGE = read('../supabase/migrations/20261026200100_asset_register_stage1_storage_policies.sql');
const CORE_RB = read('../supabase/rollbacks/20261026200000_asset_register_stage1.rollback.sql');
const STORAGE_RB = read('../supabase/rollbacks/20261026200100_asset_register_stage1_storage_policies.rollback.sql');
const SQL_TESTS = read('../supabase/tests/asset_register_stage1.sql');
const HELPERS = read('./fixtures/asset-register-helpers.sql');

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } };
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const inTxn = (sql) => db.exec(`BEGIN;\n${sql}\nCOMMIT;`).catch(async (e) => { await db.exec('ROLLBACK').catch(() => {}); throw e; });

// As a signed-in Supabase user: JWT claims + the authenticated role, in one transaction that is always rolled back
// unless keep = true.
const asUser = async (userId, fn, { aal = 'aal2', role = 'authenticated', keep = false } = {}) => {
  await db.exec('BEGIN');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: userId, role, aal })]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    const out = await fn();
    await db.exec('RESET ROLE');
    await db.exec(keep ? 'COMMIT' : 'ROLLBACK');
    return { out, err: null };
  } catch (e) {
    await db.exec('ROLLBACK').catch(() => {});
    return { out: null, err: e };
  }
};

// ---- Supabase stand-ins ------------------------------------------------------------------------------------
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role supabase_storage_admin nologin;
-- the CLI's login: can read and write, but is NOT a member of supabase_storage_admin
create role cli_postgres nologin;

create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (auth.jwt() ->> 'sub'))::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;

create type public.app_role as enum ('tenant','agent','landlord','supporter','manager','ceo','coo','cfo','cto','cmo','crm',
  'employee','operations','super_admin','hr','senior_agent','sub_agent','admin','tenant_ops','landlord_ops','agent_ops',
  'financial_ops','partner_ops','access_admin','rd');
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null, role public.app_role not null,
  created_at timestamptz not null default now(), enabled boolean not null default true, disabled_at timestamptz, disabled_by uuid,
  disable_reason text);
create table public.profiles (id uuid primary key, full_name text, deleted_at timestamptz);
create table public.staff_profiles (user_id uuid, employee_id text, department text);
create table public.hr_departments (key text primary key, name text, active boolean default true);
create table public.staff_mfa_config (id boolean primary key, mode text not null, updated_at timestamptz not null default now(), updated_by uuid);
insert into public.staff_mfa_config (id, mode) values (true, 'shadow');
create table public.general_ledger (id bigserial primary key, amount numeric);
insert into public.general_ledger (amount) values (1), (2);
grant usage on schema public to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint,
  allowed_mime_types text[], created_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;
-- as in Supabase: the storage schema and its tables belong to supabase_storage_admin
alter schema storage owner to supabase_storage_admin;
alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
grant usage on schema storage to anon, authenticated, service_role, cli_postgres;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role, cli_postgres;

grant usage, create on schema public to cli_postgres;
grant select on all tables in schema public to cli_postgres;
`);
await db.exec('set check_function_bodies = off;\n' + HELPERS + '\nset check_function_bodies = on;');

const cfo = uuid(), admin = uuid(), coo = uuid(), ceo = uuid(), nobody = uuid(), disabledCfo = uuid();
for (const [id, name] of [[cfo, 'Cfo User'], [admin, 'Super Admin'], [coo, 'Coo User'], [ceo, 'Ceo User'], [nobody, 'No Role'], [disabledCfo, 'Disabled Cfo']]) {
  await db.query('insert into public.profiles (id, full_name) values ($1, $2)', [id, name]);
}
await db.query(`insert into public.user_roles (user_id, role) values ($1,'cfo'), ($2,'super_admin'), ($3,'coo'), ($4,'ceo')`, [cfo, admin, coo, ceo]);
await db.query(`insert into public.user_roles (user_id, role, enabled) values ($1,'cfo', false)`, [disabledCfo]);
await db.exec(`insert into public.hr_departments values ('finance', 'Finance', true), ('old', 'Old', false);
               insert into public.staff_profiles values ('${cfo}', 'EMP-001', 'Finance');`);

// ---- 1. Migrations: preflight, owner-only storage policies ---------------------------------------------------
let e = await errOf(() => inTxn(CORE));
ok(!e, 'core migration applies in one transaction', e?.message);
e = await errOf(() => inTxn(CORE));
ok(e && /precondition failed/.test(e.message), 'core migration refuses a second run (preflight)', e?.message);
ok((await q(`select count(*)::int n from public.assets`))[0].n === 0, 'register starts empty (no invented records)');
ok((await q(`select public from storage.buckets where id = 'asset-evidence'`))[0]?.public === false, 'evidence bucket created private');
ok((await q(`select count(*)::int n from pg_policies where policyname like 'asset_evidence%'`))[0].n === 0,
  'core migration creates no storage policy (deny by default until the storage file is applied)');

e = await errOf(() => inTxn(`SET LOCAL ROLE cli_postgres;\n${STORAGE}`));
ok(e && /does not own storage\.objects/.test(e.message), 'storage-policy file refused for a non-owner login (the CLI case), nothing changed', e?.message);
ok((await q(`select count(*)::int n from pg_policies where policyname like 'asset_evidence%'`))[0].n === 0, 'no policy left behind after the refusal');
e = await errOf(() => inTxn(STORAGE));
ok(!e, 'storage-policy file applies for an owner-level role', e?.message);
e = await errOf(() => inTxn(STORAGE));
ok(e && /already exist/.test(e.message), 'storage-policy file refuses a second run', e?.message);

// The file must reproduce production exactly: the dashboard-suffixed names and the stored conditions read from
// production (pg_policies, project byrzshwlentqvktcksem) on 2026-10-26.
const PROD_POLICIES = {
  'asset_evidence_read 1iodt3o_0': { cmd: 'SELECT', permissive: 'PERMISSIVE', roles: '{authenticated}', with_check: null,
    qual: "((bucket_id = 'asset-evidence'::text) AND ( SELECT asset_register_read_ok() AS asset_register_read_ok) AND ( SELECT staff_mfa_ok() AS staff_mfa_ok))" },
  'asset_evidence_insert 1iodt3o_0': { cmd: 'INSERT', permissive: 'PERMISSIVE', roles: '{authenticated}', qual: null,
    with_check: "((bucket_id = 'asset-evidence'::text) AND (name ~ '^assets/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(jpg|jpeg|png|webp|pdf)$'::text) AND ( SELECT asset_register_write_ok() AS asset_register_write_ok) AND ( SELECT staff_mfa_ok() AS staff_mfa_ok))" },
};
const created = await q(`select policyname, cmd, permissive, roles::text roles, qual, with_check from pg_policies
                          where schemaname = 'storage' and tablename = 'objects' order by policyname`);
ok(JSON.stringify(created.map((p) => p.policyname).sort()) === JSON.stringify(Object.keys(PROD_POLICIES).sort()),
  'storage-policy file creates exactly the two production policy names', JSON.stringify(created.map((p) => p.policyname)));
ok(created.every((p) => { const want = PROD_POLICIES[p.policyname];
     return want && ['cmd', 'permissive', 'roles', 'qual', 'with_check'].every((k) => p[k] === want[k]); }),
  'stored operation, mode, role and conditions equal production character for character', JSON.stringify(created));

// ---- 2. The SQL test file (rolls itself back and raises its report) ------------------------------------------
e = await errOf(() => db.exec(SQL_TESTS));
const report = e?.message ?? '';
const m = report.match(/ROLLED BACK REPORT: (\d+) passed of (\d+) \| failing: (.*)$/s);
ok(m && m[1] === m[2] && m[3].trim() === 'none', `supabase/tests/asset_register_stage1.sql: ${m ? `${m[1]} of ${m[2]}` : 'no report'}`, report);
ok((await q(`select count(*)::int n from public.assets`))[0].n === 0, 'SQL test file left no rows behind');

// ---- 3. Access control -------------------------------------------------------------------------------------
let r = await asUser(cfo, () => q(`select public.asset_register_summary() s`));
ok(!r.err, 'cfo can read the summary', r.err?.message);
r = await asUser(admin, () => q(`select public.asset_register_create('{"name":"Admin laptop","category":"it_equipment"}'::jsonb) a`));
ok(!r.err, 'super_admin can create', r.err?.message);
for (const [who, id] of [['coo', coo], ['ceo', ceo], ['role-less user', nobody], ['disabled cfo role', disabledCfo]]) {
  r = await asUser(id, () => q(`select public.asset_register_list() l`));
  ok(r.err?.code === '42501', `${who} cannot read the register (42501)`, r.err?.message);
}
r = await asUser(null, () => q(`select public.asset_register_summary() s`), { role: 'anon' });
ok(r.err && /permission denied/.test(r.err.message), 'anon cannot execute the RPCs', r.err?.message);
r = await asUser(cfo, () => q(`insert into public.assets (asset_code, name, category, created_by, updated_by) values ('WEL-AST-000999','X','furniture',$1,$1)`, [cfo]));
ok(r.err && /permission denied/.test(r.err.message), 'even cfo cannot insert into the table directly (RPC only)', r.err?.message);
r = await asUser(cfo, () => q(`select public._asset_register_validate('{}'::jsonb, false) v`));
ok(r.err && /permission denied/.test(r.err.message), 'internal helpers are not callable by signed-in users', r.err?.message);

await db.exec(`update public.staff_mfa_config set mode = 'admin'`);
r = await asUser(cfo, () => q(`select public.asset_register_summary() s`), { aal: 'aal1' });
ok(r.err?.code === '42501', 'MFA mode admin: cfo without a second factor (aal1) is refused', r.err?.message);
r = await asUser(cfo, () => q(`select public.asset_register_summary() s`), { aal: 'aal2' });
ok(!r.err, 'MFA mode admin: cfo with a second factor (aal2) is allowed', r.err?.message);
await db.exec(`update public.staff_mfa_config set mode = 'shadow'`);

// RLS on the tables themselves (SELECT is granted, rows are gated)
await asUser(cfo, () => q(`select public.asset_register_create('{"name":"Reception desk","category":"furniture","serial_number":"DSK-1"}'::jsonb)`), { keep: true });
r = await asUser(cfo, () => q(`select count(*)::int n from public.assets`));
ok(r.out?.[0].n === 1, 'cfo sees register rows through RLS', JSON.stringify(r.out ?? r.err?.message));
r = await asUser(coo, () => q(`select count(*)::int n from public.assets`));
ok(r.out?.[0].n === 0, 'coo sees no register rows through RLS', JSON.stringify(r.out ?? r.err?.message));

// ---- 4. Asset IDs, duplicates and import validation ----------------------------------------------------------
r = await asUser(cfo, async () => [
  (await q(`select public.asset_register_create('{"name":"Laptop A","category":"it_equipment","serial_number":"SN-100"}'::jsonb) a`))[0].a,
  (await q(`select public.asset_register_create('{"name":"Laptop B","category":"it_equipment"}'::jsonb) a`))[0].a,
]);
const [la, lb] = r.out ?? [];
ok(la && lb && /^WEL-AST-\d{6,}$/.test(la.asset_code) && Number(lb.asset_code.slice(8)) === Number(la.asset_code.slice(8)) + 1,
  'asset codes are server-generated and sequential', JSON.stringify(r.out ?? r.err?.message));

r = await asUser(cfo, () => q(`select public.asset_register_check_duplicates($1::jsonb) d`, [JSON.stringify([
  { row_ref: 2, name: 'Reception desk', category: 'furniture', serial_number: 'dsk 1' },
  { row_ref: 3, name: 'Reception desk', category: 'furniture' },
  { row_ref: 4, name: 'Brand new chair', category: 'furniture' }])]));
const dups = r.out?.[0].d ?? [];
ok(dups.some((d) => d.row_ref === '2' && d.serial_match) && dups.some((d) => d.row_ref === '3' && d.possible_match) && !dups.some((d) => d.row_ref === '4'),
  'duplicate check: normalised serial match and possible-duplicate match are reported, a new item is not', JSON.stringify(r.out ?? r.err?.message));

const sha = (c) => c.repeat(64);
r = await asUser(cfo, () => q(`select public.asset_register_import_commit('bad.xlsx', $1, $2::jsonb) x`, [sha('b'), JSON.stringify([
  { row_ref: 2, name: 'Chair', category: 'furniture' },
  { row_ref: 3, name: 'Motorbike', category: 'bikes' },
  { row_ref: 4, name: 'Desk', category: 'furniture', purchase_cost: '-10' },
  { row_ref: 5, name: 'Lamp', category: 'furniture', purchase_date: '1980-01-01' }])]), { keep: true });
const bad = r.out?.[0].x;
const errRows = new Set((bad?.errors ?? []).map((x) => String(x.row_ref)));
ok(bad?.status === 'rejected' && errRows.has('3') && errRows.has('4') && errRows.has('5') && !errRows.has('2'),
  'import: out-of-scope category, negative cost and too-old date are reported per row', JSON.stringify(bad ?? r.err?.message));
ok((await q(`select count(*)::int n from public.assets where name = 'Chair'`))[0].n === 0, 'import: a rejected batch inserts nothing (all-or-nothing)');
ok((await q(`select status from public.asset_import_batches where file_sha256 = $1`, [sha('b')]))[0]?.status === 'failed',
  'import: the rejected batch is kept for audit as failed');
r = await asUser(cfo, () => q(`select public.asset_register_import_commit('big.xlsx', $1, $2::jsonb) x`,
  [sha('c'), JSON.stringify(Array.from({ length: 1001 }, (_, i) => ({ name: `Chair ${i}`, category: 'furniture' })))]));
ok(r.err?.code === '22023', 'import: more than 1,000 rows refused', r.err?.message);
r = await asUser(cfo, () => q(`select public.asset_register_import_commit('dup.xlsx', $1, $2::jsonb) x`, [sha('d'),
  JSON.stringify([{ row_ref: 2, name: 'Another desk', category: 'furniture', serial_number: 'DSK 1' }])]));
ok(r.out?.[0].x.status === 'rejected' && /already registered/.test(JSON.stringify(r.out?.[0].x.errors)),
  'import: a serial already in the register is rejected, never overwritten', JSON.stringify(r.out ?? r.err?.message));

// ---- 5. Audit trail is append-only -------------------------------------------------------------------------
const events = (await q(`select count(*)::int n from public.asset_events`))[0].n;
e = await errOf(() => db.exec(`delete from public.asset_events`));
ok(e, 'asset_events cannot be deleted, even by the owner');
e = await errOf(() => db.exec(`update public.asset_import_batches set status = 'committed'`));
ok(e, 'import batches cannot be altered, even by the owner');
ok((await q(`select count(*)::int n from public.asset_events`))[0].n === events, 'audit trail unchanged after the attempts');

// ---- 6. Storage policies (evidence-path security) -------------------------------------------------------------
const desk = (await q(`select id from public.assets where name = 'Reception desk'`))[0].id;
const good = `assets/${desk}/${uuid()}.pdf`;
r = await asUser(cfo, () => q(`insert into storage.objects (bucket_id, name) values ('asset-evidence', $1)`, [good]));
ok(!r.err, 'cfo may upload under assets/<asset id>/<uuid>.pdf', r.err?.message);
for (const [label, path] of [['outside assets/', `other/${uuid()}.pdf`], ['traversal', `assets/../${uuid()}.pdf`],
                             ['executable type', `assets/${desk}/${uuid()}.exe`], ['non-uuid file name', `assets/${desk}/invoice.pdf`]]) {
  r = await asUser(cfo, () => q(`insert into storage.objects (bucket_id, name) values ('asset-evidence', $1)`, [path]));
  ok(r.err && /row-level security/.test(r.err.message), `upload refused: ${label}`, r.err?.message);
}
r = await asUser(coo, () => q(`insert into storage.objects (bucket_id, name) values ('asset-evidence', $1)`, [`assets/${desk}/${uuid()}.pdf`]));
ok(r.err && /row-level security/.test(r.err.message), 'coo cannot upload evidence', r.err?.message);
await asUser(cfo, () => q(`insert into storage.objects (bucket_id, name) values ('asset-evidence', $1)`, [good]), { keep: true });
r = await asUser(coo, () => q(`select count(*)::int n from storage.objects where bucket_id = 'asset-evidence'`));
ok(r.out?.[0].n === 0, 'coo cannot see evidence objects', JSON.stringify(r.out ?? r.err?.message));
r = await asUser(cfo, () => q(`select count(*)::int n from storage.objects where bucket_id = 'asset-evidence'`));
ok(r.out?.[0].n === 1, 'cfo can see evidence objects (signed URLs work)', JSON.stringify(r.out ?? r.err?.message));
r = await asUser(cfo, () => q(`update storage.objects set name = name || 'x' where bucket_id = 'asset-evidence'`));
ok(!r.err && (await q(`select count(*)::int n from storage.objects where name = $1`, [good]))[0].n === 1,
  'evidence cannot be renamed or replaced (no UPDATE policy)', r.err?.message);
r = await asUser(cfo, () => q(`delete from storage.objects where bucket_id = 'asset-evidence'`));
ok((await q(`select count(*)::int n from storage.objects where name = $1`, [good]))[0].n === 1,
  'evidence cannot be deleted from the client (no DELETE policy)', r.err?.message);

// ---- 6a. QR deep link (/cfo/assets/<uuid>): the server, not the route, decides who sees an asset -------------
// The QR carries only the uuid; scanning it calls asset_register_get(<uuid>) and reads evidence through storage RLS.
const cto = uuid();
await db.query(`insert into public.user_roles (user_id, role) values ($1, 'cto')`, [cto]);
const deskCode = (await q(`select asset_code from public.assets where id = $1`, [desk]))[0].asset_code;
for (const [who, id] of [['cfo', cfo], ['super_admin', admin]]) {
  r = await asUser(id, () => q(`select public.asset_register_get($1) x`, [desk]));
  ok(r.out?.[0].x.asset.id === desk && r.out[0].x.asset.asset_code === deskCode, `QR: ${who} opens the scanned asset (matching id and code)`,
    JSON.stringify(r.out ?? r.err?.message));
}
for (const [who, id] of [['coo', coo], ['ceo', ceo], ['cto', cto], ['role-less user', nobody], ['disabled cfo role', disabledCfo]]) {
  r = await asUser(id, () => q(`select public.asset_register_get($1) x`, [desk]));
  ok(r.err?.code === '42501' && !r.out, `QR: ${who} scanning a label gets 42501 and no asset data`, r.err?.message);
  r = await asUser(id, () => q(`select count(*)::int n from storage.objects where bucket_id = 'asset-evidence'`));
  ok(r.out?.[0].n === 0, `QR: ${who} cannot reach the asset's evidence`, JSON.stringify(r.out ?? r.err?.message));
}
r = await asUser(null, () => q(`select public.asset_register_get($1) x`, [desk]), { role: 'anon' });
ok(r.err && /permission denied/.test(r.err.message), 'QR: a signed-out (anon) caller cannot execute asset_register_get', r.err?.message);
r = await asUser(null, () => q(`select count(*)::int n from storage.objects where bucket_id = 'asset-evidence'`), { role: 'anon' });
ok(r.out?.[0].n === 0, 'QR: a signed-out (anon) caller sees no evidence objects', JSON.stringify(r.out ?? r.err?.message));
r = await asUser(cfo, () => q(`select public.asset_register_get($1) x`, [uuid()]));
ok(r.err?.code === 'P0002' && /ASSET_NOT_FOUND/.test(r.err.message), 'QR: an unknown uuid is ASSET_NOT_FOUND (P0002)', r.err?.message);
r = await asUser(cfo, () => q(`select public.asset_register_get($1) x`, [deskCode]));
ok(r.err?.code === '22P02', 'QR: an asset code is not accepted in place of the uuid', r.err?.message);

// ---- 6b. Contract with the app (src/lib/assetRegister/types.ts and useAssetRegister.ts) ------------------------
const ASSET_KEYS = ['id', 'asset_code', 'name', 'category', 'brand', 'model', 'serial_number', 'purchase_date', 'supplier',
  'purchase_cost', 'currency', 'invoice_reference', 'department_key', 'department_name', 'location', 'custodian_user_id',
  'custodian_name', 'custodian_display', 'condition', 'status', 'photo_paths', 'evidence_paths', 'notes', 'import_batch_id',
  'created_by', 'created_by_name', 'created_at', 'updated_by', 'updated_by_name', 'updated_at'];
const EVENT_KEYS = ['id', 'event_type', 'changed_fields', 'old_values', 'new_values', 'reason', 'actor_id', 'actor_name', 'batch_id', 'created_at'];
const SUMMARY_KEYS = ['as_at', 'total_assets', 'active_assets', 'register_cost_ugx', 'active_register_cost_ugx', 'cost_missing_count',
  'non_ugx_count', 'missing_evidence_count', 'missing_photo_count', 'missing_serial_count', 'unassigned_count', 'by_status',
  'by_condition', 'by_category'];
const sameKeys = (obj, keys) => {
  const got = Object.keys(obj ?? {}).sort(), want = [...keys].sort();
  return { equal: JSON.stringify(got) === JSON.stringify(want), missing: want.filter((k) => !got.includes(k)), extra: got.filter((k) => !want.includes(k)) };
};
r = await asUser(cfo, async () => ({
  list: (await q(`select public.asset_register_list(null, null, null, null, null, 25, 0) x`))[0].x,
  detail: (await q(`select public.asset_register_get($1) x`, [desk]))[0].x,
  summary: (await q(`select public.asset_register_summary() x`))[0].x,
  ref: (await q(`select public.asset_register_reference_data() x`))[0].x,
}));
const c = r.out ?? {};
let k = sameKeys(c.list, ['total_count', 'limit', 'offset', 'items']);
ok(!r.err && k.equal, 'list returns { total_count, limit, offset, items } (AssetListPage)', r.err?.message ?? JSON.stringify(k));
k = sameKeys(c.list?.items?.[0], ASSET_KEYS);
ok(k.equal, 'list items match Asset field for field', JSON.stringify(k));
k = sameKeys(c.detail, ['asset', 'events']);
ok(k.equal && sameKeys(c.detail?.asset, ASSET_KEYS).equal, 'detail returns { asset, events } with an Asset', JSON.stringify(k));
k = sameKeys(c.detail?.events?.[0], EVENT_KEYS);
ok(k.equal, 'detail events match AssetEvent field for field', JSON.stringify(k));
k = sameKeys(c.summary, SUMMARY_KEYS);
ok(k.equal && Array.isArray(c.summary?.by_category) && sameKeys(c.summary.by_category[0], ['category', 'count', 'cost_ugx']).equal,
  'summary matches AssetSummary (including by_category rows)', JSON.stringify(k));
ok(sameKeys(c.ref, ['departments', 'custodians']).equal && c.ref.departments.length === 1
   && sameKeys(c.ref.custodians[0], ['user_id', 'name', 'employee_id', 'department']).equal,
  'reference data matches AssetReferenceData (active departments only)', JSON.stringify(c.ref));
ok(typeof c.list?.items?.[0]?.purchase_cost !== 'string', 'purchase_cost arrives as a number or null, as the app expects');

// ---- 7. No contact with money -----------------------------------------------------------------------------
ok((await q(`select count(*)::int n from public.general_ledger`))[0].n === 2, 'general_ledger untouched');
const moneyRefs = (await q(`select count(*)::int n from pg_proc where proname like '%asset_register%' and prosrc ~* '(general_ledger|wallet|payment|balance)'`))[0].n;
ok(moneyRefs === 0, 'no asset-register function mentions the ledger, wallets, payments or balances');

// ---- 8. Rollbacks -----------------------------------------------------------------------------------------
e = await errOf(() => inTxn(CORE_RB));
ok(e && /storage_policies first/.test(e.message), 'core rollback refuses while the storage policies exist', e?.message);
// A policy that reaches the bucket under any other name must also block both rollbacks (name-agnostic checks).
await db.exec(`create policy "renamed by hand" on storage.objects for select to authenticated using (bucket_id = 'asset-evidence')`);
e = await errOf(() => inTxn(STORAGE_RB));
ok(e && /still reaches asset-evidence/.test(e.message)
   && (await q(`select count(*)::int n from pg_policies where policyname like 'asset_evidence%'`))[0].n === 2,
  'storage rollback is undone if any policy still reaches the bucket', e?.message);
await db.exec(`drop policy "renamed by hand" on storage.objects`);
e = await errOf(() => inTxn(`SET LOCAL ROLE cli_postgres;\n${STORAGE_RB}`));
ok(e && /does not own storage\.objects/.test(e.message), 'storage rollback refused for a non-owner login', e?.message);
e = await errOf(() => inTxn(STORAGE_RB));
ok(!e && (await q(`select count(*)::int n from pg_policies where policyname like 'asset_evidence%'`))[0].n === 0, 'storage rollback removes both policies', e?.message);
e = await errOf(() => inTxn(CORE_RB));
ok(e && /holds assets/.test(e.message), 'core rollback refuses while the register holds assets', e?.message);
await db.exec(`delete from storage.objects where bucket_id = 'asset-evidence'`);
e = await errOf(() => inTxn(`SET LOCAL asset_register.rollback_discard_data = 'yes';\n${CORE_RB}`));
const left = (await q(`select (select count(*) from pg_class where relname in ('assets','asset_events','asset_import_batches','asset_code_seq'))::int rels,
  (select count(*) from pg_proc where proname like '%asset_register%')::int fns, (select count(*) from storage.buckets where id = 'asset-evidence')::int b`))[0];
ok(!e && left.rels === 0 && left.fns === 0 && left.b === 0, 'core rollback with explicit discard removes every object and the empty bucket', e?.message ?? JSON.stringify(left));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
