import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

// Opt-in local fixture tests. Never accepts a hosted/production connection string.
const enabled = process.env.RUN_BIKE_WATERFALL_TESTS === '1';
const suite = enabled ? describe : describe.skip;
const uid = '00000000-0000-0000-0000-000000000001';
const advance = '00000000-0000-0000-0000-000000000003';
const bike = '00000000-0000-0000-0000-000000000002';
const sql = postgres({ host: '/tmp/waterfall-pg', port: 55439, user: 'postgres', database: 'waterfall_v3', max: 4 });

suite('bike-first recovery against isolated PostgreSQL fixtures', () => {
  beforeEach(async () => {
    await sql`truncate test_postings, merchandise_recovery_deductions, agent_advance_ledger`;
    await sql`update treasury_controls set enabled=true where control_key='merchandise_recovery_enabled'`;
    await sql`update agent_advances set status='active', outstanding_balance=100000, arrears_balance=0,
      recovery_source='wallet_daily', deduction_paused=false`;
    await sql`update merchandise_recovery_plans set status='active', outstanding_balance=100000,
      amount_recovered=0, due_balance=0, fee_recovered=0, principal_recovered=0,
      recovery_started_on=null,due_accrued_through=null, test_daily=3917, recovery_hold=false,test_eligible=true`;
    await sql`update merchandise_recovery_plans set recovery_hold=true where id<>${bike}`;
    await sql`update test_wallet set withdrawable=5000,protected=0`;
  });
  afterAll(async () => { await sql.end(); });

  it('concurrent preparation and withdrawal collection record one quota and only surplus', async () => {
    await Promise.all([
      sql`select _prepare_bike_priority(${uid})`,
      sql`select collect_due_agent_advance_installment(${uid})`,
      sql`select _prepare_bike_priority(${uid})`,
    ]);
    const [paid] = await sql`select sum(amount) amount,count(*) count from merchandise_recovery_deductions`;
    const [adv] = await sql`select sum(amount_deducted) amount from agent_advance_ledger`;
    expect(Number(paid.amount)).toBe(3917);
    expect(Number(paid.count)).toBe(1);
    expect(Number(adv.amount)).toBe(1083);
  });

  it('scheduled sweep and withdrawal serialize without exceeding the same surplus', async () => {
    await Promise.all([sql`select sweep_agent_advance_recovery()`, sql`select collect_due_agent_advance_installment(${uid})`]);
    const [paid] = await sql`select sum(amount) amount from merchandise_recovery_deductions`;
    const [adv] = await sql`select sum(amount_deducted) amount from agent_advance_ledger`;
    expect(Number(paid.amount)).toBe(3917);
    expect(Number(adv.amount)).toBe(1083);
  });

  it('atomic posting rejects stale requests rather than taking bike quota', async () => {
    await expect(sql`select record_advance_deduction_atomic(${advance},${uid},current_date,
      100000,0,5000,95000,'partial','active',0,'unpaid',5000)`).rejects.toMatchObject({ code: '40001' });
    const [paid] = await sql`select count(*) count from merchandise_recovery_deductions`;
    const [wallet] = await sql`select withdrawable from test_wallet`;
    expect(Number(paid.count)).toBe(0);
    expect(Number(wallet.withdrawable)).toBe(5000);
  });

  it('atomic posting accepts only the prepared surplus', async () => {
    await sql`select _prepare_bike_priority(${uid})`;
    await sql`select record_advance_deduction_atomic(${advance},${uid},current_date,
      100000,0,1083,98917,'partial','active',0,'unpaid',8917)`;
    const [wallet] = await sql`select withdrawable,float_balance from test_wallet`;
    expect(Number(wallet.withdrawable)).toBe(0);
    expect(Number(wallet.float_balance)).toBe(99000);
  });

  it('a protected peer transfer is never consumed by either automatic recovery', async () => {
    await sql`update test_wallet set protected=5000`;
    await sql`select collect_due_agent_advance_installment(${uid})`;
    const [wallet] = await sql`select withdrawable from test_wallet`;
    const [paid] = await sql`select count(*) count from merchandise_recovery_deductions`;
    expect(Number(wallet.withdrawable)).toBe(5000);
    expect(Number(paid.count)).toBe(0);
  });

  it('read-only breakdown rejects a different caller and returns the owner’s actual daily quota', async () => {
    await expect(sql`select agent_bike_advance_priority(${uid})`).rejects.toMatchObject({ code: '42501' });
    const data = await sql.begin(async tx => {
      await tx`select set_config('test.user',${uid},true)`;
      return tx`select agent_bike_advance_priority(${uid}) data`;
    });
    expect(data[0].data.bike_daily).toBe(3917);
    expect(data[0].data.advance_outstanding).toBe(100000);
  });
});