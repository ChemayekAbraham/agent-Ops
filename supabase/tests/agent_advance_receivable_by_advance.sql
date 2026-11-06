-- Read-only: A10 / A11 per agent advance (entry-level attribution, checked against sofp_ledger_legs per category) with
-- the advance components (disbursed, top-ups, 22 Sep opening, repayments, fees). Input to scripts/agent_advance_correction_schedule.py.
-- Leg-level attribution of A10 / A11 to each advance (via the leg's own source_id), with the debit / credit side checked
-- against the balance-sheet resolver totals per category. Read-only.
with rep_groups as materialized (
  select distinct transaction_group_id gid from general_ledger where classification in ('production', 'legacy_real')),
l as materialized (
  select g.id, g.transaction_group_id gid, g.ledger_scope sc, g.category c, g.source_table st, g.source_id sid, g.direction d, g.amount, g.created_at,
    g.idempotency_key k,
    case
      when g.category in ('rent_disbursement', 'agent_advance_disbursement') and g.source_table in ('agent_advance_requests', 'agent_advances', 'agent_advance_topups') and g.ledger_scope = 'platform' then 'A10'
      when g.category = 'agent_advance_receivable_opening' then 'A10'
      when g.category in ('agent_repayment', 'agent_advance_repayment', 'advance_repayment') and g.source_table = 'agent_advances' and g.ledger_scope = 'platform' then 'A10'
      when g.category in ('agent_advance_access_fee_charged', 'agent_access_fee_receivable_opening', 'agent_advance_access_fee_collected') then 'A11'
    end acct
  from general_ledger g
  where g.ledger_scope in ('platform', 'bridge') and g.transaction_group_id in (select gid from rep_groups)
    and g.source_table in ('agent_advance_requests', 'agent_advances', 'agent_advance_topups')),
s as materialized (
  select l.*, case when (c in ('rent_disbursement', 'agent_advance_disbursement', 'agent_advance_access_fee_charged') and d = 'cash_out')
                     or (c in ('agent_advance_receivable_opening', 'agent_access_fee_receivable_opening') and d = 'cash_in')
                     or (c in ('agent_repayment', 'agent_advance_repayment', 'advance_repayment', 'agent_advance_access_fee_collected') and d = 'cash_out') then amount else -amount end n,
    coalesce(case when st = 'agent_advances' then sid end,
             case when st = 'agent_advance_requests' then (select a.id from agent_advances a where a.request_id = l.sid limit 1) end,
             case when st = 'agent_advance_topups' then (select t.advance_id from agent_advance_topups t where t.id = l.sid) end) adv
  from l where acct is not null)
select json_agg(z) j from (
  select a.id, a.status, a.principal, a.access_fee, a.access_fee_collected, a.outstanding_balance, a.arrears_balance, a.cancellation_mode cm,
    a.cancellation_reason why, a.cancelled_at::date cd, a.issued_at::date issued, a.pre_cancel_outstanding pre, a.monthly_rate, a.cycle_days,
    (select full_name from profiles where id = a.agent_id) who, a.agent_id,
    (select coalesce(sum(t.amount), 0) from agent_advance_topups t where t.advance_id = a.id) topups_table,
    coalesce(sum(s.n) filter (where s.c in ('rent_disbursement', 'agent_advance_disbursement') and s.st <> 'agent_advance_topups'), 0) disb,
    coalesce(sum(s.n) filter (where s.st = 'agent_advance_topups'), 0) topup,
    coalesce(sum(s.n) filter (where s.c = 'agent_advance_receivable_opening'), 0) open10,
    coalesce(sum(s.n) filter (where s.acct = 'A10' and s.c in ('agent_repayment', 'agent_advance_repayment', 'advance_repayment') and s.created_at < '2026-09-22 19:00+00'), 0) rep_before,
    coalesce(sum(s.n) filter (where s.acct = 'A10' and s.c in ('agent_repayment', 'agent_advance_repayment', 'advance_repayment') and s.created_at >= '2026-09-22 19:00+00'), 0) rep_after,
    coalesce(sum(s.n) filter (where s.acct = 'A10'), 0) a10,
    coalesce(sum(s.n) filter (where s.c = 'agent_access_fee_receivable_opening'), 0) open11,
    coalesce(sum(s.n) filter (where s.c = 'agent_advance_access_fee_charged'), 0) fee_charged,
    coalesce(sum(s.n) filter (where s.c = 'agent_advance_access_fee_collected'), 0) fee_coll,
    coalesce(sum(s.n) filter (where s.acct = 'A11'), 0) a11
  from agent_advances a left join s on s.adv = a.id
  group by a.id) z;
