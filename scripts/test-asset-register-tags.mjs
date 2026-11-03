// Run: node scripts/test-asset-register-tags.mjs   (needs @electric-sql/pglite; exit code 1 on any failure)
// Asset tags (WEL-<category>-<site>-<register number>) on top of the Asset Register: applies
// 20261026200000 (core) + 20261026200100 (storage policies) + 20261027150000 (asset tags) to an embedded Postgres
// (PGlite) with the same Supabase stand-ins as scripts/test-asset-register.mjs and the production role / MFA helpers,
// registers one asset BEFORE the tag migration (like production's WEL-AST-000001), then checks tag issue, fixity,
// uniqueness, sites, search, import, access, the pending backfill and the rollback. A local pass does not prove production.
import fs from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => fs.readFileSync(here(p), 'utf8').replace(/\r/g, '');
const CORE = read('../supabase/migrations/20261026200000_asset_register_stage1.sql');
const STORAGE = read('../supabase/migrations/20261026200100_asset_register_stage1_storage_policies.sql');
const TAGS = read('../supabase/migrations/20261027150000_asset_register_asset_tags.sql');
const TAGS_RB = read('../supabase/rollbacks/20261027150000_asset_register_asset_tags.rollback.sql');
const CORE_RB = read('../supabase/rollbacks/20261026200000_asset_register_stage1.rollback.sql');
const BACKFILL = read('../docs/pending-migrations/asset_register_tag_backfill_wel_ast_000001.sql');
const HELPERS = read('./fixtures/asset-register-helpers.sql');

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } };
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const inTxn = (sql) => db.exec(`BEGIN;\n${sql}\nCOMMIT;`).catch(async (e) => { await db.exec('ROLLBACK').catch(() => {}); throw e; });
const asUser = async (userId, fn, { aal = 'aal2', role = 'authenticated', keep = false } = {}) => {
  await db.exec('BEGIN');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role, aal })]);
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
const fnMd5 = async () => Object.fromEntries((await q(`
  select p.oid::regprocedure::text f, md5(replace(p.prosrc, chr(13), '')) m from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('_asset_register_validate', '_asset_register_row_json', '_asset_register_insert',
                       '_asset_register_guard_identity', 'asset_register_update', 'asset_register_list',
                       'asset_register_reference_data')`)).map((r) => [r.f, r.m]));

// ---- Supabase stand-ins (same as scripts/test-asset-register.mjs) ---------------------------------------
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role supabase_storage_admin nologin;
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
alter schema storage owner to supabase_storage_admin;
alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
`);
await db.exec('set check_function_bodies = off;\n' + HELPERS + '\nset check_function_bodies = on;');

const cfo = uuid(), admin = uuid(), coo = uuid(), ceo = uuid(), cto = uuid();
for (const [id, name] of [[cfo, 'Cfo User'], [admin, 'Super Admin'], [coo, 'Coo User'], [ceo, 'Ceo User'], [cto, 'Cto User']]) {
  await db.query('insert into public.profiles (id, full_name) values ($1, $2)', [id, name]);
}
await db.query(`insert into public.user_roles (user_id, role) values ($1,'cfo'), ($2,'super_admin'), ($3,'coo'), ($4,'ceo'), ($5,'cto')`,
  [cfo, admin, coo, ceo, cto]);
await db.exec(`insert into public.hr_departments values ('engineering', 'Engineering', true);`);

const create = (who, asset) => asUser(who, () => q(`select public.asset_register_create($1::jsonb) a`, [JSON.stringify(asset)]), { keep: true });
const getA = async (code) => (await q(`select * from public.assets where asset_code = $1`, [code]))[0];

// ---- 1. Production-like starting point: core + storage applied, one asset registered before tags ---------
let e = await errOf(() => inTxn(CORE));
ok(!e, 'core migration applies', e?.message);
e = await errOf(() => inTxn(STORAGE));
ok(!e, 'storage-policy migration applies', e?.message);
const policiesBefore = await q(`select policyname, cmd, qual, with_check from pg_policies where schemaname = 'storage' order by policyname`);
let r = await create(cfo, { name: 'Laptop', category: 'it_equipment', location: 'Entebbe Head Office', department_key: 'engineering' });
ok(r.out?.[0].a.asset_code === 'WEL-AST-000001', 'pre-tag asset registered as WEL-AST-000001 (mirrors production)', JSON.stringify(r.out ?? r.err?.message));
const legacyId = r.out?.[0].a.id;
const legacyBefore = await getA('WEL-AST-000001');

// ---- 2. Migration preflight ----------------------------------------------------------------------------
// A changed function in the target database must stop the migration before it changes anything.
await db.exec('BEGIN');
await db.exec(`CREATE OR REPLACE FUNCTION public.asset_register_reference_data() RETURNS jsonb LANGUAGE sql STABLE AS $$ select '{}'::jsonb $$`);
e = await errOf(() => db.exec(TAGS));
await db.exec('ROLLBACK');
ok(e && /function changed since 2026-10-27/.test(e.message), 'migration refuses when a replaced function differs from the pinned production version', e?.message);
ok((await q(`select to_regclass('public.asset_sites') t`))[0].t === null, 'the refusal left nothing behind');
e = await errOf(() => inTxn(TAGS));
ok(!e, 'asset tag migration applies on the production-pinned functions (md5 pins match the core file)', e?.message);
e = await errOf(() => inTxn(TAGS));
ok(e && /already exist/.test(e.message), 'asset tag migration refuses a second run', e?.message);

// ---- 3. Existing data is untouched; the migration tags nothing ------------------------------------------
const legacyAfter = await getA('WEL-AST-000001');
ok(legacyAfter.asset_tag === null && legacyAfter.site_key === null && legacyAfter.updated_at.getTime() === legacyBefore.updated_at.getTime()
   && legacyAfter.id === legacyId, 'WEL-AST-000001 keeps its uuid and code, gets no tag or site, and is not modified', JSON.stringify(legacyAfter));
ok((await q(`select count(*)::int n from public.asset_events`))[0].n === 1, 'no history rows written by the migration');
ok(JSON.stringify(await q(`select policyname, cmd, qual, with_check from pg_policies where schemaname = 'storage' order by policyname`))
   === JSON.stringify(policiesBefore), 'evidence storage policies unchanged');

// ---- 4. Sites ------------------------------------------------------------------------------------------
const sites = await q(`select key, name, tag_code, active from public.asset_sites order by key`);
ok(JSON.stringify(sites) === JSON.stringify([
  { key: 'entebbe_hq', name: 'Entebbe Head Office', tag_code: 'HQ', active: true },
  { key: 'kololo', name: 'Kololo', tag_code: 'KOL', active: true }]), 'sites seeded: Entebbe Head Office = HQ, Kololo = KOL', JSON.stringify(sites));
r = await asUser(cfo, () => q(`select public.asset_register_reference_data() x`));
ok(JSON.stringify(r.out?.[0].x.sites) === JSON.stringify([
  { key: 'entebbe_hq', name: 'Entebbe Head Office', tag_code: 'HQ' }, { key: 'kololo', name: 'Kololo', tag_code: 'KOL' }]),
  'reference data lists the active sites for the picker', JSON.stringify(r.out ?? r.err?.message));
r = await asUser(cfo, () => q(`select count(*)::int n from public.asset_sites`));
ok(r.out?.[0].n === 2, 'cfo can read the sites through RLS', JSON.stringify(r.out ?? r.err?.message));
r = await asUser(coo, () => q(`select count(*)::int n from public.asset_sites`));
ok(r.out?.[0].n === 0, 'coo sees no sites through RLS', JSON.stringify(r.out ?? r.err?.message));
r = await asUser(null, () => q(`select count(*)::int n from public.asset_sites`), { role: 'anon' });
ok(r.err && /permission denied/.test(r.err.message), 'anon has no access to the sites table', r.err?.message);
r = await asUser(cfo, () => q(`insert into public.asset_sites (key, name, tag_code) values ('jinja', 'Jinja', 'JIN')`));
ok(r.err && /permission denied/.test(r.err.message), 'signed-in users cannot add sites (managed by migration only)', r.err?.message);
e = await errOf(() => db.exec(`update public.asset_sites set tag_code = 'HO' where key = 'entebbe_hq'`));
ok(e && /SITE_IDENTITY_IMMUTABLE/.test(e.message), 'a site tag code cannot change, even for the owner', e?.message);
e = await errOf(() => db.exec(`delete from public.asset_sites where key = 'kololo'`));
ok(e, 'sites cannot be deleted, even by the owner', e?.message);
ok((await q(`select has_table_privilege('authenticated', 'public.asset_sites', 'SELECT') s, has_table_privilege('authenticated', 'public.asset_sites', 'INSERT') i`))[0].s === true,
  'authenticated has SELECT on asset_sites (RLS is the gate)');
ok((await q(`select count(*)::int n from pg_policies where tablename = 'asset_sites' and policyname = 'mfa_required_for_staff' and permissive = 'RESTRICTIVE'`))[0].n === 1,
  'asset_sites carries the restrictive staff-MFA policy');

// ---- 5. Tag issue on create ----------------------------------------------------------------------------
r = await asUser(cfo, () => q(`select public.asset_register_create($1::jsonb) a`, [JSON.stringify({ name: 'Desk', category: 'furniture' })]));
ok(r.err?.code === '22023' && /"field": "site_key", "message": "Site is required"/.test(r.err.detail ?? ''), 'create without a site is refused (Site is required)', r.err?.detail ?? r.err?.message);
r = await asUser(cfo, () => q(`select public.asset_register_create($1::jsonb) a`, [JSON.stringify({ name: 'Desk', category: 'furniture', site_key: 'jinja' })]));
ok(r.err?.code === '22023' && /Site is not an active site/.test(r.err.detail ?? ''), 'create with an unknown site is refused', r.err?.detail ?? r.err?.message);
r = await asUser(cfo, () => q(`select public.asset_register_create($1::jsonb) a`, [JSON.stringify({ name: 'Desk', category: 'furniture', site_key: 'kololo', asset_tag: 'WEL-FUR-KOL-777' })]));
ok(r.err?.code === '22023' && /"field": "asset_tag", "message": "Unknown or read-only field"/.test(r.err.detail ?? ''), 'a caller-supplied asset_tag is refused (server-issued only)', r.err?.detail ?? r.err?.message);
ok((await q(`select last_value::int v from public.asset_code_seq`))[0].v === 1, 'refused creates consumed no register numbers');

r = await create(cfo, { name: 'Dell laptop', category: 'it_equipment', site_key: 'kololo', location: 'Front desk' });
const kol = r.out?.[0].a;
ok(kol?.asset_code === 'WEL-AST-000002' && kol?.asset_tag === 'WEL-ICT-KOL-002' && kol?.site_key === 'kololo' && kol?.site_name === 'Kololo',
  'register number 002, ICT at Kololo -> WEL-ICT-KOL-002 (code WEL-AST-000002 kept)', JSON.stringify(r.out ?? r.err?.message));
const expectTags = [
  [{ name: 'Office desk', category: 'furniture', site_key: 'entebbe_hq' }, 'WEL-AST-000003', 'WEL-FUR-HQ-003'],
  [{ name: 'Printer', category: 'office_equipment', site_key: 'kololo' }, 'WEL-AST-000004', 'WEL-OFE-KOL-004'],
  [{ name: 'Company van', category: 'company_vehicles', site_key: 'entebbe_hq' }, 'WEL-AST-000005', 'WEL-VEH-HQ-005'],
  [{ name: 'Generator', category: 'machinery', site_key: 'kololo' }, 'WEL-AST-000006', 'WEL-MAC-KOL-006'],
  [{ name: 'Water dispenser', category: 'other', site_key: 'entebbe_hq' }, 'WEL-AST-000007', 'WEL-OTH-HQ-007'],
  [{ name: 'HQ laptop', category: 'it_equipment', site_key: 'entebbe_hq' }, 'WEL-AST-000008', 'WEL-ICT-HQ-008'],
];
for (const [asset, code, tag] of expectTags) {
  r = await create(admin, asset);
  ok(r.out?.[0].a.asset_code === code && r.out[0].a.asset_tag === tag, `${asset.category} at ${asset.site_key}: ${code} -> ${tag}`, JSON.stringify(r.out ?? r.err?.message));
}
const created = (await q(`select new_values from public.asset_events where asset_id = $1 and event_type = 'created'`, [kol.id]))[0];
ok(created?.new_values.asset_tag === 'WEL-ICT-KOL-002' && created.new_values.site_key === 'kololo', 'the creation history records the issued tag and site');

// ---- 6. Tags are fixed once issued -------------------------------------------------------------------
const upd = (who, id, changes, reason = null) => asUser(who, async () => {
  const cur = (await q(`select updated_at from public.assets where id = $1`, [id]))[0].updated_at;
  return (await q(`select public.asset_register_update($1, $2, $3::jsonb, $4) a`, [id, cur, JSON.stringify(changes), reason]))[0].a;
}, { keep: true });
r = await upd(cfo, kol.id, { site_key: 'entebbe_hq', category: 'furniture', location: 'Store' }, 'Moved to head office store');
ok(r.out?.asset_tag === 'WEL-ICT-KOL-002' && r.out.site_key === 'entebbe_hq' && r.out.category === 'furniture' && r.out.site_name === 'Entebbe Head Office',
  'moving site and changing category keeps the issued tag WEL-ICT-KOL-002', JSON.stringify(r.out ?? r.err?.message));
const ev = (await q(`select changed_fields, old_values, new_values from public.asset_events where asset_id = $1 and event_type = 'updated'`, [kol.id]))[0];
ok(JSON.stringify([...ev.changed_fields].sort()) === JSON.stringify(['category', 'location', 'site_key']) && ev.old_values.site_key === 'kololo'
   && !('asset_tag' in ev.new_values), 'history records the site / category change and no tag change', JSON.stringify(ev));
r = await upd(cfo, kol.id, { site_key: null });
ok(r.err?.code === '22023' && /Site is required/.test(r.err.detail ?? ''), 'the site cannot be cleared on update', r.err?.detail ?? r.err?.message);
r = await upd(cfo, kol.id, { asset_tag: 'WEL-ICT-HQ-002' });
ok(r.err?.code === '22023' && /asset_tag/.test(r.err.detail ?? ''), 'the tag cannot be edited through the update RPC', r.err?.detail ?? r.err?.message);
e = await errOf(() => db.exec(`update public.assets set asset_tag = 'WEL-ICT-HQ-002' where id = '${kol.id}'`));
ok(e && /ASSET_TAG_IMMUTABLE/.test(e.message), 'an issued tag cannot be changed directly, even by the owner', e?.message);
e = await errOf(() => db.exec(`update public.assets set asset_tag = null where id = '${kol.id}'`));
ok(e && /ASSET_TAG_IMMUTABLE/.test(e.message), 'an issued tag cannot be removed, even by the owner', e?.message);
e = await errOf(() => db.exec(`update public.assets set site_key = 'entebbe_hq', asset_tag = 'WEL-ICT-HQ-999' where id = '${legacyId}'`));
ok(e && /ASSET_TAG_MISMATCH/.test(e.message), 'an untagged asset cannot be given an arbitrary tag (only its computed one)', e?.message);
r = await upd(cfo, legacyId, { notes: 'Checked' });
ok(r.out?.asset_tag === null, 'editing an untagged (pre-tag) asset never issues a tag silently', JSON.stringify(r.out ?? r.err?.message));
r = await upd(cfo, legacyId, { site_key: 'entebbe_hq' });
ok(r.out?.site_key === 'entebbe_hq' && r.out?.asset_tag === null, 'setting a site on a pre-tag asset still issues no tag', JSON.stringify(r.out ?? r.err?.message));

// ---- 7. Uniqueness and format (database backstops) ----------------------------------------------------
const ins = (code, tag, site = 'kololo') => errOf(() => db.exec(`insert into public.assets (asset_code, asset_tag, site_key, name, category, created_by, updated_by)
  values ('${code}', ${tag === null ? 'null' : `'${tag}'`}, ${site === null ? 'null' : `'${site}'`}, 'Probe', 'it_equipment', '${cfo}', '${cfo}')`));
e = await ins('WEL-AST-090001', 'WEL-ICT-KOL-002');
ok(e?.code === '23505', 'a duplicate tag is refused by the unique constraint', e?.message);
e = await ins('WEL-AST-090002', 'WEL-ICT-HQ-001 ');
ok(e?.code === '23514', 'a tag with stray spaces fails the format check', e?.message);
e = await ins('WEL-AST-090003', 'WEL-XYZ-HQ-001');
ok(e?.code === '23514', 'an unknown category code fails the format check', e?.message);
e = await ins('WEL-AST-090004', 'WEL-ICT-HQ-9', 'entebbe_hq');
ok(e?.code === '23514', 'a register number shorter than 3 digits fails the format check', e?.message);
e = await ins('WEL-AST-090005', 'WEL-ICT-HQ-090005', null);
ok(e?.code === '23514', 'a tag without a site is refused', e?.message);
const dupTags = (await q(`select count(*)::int n from (select asset_tag from public.assets where asset_tag is not null group by asset_tag having count(*) > 1) d`))[0].n;
ok(dupTags === 0, 'no duplicate tags in the register');
ok((await q(`select count(*)::int n from public.assets where asset_tag is not null and asset_tag = asset_code`))[0].n === 0, 'tags never collide with WEL-AST codes (different prefix)');

// ---- 8. Search, detail and QR identity ---------------------------------------------------------------
r = await asUser(cfo, async () => ({
  byTag: (await q(`select public.asset_register_list('WEL-ICT-KOL-002') x`))[0].x,
  byPartial: (await q(`select public.asset_register_list('ict-kol') x`))[0].x,
  bySite: (await q(`select public.asset_register_list('Kololo') x`))[0].x,
  byCode: (await q(`select public.asset_register_list('WEL-AST-000002') x`))[0].x,
  detail: (await q(`select public.asset_register_get($1) x`, [kol.id]))[0].x,
}));
const o = r.out ?? {};
ok(o.byTag?.total_count === 1 && o.byTag.items[0].id === kol.id, 'search by full tag finds the asset', JSON.stringify(o.byTag ?? r.err?.message));
ok(o.byPartial?.items.some((a) => a.id === kol.id), 'search by part of a tag finds it');
ok(o.bySite?.items.length === 2 && o.bySite.items.every((a) => a.site_key === 'kololo'), 'search by site name finds the assets at that site', JSON.stringify(o.bySite?.items.map((a) => a.asset_tag)));
ok(o.byCode?.total_count === 1 && o.byCode.items[0].asset_tag === 'WEL-ICT-KOL-002', 'search by permanent code still works and returns the tag');
ok(o.detail?.asset.id === kol.id && o.detail.asset.asset_tag === 'WEL-ICT-KOL-002' && o.detail.asset.asset_code === 'WEL-AST-000002'
   && o.detail.asset.site_name === 'Entebbe Head Office', 'asset_register_get(uuid) returns tag, permanent code and site name', JSON.stringify(o.detail?.asset));
r = await asUser(cfo, () => q(`select public.asset_register_get($1) x`, ['WEL-ICT-KOL-002']));
ok(r.err?.code === '22P02', 'a tag is not accepted in place of the uuid (QR stays uuid-based)', r.err?.message);

// ---- 9. Import ----------------------------------------------------------------------------------------
const sha = (c) => c.repeat(64);
r = await asUser(cfo, () => q(`select public.asset_register_import_commit('sites.xlsx', $1, $2::jsonb) x`, [sha('a'), JSON.stringify([
  { row_ref: 2, name: 'Chair', category: 'furniture', site_key: 'kololo' },
  { row_ref: 3, name: 'Monitor', category: 'it_equipment', site_key: 'entebbe_hq' }])]), { keep: true });
const imp = r.out?.[0].x;
const impTags = (await q(`select asset_code, asset_tag from public.assets where import_batch_id = $1 order by asset_code`, [imp?.batch_id ?? uuid()]));
ok(imp?.status === 'committed' && JSON.stringify(impTags) === JSON.stringify([
  { asset_code: 'WEL-AST-000009', asset_tag: 'WEL-FUR-KOL-009' }, { asset_code: 'WEL-AST-000010', asset_tag: 'WEL-ICT-HQ-010' }]),
  'import issues tags in register order', JSON.stringify(impTags) + JSON.stringify(imp ?? r.err?.message));
r = await asUser(cfo, () => q(`select public.asset_register_import_commit('nosite.xlsx', $1, $2::jsonb) x`, [sha('b'), JSON.stringify([
  { row_ref: 2, name: 'Shelf', category: 'furniture', site_key: 'kololo' }, { row_ref: 3, name: 'Lamp', category: 'furniture' }])]), { keep: true });
ok(r.out?.[0].x.status === 'rejected' && r.out[0].x.errors.some((x) => x.row_ref === '3' && x.field === 'site_key')
   && (await q(`select count(*)::int n from public.assets where name = 'Shelf'`))[0].n === 0,
  'an import row without a site rejects the whole file (all-or-nothing)', JSON.stringify(r.out ?? r.err?.message));

// ---- 10. Long register numbers are not truncated ------------------------------------------------------
await db.exec(`select setval('public.asset_code_seq', 1233)`);
r = await create(cfo, { name: 'Laptop 1234', category: 'it_equipment', site_key: 'kololo' });
ok(r.out?.[0].a.asset_code === 'WEL-AST-001234' && r.out[0].a.asset_tag === 'WEL-ICT-KOL-1234', 'register number 1234 -> WEL-ICT-KOL-1234 (no truncation)', JSON.stringify(r.out ?? r.err?.message));

// ---- 11. Access control unchanged ---------------------------------------------------------------------
for (const [who, id] of [['coo', coo], ['ceo', ceo], ['cto', cto]]) {
  r = await asUser(id, () => q(`select public.asset_register_get($1) x`, [kol.id]));
  ok(r.err?.code === '42501', `${who} cannot read a tagged asset (42501)`, r.err?.message);
  r = await asUser(id, () => q(`select public.asset_register_reference_data() x`));
  ok(r.err?.code === '42501', `${who} cannot read the site list through the RPC`, r.err?.message);
  r = await asUser(id, () => q(`select count(*)::int n from public.assets where asset_tag is not null`));
  ok(r.out?.[0].n === 0, `${who} sees no tagged rows through RLS`, JSON.stringify(r.out ?? r.err?.message));
}
r = await asUser(null, () => q(`select public.asset_register_list('WEL-ICT') x`), { role: 'anon' });
ok(r.err && /permission denied/.test(r.err.message), 'anon cannot search tags', r.err?.message);
for (const f of ['_asset_register_make_tag(text,text,text)', '_asset_register_category_code(text)', '_asset_register_guard_site()']) {
  ok((await q(`select has_function_privilege('authenticated', 'public.${f}', 'EXECUTE') x`))[0].x === false, `${f} is not callable by signed-in users`);
}
for (const f of ['asset_register_update(uuid,timestamptz,jsonb,text)', 'asset_register_list(text,text,text,text,text,integer,integer)', 'asset_register_reference_data()']) {
  const g = (await q(`select has_function_privilege('authenticated', 'public.${f}', 'EXECUTE') a, has_function_privilege('anon', 'public.${f}', 'EXECUTE') n`))[0];
  ok(g.a === true && g.n === false, `${f} keeps its grants (authenticated yes, anon no)`, JSON.stringify(g));
}

// ---- 12. Pending backfill for WEL-AST-000001 -> WEL-ICT-HQ-001 ----------------------------------------
await db.exec(`update public.assets set site_key = null where id = '${legacyId}'`); // undo the step-6 site test: as in production
e = await errOf(() => inTxn(BACKFILL));
ok(e && /backfill_actor must be an enabled CFO/.test(e.message), 'backfill refuses without a CFO actor', e?.message);
e = await errOf(() => inTxn(`SET LOCAL asset_register.backfill_actor = '${coo}';\n${BACKFILL}`));
ok(e && /backfill_actor must be an enabled CFO/.test(e.message), 'backfill refuses a non-CFO actor', e?.message);
await db.exec('BEGIN');
await db.exec(`update public.assets set location = 'Kololo' where id = '${legacyId}'`);
e = await errOf(() => db.exec(`SET LOCAL asset_register.backfill_actor = '${cfo}';\n${BACKFILL}`));
await db.exec('ROLLBACK');
ok(e && /no longer matches the reviewed record/.test(e.message), 'backfill refuses if the asset no longer matches the reviewed record', e?.message);
const evBefore = (await q(`select count(*)::int n from public.asset_events where asset_id = $1`, [legacyId]))[0].n;
e = await errOf(() => inTxn(`SET LOCAL asset_register.backfill_actor = '${cfo}';\n${BACKFILL}`));
const bf = await getA('WEL-AST-000001');
ok(!e && bf.asset_tag === 'WEL-ICT-HQ-001' && bf.site_key === 'entebbe_hq' && bf.id === legacyId && bf.updated_by === cfo,
  'backfill issues WEL-ICT-HQ-001 to WEL-AST-000001 (same uuid and code)', e?.message ?? JSON.stringify(bf));
const bfEv = (await q(`select changed_fields, new_values, actor_id from public.asset_events where asset_id = $1 order by created_at desc limit 1`, [legacyId]))[0];
ok((await q(`select count(*)::int n from public.asset_events where asset_id = $1`, [legacyId]))[0].n === evBefore + 1
   && bfEv.new_values.asset_tag === 'WEL-ICT-HQ-001' && bfEv.actor_id === cfo, 'backfill writes one history entry naming the CFO', JSON.stringify(bfEv));
e = await errOf(() => inTxn(`SET LOCAL asset_register.backfill_actor = '${cfo}';\n${BACKFILL}`));
ok(e && /already tagged/.test(e.message), 'backfill refuses a second run', e?.message);
ok((await q(`select count(*)::int n from public.assets where asset_tag in ('WEL-ICT-HQ-001', 'WEL-ICT-KOL-002')`))[0].n === 2,
  'both supplied codes now exist exactly once: WEL-ICT-HQ-001 (WEL-AST-000001) and WEL-ICT-KOL-002 (WEL-AST-000002)');

// ---- 13. No contact with money ------------------------------------------------------------------------
ok((await q(`select count(*)::int n from public.general_ledger`))[0].n === 2, 'general_ledger untouched');
ok((await q(`select count(*)::int n from pg_proc where proname like '%asset_register%' and prosrc ~* '(general_ledger|wallet|payment|balance)'`))[0].n === 0,
  'no asset-register function mentions the ledger, wallets, payments or balances');

// ---- 14. Rollback --------------------------------------------------------------------------------------
e = await errOf(() => inTxn(`SET LOCAL asset_register.rollback_discard_data = 'yes';\n${CORE_RB}`));
ok(e && /roll back 20261027150000/.test(e.message), 'core rollback refuses while the tag migration is applied', e?.message);
e = await errOf(() => inTxn(TAGS_RB));
ok(e && /carry a tag or site/.test(e.message) && (await q(`select to_regclass('public.asset_sites') t`))[0].t !== null,
  'tag rollback refuses while assets carry tags, changing nothing', e?.message);
const assetsBefore = (await q(`select count(*)::int n from public.assets`))[0].n;
const eventsBefore = (await q(`select count(*)::int n from public.asset_events`))[0].n;
e = await errOf(() => inTxn(`SET LOCAL asset_register.rollback_discard_tags = 'yes';\n${TAGS_RB}`));
const cols = (await q(`select count(*)::int n from information_schema.columns where table_name = 'assets' and column_name in ('asset_tag', 'site_key')`))[0].n;
ok(!e && cols === 0 && (await q(`select to_regclass('public.asset_sites') t`))[0].t === null
   && (await q(`select count(*)::int n from pg_proc where proname in ('_asset_register_make_tag', '_asset_register_category_code', '_asset_register_guard_site')`))[0].n === 0,
  'tag rollback with explicit discard removes the columns, sites table and helpers', e?.message);
ok((await q(`select count(*)::int n from public.assets`))[0].n === assetsBefore && (await q(`select count(*)::int n from public.asset_events`))[0].n === eventsBefore,
  'tag rollback keeps every asset and history row');
r = await create(cfo, { name: 'After rollback', category: 'furniture' });
ok(/^WEL-AST-\d{6}$/.test(r.out?.[0].a.asset_code ?? '') && !('asset_tag' in (r.out?.[0].a ?? {})), 'register works as before after the rollback (no site needed)', JSON.stringify(r.out ?? r.err?.message));
e = await errOf(() => inTxn(TAGS));
ok(!e, 'tag migration re-applies after its rollback (functions restored exactly)', e?.message);
ok(Object.keys(await fnMd5()).length === 7, 'all seven replaced functions present after re-apply');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
