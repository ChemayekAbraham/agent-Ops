// Private in-memory test suite for the single-CFO Batch 1 executor. Never touches the live database.
// Run: S14_SEED=/tmp/s14g/seed.sql NODE_PATH=/dev-server/node_modules bun stage14d_batch1_executor.test.ts
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const db = new PGlite();
const CFO='29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', CFO2='00000000-0000-4000-8000-0000000000c2', AGENT='dc5ba4af-cb53-4fe8-9aa5-b1b73d0402aa';
const FP='274de6552922cbdc2f7d346903ef5ac0300681646fd6e35f9b781959e422a385', PH='EXECUTE BATCH 1 CORRECTION';
const q=async(s:string)=>{try{const r=await db.query(s);return r.rows}catch(e:any){return 'ERR: '+e.message.slice(0,140)}};
const as=(u:string|null)=>db.exec(`UPDATE auth.cur SET uid=${u?`'${u}'`:'NULL'}`);
const snap=async()=>(await q(`select (select count(*) from general_ledger) gl,(select count(*) from general_ledger where reference_id like 's14b1:%') s14,(select sum(withdrawable_balance)::text from wallets) w,(select sum(float_balance)::text from wallets) f,(select count(*) from agent_collections where reversed_at is null and id in (select collection_id from fin_s14_batch_cases)) unrev,(select sum(amount_repaid)::text from rent_requests) rr,(select count(*) from fin_s14b1_approvals where executed_at is not null) ex`) as any)[0];
const results:[string,string,boolean][]=[];
const check=(n:string,expect:string,got:any,pass:boolean)=>{results.push([n,expect,pass]);console.log((pass?'PASS ':'FAIL ')+n.padEnd(44),JSON.stringify(got).slice(0,260));};
const err=(r:any,code:string)=>typeof r==='string'&&r.includes(code);
const exec=(id:string,ph=PH,fp=FP)=>q(`select cfo_s14b1_execute('${id}',true,'${ph}','${fp}') r`);
const backdate=async(id:string,iv:string)=>{await db.exec(`alter table fin_s14b1_approvals disable trigger trg_s14b1_appr_frozen; update fin_s14b1_approvals set approved_at=now()-interval '${iv}' where id='${id}'; alter table fin_s14b1_approvals enable trigger trg_s14b1_appr_frozen;`)};
const approve=async()=>(await q(`select cfo_s14b1_approve('${FP}','CFO approves Stage 14 Batch 1 package v1') id`) as any)[0].id as string;

await db.exec(readFileSync(process.env.S14_SEED ?? '/tmp/s14g/seed.sql','utf8'));
await db.exec(readFileSync('/dev-server/supabase/pending/stage14d_batch1_executor.sql','utf8'));
await db.exec(`insert into cfo_approval_approvers values ('${CFO2}')`); // a second CFO-gated account, for the wrong-user test only
const fp=(await q('select fin_s14b1_fingerprint() f') as any)[0].f;
const v0=(await q('select fin_s14b1_validate() v') as any)[0].v;
check('T0 package frozen + validates','fingerprint 274de655…, all_ok',{fp:fp.slice(0,8),...v0},fp===FP&&v0.all_ok===true&&v0.entries===33&&v0.lines===66&&Number(v0.total)===522665.42);
const S0=await snap();

await as(CFO);
const ap=await approve(); const s10=await snap();
check('T10 approval alone','0 writes (ledger/wallet/plans/collections)',s10,s10.gl===S0.gl&&s10.w===S0.w&&s10.rr===S0.rr&&s10.unrev===S0.unrev&&s10.ex===0);
check('T10b approve rejects phrase as hash','REFUSED',await q(`select cfo_s14b1_approve('${PH}','trying to approve with phrase')`),err(await q(`select cfo_s14b1_approve('${PH}','trying to approve with phrase')`),'S14B1_HASH_MISMATCH'));

const r3=await exec(ap); check('T3 execute immediately after approval','REFUSED — WAITING PERIOD',r3,err(r3,'S14B1_WAITING_PERIOD'));
await backdate(ap,'6 minutes');
await as(CFO2); const r2=await exec(ap); check('T2 wrong user (other CFO-gated account)','REFUSED',r2,err(r2,'S14B1_NOT_BATCH1_EXECUTOR'));
await as(AGENT); const r2b=await exec(ap); check('T2b wrong user (non-CFO agent)','REFUSED',r2b,err(r2b,'S14B1_NOT_CFO'));
await as(CFO);
const r6=await exec(ap,'EXECUTE BATCH 1'); check('T6 wrong confirmation phrase','REFUSED',r6,err(r6,'S14B1_CONFIRMATION_PHRASE_MISMATCH'));
const r6b=await q(`select cfo_s14b1_execute('${ap}',true,NULL,'${FP}')`); check('T6b missing phrase','REFUSED',r6b,err(r6b,'S14B1_CONFIRMATION_PHRASE_MISMATCH'));
const r7=await exec(ap,PH,'16d1ae84'+FP.slice(8)); check('T7 wrong fingerprint','REFUSED',r7,err(r7,'S14B1_CONFIRMATION_HASH_MISMATCH'));

// T8 unexpected commission payment to a collecting agent since the snapshot
await db.exec(`insert into general_ledger(amount,direction,category,user_id,ledger_scope,wallet_bucket,recipient_type) values (140,'cash_in','agent_commission_earned','e1bb1b7c-14a6-4a25-a82c-dffe345b7170','wallet','withdrawable','user')`);
const r8=await exec(ap); const s8=await snap(); check('T8 unexpected commission payment','REFUSED, nothing written',r8,err(r8,'"new_commission_payments": 1')&&s8.s14===0);
await db.exec(`delete from general_ledger where category='agent_commission_earned' and amount=140 and created_at>'2026-10-03 13:00+00'; update wallets set withdrawable_balance=1590.32 where user_id='e1bb1b7c-14a6-4a25-a82c-dffe345b7170'`);

// T9 negative tenant balance — (a) before: a plan driven negative; (b) after: a write that would leave a plan negative
await db.exec(`update rent_requests set amount_repaid=-5 where id='1019b84b-b964-4d38-a97e-5d56978499e0'`);
const r9=await exec(ap); check('T9a negative tenant balance (pre-check)','REFUSED',r9,err(r9,'"tenant_balance_unsafe": 1'));
await db.exec(`update rent_requests set amount_repaid=(select amount_repaid_before from fin_s14b1_package_plans where rent_request_id='1019b84b-b964-4d38-a97e-5d56978499e0') where id='1019b84b-b964-4d38-a97e-5d56978499e0'`);
await db.exec(`create function negp() returns trigger language plpgsql as $$begin if NEW.id='090754f1-99eb-4f45-9493-a1fdc0cb3906' then NEW.amount_repaid:=-1; end if; return NEW; end$$; create trigger negp before update on rent_requests for each row execute function negp();`);
const r9b=await exec(ap); const s9=await snap(); check('T9b negative tenant balance (post-check)','REFUSED, full rollback',r9b,err(r9b,'S14B1_TENANT_BALANCE_UNSAFE')&&s9.s14===0&&s9.rr===S0.rr&&s9.w===S0.w);
await db.exec(`drop trigger negp on rent_requests`);

// T11 forced failure at the last step
await db.exec(`create function boom() returns trigger language plpgsql as $$begin if NEW.id='2ca84e52-973b-4ed6-a5b8-5bc28ba6cd84' then raise exception 'injected failure'; end if; return NEW; end$$; create trigger boom before update on rent_requests for each row execute function boom();`);
const r11=await exec(ap); const s11=await snap(); check('T11 forced execution failure','0 committed records',{r11,s11},err(r11,'injected failure')&&JSON.stringify(s11)===JSON.stringify(S0));
await db.exec(`drop trigger boom on rent_requests`);

// T5 expired approval
const apX=await approve(); await backdate(apX,'24 hours 1 minute');
const r5=await exec(apX); check('T5 expired approval (24h+)','REFUSED — APPROVAL EXPIRED',r5,err(r5,'S14B1_APPROVAL_EXPIRED'));

// T1 + T4: same CFO approved and executes, 6 minutes later, all checks pass
const r1=await exec(ap); const s1=await snap();
const tot=(await q(`select count(*) legs, count(distinct transaction_group_id) grp, sum(amount) filter (where direction='cash_in')::text cin, sum(amount) filter (where direction='cash_out')::text cout from general_ledger where reference_id like 's14b1:%'`) as any)[0];
const com=(await q(`select sum(amount)::text s from general_ledger where reference_id like 's14b1:%:commission' and ledger_scope='wallet'`) as any)[0].s;
const restored=(await q(`select sum(p.amount_repaid_before-rr.amount_repaid)::text s, count(*) filter (where rr.amount_repaid<0 or rr.total_repayment-rr.amount_repaid<0) neg from fin_s14b1_package_plans p join rent_requests rr on rr.id=p.rent_request_id`) as any)[0];
const negw=(await q(`select count(*) n from wallets where withdrawable_balance<0 or float_balance<0`) as any)[0].n;
const recr=(await q(`select count(*) n from general_ledger where reference_id like 's14b1:%' and user_id in ('98ee118b-06d1-47a4-aa2b-76bd12170b70','ebd985fb-dc19-43f8-b5f4-4e8cf1150fd4','ebf0897b-dfdf-4403-ad5c-1c988c72e67c')`) as any)[0].n;
const sep16=(await q(`select count(*) n, sum(amount)::text s from agent_collections where reversed_at='2026-09-16 14:08:40.882504+00'`) as any)[0];
const sep29=(await q(`select reversed_at from agent_collections where id='dab3bc9f-1ba2-4151-a344-fdd09132b7f8'`) as any)[0];
const ok1=typeof r1!=='string'&&tot.legs==66&&tot.grp==33&&tot.cin==='522665.42'&&tot.cout==='522665.42'&&com==='38980.42'&&restored.s==='479685.00'&&restored.neg==0&&negw==0&&recr==0&&s1.f===S0.f&&sep16.n==1210&&sep16.s==='92656683'&&s1.unrev===0;
check('T1 same CFO approves and executes','ALLOWED',{r1,tot,com,restored,negw,recr,float:[S0.f,s1.f],sep16,sep29},ok1);
check('T4 executed after 5+ minutes','ALLOWED TO PROCEED',{approved_6min_ago:true},ok1);

const g0=s1.gl;
const r12=await exec(ap); const r12b=await exec(apX); const ap3=await q(`select cfo_s14b1_approve('${FP}','another approval after execution')`); const s12=await snap();
check('T12 second execution attempt','0 new records',{r12,r12b,ap3,s12},err(r12,'S14B1_ALREADY_EXECUTED')&&s12.gl===g0&&s12.s14===66);

console.log(`\n${results.filter(r=>r[2]).length}/${results.length} passed`);
