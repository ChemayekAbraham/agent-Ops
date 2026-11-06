-- Read-only reconciliation of the merchandise money-release rule (CFO 2026-11-04): whenever Welile releases money for
-- merchandise on behalf of an agent or customer, the full amount released is recognised at once as a merchandise
-- receivable (A12; motorcycles A13), linked to the agent and the release, reduced by recoveries, never as revenue.
-- Run through a read-only transaction (qro_file.sh). Writes nothing. One row per order with a money release:
-- what was released, the receivable recognised for it, recoveries, and every account the order still leaves a balance
-- in. An order follows the rule when receivable_gross = released, E3 = 0 and X1 = 0.
with rel_orders as (
  select distinct s.id sale from merchandise_sales s
  where s.cfo_disbursed_at is not null or s.disbursement_group_id is not null
     or exists (select 1 from general_ledger g where g.source_table = 'merchandise_sales' and g.source_id = s.id
                 and g.ledger_scope = 'wallet' and g.direction = 'cash_in'
                 and (g.category in ('wallet_deposit', 'system_balance_correction')
                      or (g.category = 'agent_advance_credit' and g.wallet_bucket = 'withdrawable')))
), grp as (
  select distinct r.sale, g.transaction_group_id gid
  from rel_orders r join general_ledger g on (g.source_table = 'merchandise_sales' and g.source_id = r.sale)
     or (g.source_table = 'merchandise_recovery_plans' and g.source_id in (select id from merchandise_recovery_plans p where p.sale_id = r.sale))
     or (g.source_table = 'agent_bike_leases' and g.source_id in (select id from agent_bike_leases l where l.sale_id = r.sale))
), legs as (
  select grp.sale, l.account_code a, l.category c, l.dr, l.cr
  from sofp_ledger_legs(now()) l join grp on grp.gid = l.transaction_group_id
), o as (
  select s.id sale, s.item_name, s.order_status, s.customer_id agent_id, (select full_name from profiles where id = s.customer_id) agent,
    public.agent_product_category(s.item_name) = 'motor_bike' bike,
    (select sum(g.amount) from general_ledger g where g.source_table = 'merchandise_sales' and g.source_id = s.id and g.ledger_scope = 'wallet'
       and g.direction = 'cash_in' and (g.category in ('wallet_deposit', 'system_balance_correction')
                                        or (g.category = 'agent_advance_credit' and g.wallet_bucket = 'withdrawable'))) released,
    (select min(g.created_at) from general_ledger g where g.source_table = 'merchandise_sales' and g.source_id = s.id and g.ledger_scope = 'wallet'
       and g.direction = 'cash_in') released_at,
    (select string_agg(distinct g.transaction_group_id::text, ',') from general_ledger g where g.source_table = 'merchandise_sales' and g.source_id = s.id
       and g.ledger_scope = 'wallet' and g.direction = 'cash_in' and g.category in ('wallet_deposit', 'system_balance_correction', 'agent_advance_credit')) release_groups,
    coalesce((select round(sum(dr - cr), 2) from legs where legs.sale = s.id and a in ('A12', 'A13')), 0) receivable_now,
    -- net: a charge moved out of a recovery (DR A12 / CR R1) is not principal recovered
    coalesce((select round(sum(cr - dr), 2) from legs where legs.sale = s.id and a in ('A12', 'A13')
       and c in ('agent_repayment', 'merchandise_recovery_repayment')), 0)
    + coalesce((select round(sum(cr - dr), 2) from legs where legs.sale = s.id and a = 'A13' and c = 'bike_recovery_repayment' and cr > 0), 0) recovered_principal,
    coalesce((select round(sum(dr - cr), 2) from legs where legs.sale = s.id and a = 'E3'), 0) e3,
    coalesce((select round(sum(dr - cr), 2) from legs where legs.sale = s.id and a = 'X1'), 0) x1,
    coalesce((select round(sum(dr - cr), 2) from legs where legs.sale = s.id and a = 'R1' and c <> 'access_fee_collected'), 0) r1_not_charges
  from merchandise_sales s join rel_orders r on r.sale = s.id
)
select json_agg(jsonb_build_object(
  'sale', sale, 'agent', agent, 'agent_id', agent_id, 'item', item_name, 'status', order_status, 'account', case when bike then 'A13' else 'A12' end,
  'released', released, 'released_at', released_at, 'release_groups', release_groups,
  'receivable_now', receivable_now, 'recovered_principal', recovered_principal, 'receivable_gross', receivable_now + recovered_principal,
  'gap', released - (receivable_now + recovered_principal), 'e3', e3, 'x1', x1, 'r1_not_charges', r1_not_charges,
  'follows_rule', abs(released - (receivable_now + recovered_principal)) < 0.01 and e3 = 0 and x1 = 0 and r1_not_charges = 0
) order by (abs(released - (receivable_now + recovered_principal)) < 0.01 and e3 = 0 and x1 = 0), item_name, agent) j
from o;
