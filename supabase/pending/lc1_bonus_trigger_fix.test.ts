// Private in-memory tests for the LC1 bonus trigger fix. Never touches the live database.
// Run: NODE_PATH=/dev-server/node_modules bun supabase/pending/lc1_bonus_trigger_fix.test.ts
// Live definitions copied verbatim: pay_lc1_registration_verified_bonus + its trigger,
// trg_sync_landlord_verified_on_pipeline_approval declaration. Ledger is a minimal stub
// with the same idempotency behaviour (unique key per transaction).
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const db = new PGlite();
const ok: boolean[] = [];
const check = (n: string, pass: boolean, got: unknown) => { ok.push(pass); console.log((pass ? "PASS " : "FAIL ") + n.padEnd(52), JSON.stringify(got)); };
const one = async (s: string) => (await db.query(s)).rows[0] as any;

await db.exec(`
create table landlords(id uuid primary key, name text, phone text, mobile_money_number text, registered_by uuid, verified boolean, verification_status text, verification_source text, verification_reason text, verified_at timestamptz, verified_by uuid, verification_updated_at timestamptz, verified_mobile_money_number text, verified_mobile_money_set_at timestamptz, verified_mobile_money_source text, registration_verification_bonus_paid boolean default false, registration_verification_bonus_paid_at timestamptz);
create table lc1_chairpersons(id uuid primary key, name text, registered_by uuid, verified boolean default false, verification_status text default 'pending', verification_reason text, verified_at timestamptz, verified_by uuid, registration_verification_bonus_paid boolean default false, registration_verification_bonus_paid_at timestamptz);
create table rent_requests(id uuid primary key, landlord_id uuid, lc1_id uuid, landlord_ops_reviewed_at timestamptz, landlord_ops_reviewed_by uuid, status text, amount_repaid numeric default 0);
create table audit_logs(id uuid default gen_random_uuid(), user_id uuid, action_type text, table_name text, record_id text, metadata jsonb, reason text, created_at timestamptz default now());
create table general_ledger(id serial, user_id uuid, amount numeric, direction text, category text, idem text);
create table wallets(user_id uuid primary key, withdrawable_balance numeric);
create function create_ledger_transaction(e jsonb, k text) returns void language plpgsql as $$
declare x jsonb; begin
  if exists(select 1 from general_ledger where idem=k) then raise exception 'duplicate idempotency key %', k; end if;
  for x in select * from jsonb_array_elements(e) loop
    insert into general_ledger(user_id,amount,direction,category,idem) values ((x->>'user_id')::uuid,(x->>'amount')::numeric,x->>'direction',x->>'category',k);
    if x->>'category'='agent_commission' then update wallets set withdrawable_balance=withdrawable_balance+(x->>'amount')::numeric where user_id=(x->>'user_id')::uuid; end if;
  end loop; end $$;
`);
// live bonus function, verbatim from production
await db.exec(`
CREATE OR REPLACE FUNCTION public.pay_lc1_registration_verified_bonus() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NEW.verified = true AND (TG_OP = 'INSERT' OR OLD.verified IS DISTINCT FROM true) AND NEW.registered_by IS NOT NULL AND COALESCE(NEW.registration_verification_bonus_paid, false) = false THEN
    PERFORM public.create_ledger_transaction(jsonb_build_array(
        jsonb_build_object('user_id', NEW.registered_by,'amount',2000,'direction','cash_in','category','agent_commission','ledger_scope','wallet','recipient_type','user','source_table','lc1_chairpersons','source_id',NEW.id::text,'currency','UGX'),
        jsonb_build_object('user_id', NEW.registered_by,'amount',2000,'direction','cash_out','category','marketing_expense','ledger_scope','platform','source_table','lc1_chairpersons','source_id',NEW.id::text,'currency','UGX')),
      'lc1_reg_verify_v1:' || NEW.id::text);
    UPDATE public.lc1_chairpersons SET registration_verification_bonus_paid = true, registration_verification_bonus_paid_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END; $function$;
CREATE TRIGGER trg_pay_lc1_registration_verified_bonus AFTER INSERT OR UPDATE ON public.lc1_chairpersons FOR EACH ROW WHEN ((new.verified IS TRUE)) EXECUTE FUNCTION pay_lc1_registration_verified_bonus();
`);

// live landlord gate + bonus function + triggers, verbatim from production
await db.exec(readFileSync("/tmp/s14g/landlord_live.sql","utf8"));
await db.exec(`create role anon; create role authenticated;`);
await db.exec(readFileSync("/dev-server/supabase/pending/lc1_bonus_trigger_fix.sql", "utf8"));
await db.exec(`CREATE TRIGGER trg_sync_landlord_verified_on_pipeline_approval AFTER INSERT OR UPDATE OF landlord_ops_reviewed_at, landlord_ops_reviewed_by, status ON public.rent_requests FOR EACH ROW EXECUTE FUNCTION sync_landlord_verified_on_pipeline_approval();`);

const AG = "e1bb1b7c-14a6-4a25-a82c-dffe345b7170", REV = "5295252d-f477-42a9-92f5-af56e503e33d";
let n = 0;
// Legacy plan: reviewed long ago, LC1 still unverified (exactly the Nyanzi state).
const legacy = async () => { n++; const lc = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, rr = `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;
  await db.exec(`alter table rent_requests disable trigger trg_sync_landlord_verified_on_pipeline_approval;
    insert into lc1_chairpersons(id,name,registered_by) values ('${lc}','LC ${n}','${AG}');
    insert into rent_requests values ('${rr}',null,'${lc}','2026-08-27 12:06:25+00','${REV}','repaying',100);
    alter table rent_requests enable trigger trg_sync_landlord_verified_on_pipeline_approval;`); return { lc, rr }; };
const state = async (lc: string) => one(`select (select verified from lc1_chairpersons where id='${lc}') v,(select count(*)::int from general_ledger where idem='lc1_reg_verify_v1:${lc}') legs,(select withdrawable_balance::text from wallets where user_id='${AG}') w,(select count(*)::int from general_ledger where category='marketing_expense') mkt`);
await db.exec(`insert into wallets values ('${AG}',2410.32)`);
const quiet = (s: any, s0: any) => s.v === false && s.legs === 0 && s.w === s0.w && s.mkt === s0.mkt;

let c = await legacy(); let s0 = await state(c.lc);
await db.exec(`update rent_requests set status='repaying' where id='${c.rr}'`);
check("A unchanged status='repaying'", quiet(await state(c.lc), s0), await state(c.lc));

c = await legacy(); s0 = await state(c.lc);
await db.exec(`update rent_requests set amount_repaid=amount_repaid+5000, status='repaying' where id='${c.rr}'`);
check("B repayment (amount + status write)", quiet(await state(c.lc), s0), await state(c.lc));

c = await legacy(); s0 = await state(c.lc);
await db.exec(`update rent_requests set amount_repaid=amount_repaid-5000, status='repaying' where id='${c.rr}'`);
check("C reversal (amount down + status write)", quiet(await state(c.lc), s0), await state(c.lc));

c = await legacy(); s0 = await state(c.lc);
await db.exec(`update rent_requests set amount_repaid=amount_repaid-9200, status='repaying' where id='${c.rr}'`); // Batch 1 shape
check("D accounting correction (Batch 1 shape)", quiet(await state(c.lc), s0), await state(c.lc));

c = await legacy(); s0 = await state(c.lc);
await db.exec(`update rent_requests set status='completed' where id='${c.rr}'; update rent_requests set status='repaying' where id='${c.rr}'`);
check("E settlement rebuild / status rewrite", quiet(await state(c.lc), s0), await state(c.lc));

c = await legacy(); s0 = await state(c.lc);
await db.exec(`update rent_requests set status=status, landlord_ops_reviewed_at=landlord_ops_reviewed_at, landlord_ops_reviewed_by=landlord_ops_reviewed_by where id='${c.rr}'`);
check("F admin refresh (same status + review fields)", quiet(await state(c.lc), s0), await state(c.lc));

// G: fresh plan, genuine review NULL -> set
n++; const glc = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, grr = `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;
await db.exec(`insert into lc1_chairpersons(id,name,registered_by) values ('${glc}','LC G','${AG}'); insert into rent_requests(id,lc1_id,status) values ('${grr}','${glc}','pending');`);
const gw0 = (await state(glc)).w;
await db.exec(`update rent_requests set landlord_ops_reviewed_at='2026-08-01 09:00+00', landlord_ops_reviewed_by='${REV}' where id='${grr}'`);
const g = await one(`select c.verified, c.verified_by::text vb, c.verified_at > '2026-09-01' real_time, c.verification_reason, (select count(*)::int from general_ledger where idem='lc1_reg_verify_v1:${glc}') legs, (select withdrawable_balance::text from wallets where user_id='${AG}') w, (select count(*)::int from audit_logs where action_type='lc1_verified_at_landlord_review' and record_id='${glc}') audit from lc1_chairpersons c where id='${glc}'`);
check("G genuine review: verified once, real time, paid once", g.verified && g.vb === REV && g.real_time && g.legs === 2 && Math.round((Number(g.w) - Number(gw0))*100) === 200000 && g.audit === 1, g);

await db.exec(`update rent_requests set landlord_ops_reviewed_at=landlord_ops_reviewed_at, landlord_ops_reviewed_by=landlord_ops_reviewed_by, status='funded' where id='${grr}'`);
const h = await state(glc);
check("H repeated review write after review", h.legs === 2 && h.w === g.w, h);

// I: already-verified LC1 on a fresh plan reaching review
n++; const ilc = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, irr = `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;
await db.exec(`insert into lc1_chairpersons(id,name,registered_by,verified,verification_status,registration_verification_bonus_paid) values ('${ilc}','LC I','${AG}',true,'verified',true); insert into rent_requests(id,lc1_id,status) values ('${irr}','${ilc}','pending');`);
const iw0 = (await state(ilc)).w;
await db.exec(`update rent_requests set landlord_ops_reviewed_at=now(), landlord_ops_reviewed_by='${REV}' where id='${irr}'`);
const i = await state(ilc);
check("I already-verified LC1: no duplicate bonus", i.legs === 0 && i.w === iw0, i);


// ---------- Landlord path ----------
const lstate = async (ll: string) => one(`select (select verified from landlords where id='${ll}') v,(select count(*)::int from general_ledger where idem='landlord_reg_verify_v2:${ll}') legs,(select withdrawable_balance::text from wallets where user_id='${AG}') w`);
const llegacy = async () => { n++; const ll = `22222222-0000-4000-8000-${String(n).padStart(12, "0")}`, rr = `33333333-0000-4000-8000-${String(n).padStart(12, "0")}`;
  await db.exec(`alter table rent_requests disable trigger trg_sync_landlord_verified_on_pipeline_approval;
    insert into landlords(id,name,phone,registered_by) values ('${ll}','LL ${n}','0700000${n}','${AG}');
    insert into rent_requests values ('${rr}','${ll}',null,'2026-08-27 12:06:25+00','${REV}','repaying',100);
    alter table rent_requests enable trigger trg_sync_landlord_verified_on_pipeline_approval;`); return { ll, rr }; };
const lquiet = (s: any, s0: any) => s.v === false && s.legs === 0 && s.w === s0.w;
const lcases: [string, (rr: string) => string][] = [
  ["LA unchanged status='repaying'", rr => `update rent_requests set status='repaying' where id='${rr}'`],
  ["LB repayment", rr => `update rent_requests set amount_repaid=amount_repaid+5000, status='repaying' where id='${rr}'`],
  ["LC reversal", rr => `update rent_requests set amount_repaid=amount_repaid-5000, status='repaying' where id='${rr}'`],
  ["LD accounting correction (Batch 1 shape)", rr => `update rent_requests set amount_repaid=amount_repaid-9200, status='repaying' where id='${rr}'`],
  ["LE settlement/status rebuild", rr => `update rent_requests set status='completed' where id='${rr}'; update rent_requests set status='repaying' where id='${rr}'`],
  ["LF admin refresh (same values)", rr => `update rent_requests set status=status, landlord_ops_reviewed_by=landlord_ops_reviewed_by where id='${rr}'`],
  ["LF2 re-save existing review date", rr => `update rent_requests set landlord_ops_reviewed_at=landlord_ops_reviewed_at where id='${rr}'`],
  ["LF3 other ordinary update (amount only)", rr => `update rent_requests set amount_repaid=amount_repaid+1 where id='${rr}'`],
];
for (const [name, sql] of lcases) { const c = await llegacy(); const s0 = await lstate(c.ll); await db.exec(sql(c.rr)); check(name, lquiet(await lstate(c.ll), s0), await lstate(c.ll)); }

n++; const gll = `22222222-0000-4000-8000-${String(n).padStart(12, "0")}`, glr = `33333333-0000-4000-8000-${String(n).padStart(12, "0")}`;
await db.exec(`insert into landlords(id,name,phone,registered_by) values ('${gll}','LL G','0711111111','${AG}'); insert into rent_requests(id,landlord_id,status) values ('${glr}','${gll}','pending');`);
const lw0 = (await lstate(gll)).w;
await db.exec(`update rent_requests set landlord_ops_reviewed_at='2026-08-01 09:00+00', landlord_ops_reviewed_by='${REV}' where id='${glr}'`);
const lg = await one(`select l.verified, l.verification_status, l.verified_by::text vb, l.verified_at > '2026-09-01' real_time, (select count(*)::int from general_ledger where idem='landlord_reg_verify_v2:${gll}') legs, (select withdrawable_balance::text from wallets where user_id='${AG}') w, (select count(*)::int from audit_logs where action_type='landlord_verified_at_landlord_review' and record_id='${gll}') audit from landlords l where id='${gll}'`);
check("LG genuine review: verified once, real time, paid 5,000 once", lg.verified && lg.verification_status === 'verified' && lg.vb === REV && lg.real_time && lg.legs === 2 && Math.round((Number(lg.w) - Number(lw0)) * 100) === 500000 && lg.audit === 1, lg);
await db.exec(`update rent_requests set landlord_ops_reviewed_at=landlord_ops_reviewed_at, status='funded' where id='${glr}'`);
const lh = await lstate(gll);
check("LH repeated review write: no second bonus", lh.legs === 2 && lh.w === lg.w, lh);

n++; const ill = `22222222-0000-4000-8000-${String(n).padStart(12, "0")}`, ilr = `33333333-0000-4000-8000-${String(n).padStart(12, "0")}`;
await db.exec(`insert into landlords(id,name,phone,registered_by,verified,verification_status,registration_verification_bonus_paid) values ('${ill}','LL I','0722222222','${AG}',true,'verified',true); insert into rent_requests(id,landlord_id,status) values ('${ilr}','${ill}','pending');`);
const liw = (await lstate(ill)).w;
await db.exec(`update rent_requests set landlord_ops_reviewed_at=now(), landlord_ops_reviewed_by='${REV}' where id='${ilr}'`);
const li = await lstate(ill);
check("LI already-verified landlord: no duplicate bonus", li.legs === 0 && li.w === liw, li);

// Combined: one genuine review of a plan with both an unverified landlord and LC1
n++; const cll = `22222222-0000-4000-8000-${String(n).padStart(12, "0")}`, clc = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, crr = `33333333-0000-4000-8000-${String(n).padStart(12, "0")}`;
await db.exec(`insert into landlords(id,name,phone,registered_by) values ('${cll}','LL J','0733333333','${AG}'); insert into lc1_chairpersons(id,name,registered_by) values ('${clc}','LC J','${AG}'); insert into rent_requests(id,landlord_id,lc1_id,status) values ('${crr}','${cll}','${clc}','pending');`);
const cw0 = (await lstate(cll)).w;
await db.exec(`update rent_requests set landlord_ops_reviewed_at=now(), landlord_ops_reviewed_by='${REV}' where id='${crr}'; update rent_requests set status='repaying' where id='${crr}'; update rent_requests set status='repaying' where id='${crr}';`);
const cj = await one(`select (select withdrawable_balance::text from wallets where user_id='${AG}') w`);
check("J both on one review: 5,000 + 2,000 once, later writes add 0", Math.round((Number(cj.w) - Number(cw0)) * 100) === 700000, cj);

// Install safety: re-running the migration on existing state moves nothing
const pre = await one(`select (select count(*)::int from general_ledger) gl,(select count(*)::int from lc1_chairpersons where verified) v,(select count(*)::int from landlords where verified) lv,(select withdrawable_balance::text from wallets) w,(select md5(string_agg(r::text,',' order by id)) from rent_requests r) rr`);
await db.exec(readFileSync("/dev-server/supabase/pending/lc1_bonus_trigger_fix.sql", "utf8"));
await db.exec(readFileSync("/dev-server/supabase/pending/lc1_bonus_trigger_fix.sql", "utf8"));
const post = await one(`select (select count(*)::int from general_ledger) gl,(select count(*)::int from lc1_chairpersons where verified) v,(select count(*)::int from landlords where verified) lv,(select withdrawable_balance::text from wallets) w,(select md5(string_agg(r::text,',' order by id)) from rent_requests r) rr`);
check("Install twice: no ledger/wallet/verification/plan change", JSON.stringify(pre) === JSON.stringify(post), post);

console.log(`\n${ok.filter(Boolean).length}/${ok.length} passed`);
process.exit(ok.every(Boolean) ? 0 : 1);
