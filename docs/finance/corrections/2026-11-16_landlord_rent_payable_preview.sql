-- PREVIEW (read-only) for migration 20261125090000 + batch acct_corr_202611_landlord_l4 (item 1, landlord rent payable).
-- Run inside BEGIN TRANSACTION READ ONLY. Gives the P1 payout count/amount to approve, re-checks the 23 P2 Rent Plans,
-- and estimates the effect on A1 / L4 / A3 / A8 (the resolver change cannot run in a read-only preview, so the effect is
-- computed from the same rules the migration applies).
with sent as (
  select l.id, l.amount from public.landlord_payouts l
   where l.status in ('awaiting_agent_receipt', 'disbursed', 'completed') and l.rent_request_id is not null and coalesce(l.amount, 0) > 0
     and not exists (select 1 from public.general_ledger g where g.source_table = 'landlord_payouts' and g.source_id = l.id
                       and g.category = 'landlord_rent_payout_settled')),
grp as (
  select g.transaction_group_id gid,
         bool_or(g.ledger_scope = 'wallet') has_wallet,
         bool_or(g.classification in ('production', 'legacy_real')) reportable
    from public.general_ledger g
   where g.transaction_group_id in (select transaction_group_id from public.general_ledger where category = 'rent_disbursement')
   group by 1),
funding as (   -- platform rent_disbursement that moves from A1 to L4 (no wallet leg; not a legacy agent advance)
  select coalesce(sum(case when g.direction = 'cash_out' then g.amount else -g.amount end), 0) net
    from public.general_ledger g join grp on grp.gid = g.transaction_group_id
   where g.category = 'rent_disbursement' and g.ledger_scope = 'platform' and grp.reportable and not grp.has_wallet
     and coalesce(g.source_table, '') not in ('agent_advance_requests', 'agent_advance_topups')),
synth as (
  select coalesce(sum(dr), 0) amt from public.sofp_ledger_legs(now())
   where category = 'float_backed_collection_counterpart' and account_code = 'L4'),
now_bal as (
  select account_code, sum(dr - cr) net from public.sofp_ledger_legs(now()) where account_code in ('A1', 'L4', 'A3', 'A8') group by 1)
select json_build_object(
  'p1_payouts', (select count(*) from sent),
  'p1_amount', (select coalesce(sum(amount), 0) from sent),
  'p2_plans_expected', 23, 'p2_amount_expected', 9290000,
  'funding_moving_a1_to_l4', (select net from funding),
  'collection_counterpart_l4_to_a8', (select amt from synth),
  'balances_now_debit_minus_credit', (select json_object_agg(account_code, round(net)) from now_bal),
  'estimated_after', json_build_object(
     'A1', (select round(net) from now_bal where account_code = 'A1') + (select net from funding) - (select coalesce(sum(amount), 0) from sent),
     'L4_credit_balance', -(select round(net) from now_bal where account_code = 'L4') + (select net from funding) + (select amt from synth)
                          - (select coalesce(sum(amount), 0) from sent) + 9290000,
     'A3', (select round(net) from now_bal where account_code = 'A3') + 9290000,
     'A8', (select round(net) from now_bal where account_code = 'A8') + (select amt from synth))
) as preview;
