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
create table landlords(id uuid primary key, verified boolean, verification_status text, verification_source text, verification_reason text, verified_at timestamptz, verified_by uuid);
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
check("G genuine review: verified once, real time, paid once", g.verified && g.vb === REV && g.real_time && g.legs === 2 && Number(g.w) - Number(gw0) === 2000 && g.audit === 1, g);

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

// Install safety: re-running the migration on existing state moves nothing
const pre = await one(`select (select count(*)::int from general_ledger) gl,(select count(*)::int from lc1_chairpersons where verified) v,(select withdrawable_balance::text from wallets) w`);
await db.exec(readFileSync("/dev-server/supabase/pending/lc1_bonus_trigger_fix.sql", "utf8"));
const post = await one(`select (select count(*)::int from general_ledger) gl,(select count(*)::int from lc1_chairpersons where verified) v,(select withdrawable_balance::text from wallets) w`);
check("Install: no ledger/wallet/verification change", JSON.stringify(pre) === JSON.stringify(post), post);

console.log(`\n${ok.filter(Boolean).length}/${ok.length} passed`);
process.exit(ok.every(Boolean) ? 0 : 1);
