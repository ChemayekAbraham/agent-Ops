-- SEPTEMBER 2026 RENT-COLLECTION ACCOUNTING CORRECTIONS (batch acct_corr_202611). CFO request 2026-11-08.
--
-- ACCOUNTING RECORDS ONLY. NO MONEY MOVEMENT. This script never writes a wallet-scope ledger leg, never touches a
-- wallet, payment, mobile-money record, deposit, withdrawal or agent collection, never deletes or edits a ledger row,
-- and never changes a Rent Plan's status. Every posting is a platform-scope journal through create_ledger_transaction,
-- linked to its original record and ledger group, recorded in accounting_correction_register (unique, so nothing
-- posts twice) and excluded from Money In. Any failed check aborts the whole batch.
--
-- Needs migrations 20261108150000 (register + Money In exclusions) and 20261108150100 (fee rule) applied first.
-- Run the _preview.sql file (read-only) immediately before, and compare it with the approved schedule.
--
-- ITEMS (read-only schedule 2026-11-08; the script re-derives every line and stops if production differs)
--   A  Tenant balances restored (rent_requests.amount_repaid only): receipts the 15-16 Sep guard dropped and the
--      29 Sep clean-up then removed. Ledger already counts them (DR A5 / CR A3 per receipt): no journal.
--   B  Contra of unsupported receipts: on Rent Plans collected above their total, the excess carried only by receipts
--      with no float, wallet, mobile-money or deposit evidence:  CR A5 cash_receipt_in_transit / DR A3
--      tenant_repayment_collected, per receipt. Receipts with evidence (E1/E2) are never touched; their excess is a
--      tenant overpayment left in A3 (no refund, no credit).
--   C2 Fees recognised above the Rent Plan fee (older fee path): original fee group reversed, correct fee rebooked.
--   C3 Fee postings of reversed collections that were never reversed: reversed in full.
--   (C1, the 440 duplicate-collection fee groups, was already reversed by Finance on 2026-10-01: nothing to post.)
--   D  Money In exclusions: migration 20261108150000, plus every group posted here.
--   E  Fee rule: migration 20261108150100.
--
-- Rollback: 2026-11-08_sep2026_rent_collection_corrections_rollback.sql (counter-entries; nothing is deleted).
begin;

-- INPUT 1: field-verification rulings (verification workbook). 'received' keeps a receipt out of item B;
-- 'not_received' contras it in full and keeps it out of item A. Leave empty to post the approved schedule.
create temp table _field_decisions (receipt_id uuid primary key, decision text not null check (decision in ('received', 'not_received')),
  evidence text) on commit drop;
-- insert into _field_decisions (receipt_id, decision, evidence) values ('<receipt id>', 'received', '<handover / deposit ref>');

-- INPUT 2: the approved schedule. The script stops if production does not give exactly these lines and amounts.
create temp table _expected (item text primary key, n int not null, amount numeric not null) on commit drop;
insert into _expected (item, n, amount) values
  ('A', 18, 2167625), ('B', 56, 8302829), ('C2', 21, 890537), ('C3', 23, 1469794);

-- INPUT 3: transaction date of the correction journals: 'original' (date of the entry corrected, as Finance did for
-- the 2026-10-01 fee reversal) or a timestamp, e.g. '2026-11-30 23:59:59+03' if September is closed.
create temp table _params (key text primary key, value text not null) on commit drop;
insert into _params values ('transaction_date', 'original');

create temp table _rcpt on commit drop as
WITH fd AS (SELECT receipt_id, decision FROM _field_decisions),
rcpt AS (
  -- Receipts still marked genuine on Rent Plans collected above their total, plus any receipt the field team ruled
  -- 'not_received'. Evidence: E1 mobile-money/deposit, E2 agent float or wallet debited for it, E3 cash-in-transit only.
  SELECT ac.id, ac.rent_request_id AS rid, ac.agent_id, ac.amount, ac.created_at, ac.tracking_id,
         rr.total_repayment AS tot, pl.live,
         (ac.momo_transaction_id IS NOT NULL OR ac.deposit_request_id IS NOT NULL) AS e1,
         EXISTS (SELECT 1 FROM public.general_ledger g
                  WHERE g.source_table = 'agent_collections' AND g.source_id IN (ac.id, ac.rent_request_id)
                    AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
                    AND g.category IN ('agent_float_used_for_rent', 'rent_payment_for_tenant', 'tenant_repayment')
                    AND abs(g.amount - ac.amount) < 1
                    AND g.created_at BETWEEN ac.created_at - interval '3 seconds' AND ac.created_at + interval '3 seconds') AS e2,
         a5.id AS a5_leg, a5.transaction_group_id AS a5_group, a5.transaction_date AS a5_date, a3.id AS a3_leg,
         EXISTS (SELECT 1 FROM public.rent_amount_change_log c
                  WHERE c.rent_request_id = ac.rent_request_id
                    AND c.changed_at BETWEEN ac.created_at - interval '5 seconds' AND ac.created_at + interval '5 seconds'
                    AND c.new_amount_repaid - c.old_amount_repaid = ac.amount) AS landed,
         fd.decision
  FROM public.agent_collections ac
  JOIN (SELECT x.rent_request_id, sum(x.amount) AS live FROM public.agent_collections x
         WHERE x.reversed_at IS NULL AND x.rent_request_id IS NOT NULL GROUP BY 1) pl ON pl.rent_request_id = ac.rent_request_id
  JOIN public.rent_requests rr ON rr.id = ac.rent_request_id
  LEFT JOIN LATERAL (SELECT g.id, g.transaction_group_id, g.transaction_date FROM public.general_ledger g
       WHERE g.source_table = 'agent_collections' AND g.source_id IN (ac.id, ac.rent_request_id) AND g.ledger_scope = 'platform'
         AND g.category = 'cash_receipt_in_transit' AND g.direction = 'cash_in' AND abs(g.amount - ac.amount) < 1
         AND g.created_at BETWEEN ac.created_at - interval '3 seconds' AND ac.created_at + interval '3 seconds'
       ORDER BY abs(extract(epoch FROM g.created_at - ac.created_at)), g.id LIMIT 1) a5 ON true
  LEFT JOIN LATERAL (SELECT g.id FROM public.general_ledger g
       WHERE g.source_table = 'agent_collections' AND g.source_id IN (ac.id, ac.rent_request_id) AND g.ledger_scope = 'platform'
         AND g.category = 'tenant_repayment_collected' AND g.direction = 'cash_out' AND abs(g.amount - ac.amount) < 1
         AND g.created_at BETWEEN ac.created_at - interval '3 seconds' AND ac.created_at + interval '3 seconds'
       ORDER BY abs(extract(epoch FROM g.created_at - ac.created_at)), g.id LIMIT 1) a3 ON true
  LEFT JOIN fd ON fd.receipt_id = ac.id
  WHERE ac.reversed_at IS NULL
    AND ((rr.total_repayment > 0 AND pl.live > rr.total_repayment + 1) OR fd.decision = 'not_received')
)
SELECT * FROM rcpt;

create temp table _b on commit drop as
WITH rcpt AS (SELECT * FROM _rcpt),
b AS (
  -- Unsupported receipts to contra. A receipt ruled 'not_received' is taken in full. Otherwise only an over-collected
  -- Rent Plan's excess (receipts - total) is taken, from E3 receipts only (never E1/E2, never one ruled 'received'),
  -- balance-landed receipts first, newest first, so the receipts the tenant credit (item A) rests on are taken last.
  SELECT q.*,
         CASE WHEN q.decision = 'not_received' THEN q.amount
              ELSE LEAST(q.amount, GREATEST(0, GREATEST(q.live - q.tot, q.rejected) - (q.cum - q.amount))) END AS take
  FROM (SELECT r.*,
               sum(r.amount) OVER (PARTITION BY r.rid ORDER BY (r.decision = 'not_received') DESC NULLS LAST, r.landed DESC,
                                   r.created_at DESC, r.id) AS cum,
               COALESCE(sum(r.amount) FILTER (WHERE r.decision = 'not_received') OVER (PARTITION BY r.rid), 0) AS rejected
        FROM rcpt r
        WHERE NOT r.e1 AND NOT r.e2 AND r.a5_leg IS NOT NULL AND r.a3_leg IS NOT NULL
          AND COALESCE(r.decision, '') <> 'received') q
)
SELECT * FROM b WHERE take > 0;

create temp table _a on commit drop as
WITH b AS (SELECT * FROM _b),
a AS (
  -- Tenants on the 29 Sep clean-up list whose balance is below their genuine receipts (after item B), capped at the
  -- Rent Plan total. Only receipts the guard dropped (15-16 Sep, balance never moved) can explain the credit.
  SELECT rr.id AS rid, rr.tenant_id, rr.amount_repaid AS before, rr.total_repayment AS tot, rr.status,
         pl.live, COALESCE(bt.b, 0) AS b_taken,
         LEAST(pl.live - COALESCE(bt.b, 0), rr.total_repayment) - rr.amount_repaid AS credit,
         COALESCE(un.unlanded_amount, 0) AS unlanded_amount, un.receipts
  FROM public.plan_balance_duplicate_correction_20260929 k
  JOIN public.rent_requests rr ON rr.id = k.rent_request_id
  JOIN (SELECT x.rent_request_id, sum(x.amount) AS live FROM public.agent_collections x
         WHERE x.reversed_at IS NULL AND x.rent_request_id IS NOT NULL GROUP BY 1) pl ON pl.rent_request_id = rr.id
  LEFT JOIN (SELECT b.rid, sum(b.take) AS b FROM b GROUP BY 1) bt ON bt.rid = rr.id
  LEFT JOIN LATERAL (
    SELECT sum(u.amount - COALESCE(bb.take, 0)) AS unlanded_amount,
           jsonb_agg(jsonb_build_object('receipt_id', u.id, 'tracking_id', u.tracking_id, 'amount', u.amount,
                       'recorded_at', u.created_at, 'contra_by_item_b', COALESCE(bb.take, 0),
                       'a5_leg', (SELECT g.id FROM public.general_ledger g WHERE g.source_table = 'agent_collections'
                                    AND g.source_id IN (u.id, u.rent_request_id) AND g.ledger_scope = 'platform'
                                    AND g.category = 'cash_receipt_in_transit' AND g.direction = 'cash_in' AND abs(g.amount - u.amount) < 1
                                    AND g.created_at BETWEEN u.created_at - interval '3 seconds' AND u.created_at + interval '3 seconds'
                                  ORDER BY abs(extract(epoch FROM g.created_at - u.created_at)), g.id LIMIT 1),
                       'a3_leg', (SELECT g.id FROM public.general_ledger g WHERE g.source_table = 'agent_collections'
                                    AND g.source_id IN (u.id, u.rent_request_id) AND g.ledger_scope = 'platform'
                                    AND g.category = 'tenant_repayment_collected' AND g.direction = 'cash_out' AND abs(g.amount - u.amount) < 1
                                    AND g.created_at BETWEEN u.created_at - interval '3 seconds' AND u.created_at + interval '3 seconds'
                                  ORDER BY abs(extract(epoch FROM g.created_at - u.created_at)), g.id LIMIT 1))
                     ORDER BY u.created_at) AS receipts
    FROM public.agent_collections u LEFT JOIN b bb ON bb.id = u.id
    WHERE u.rent_request_id = rr.id AND u.reversed_at IS NULL
      AND u.created_at BETWEEN TIMESTAMPTZ '2026-09-15 15:12:23+00' AND TIMESTAMPTZ '2026-09-16 06:03:51+00'
      AND NOT EXISTS (SELECT 1 FROM public.rent_amount_change_log c
                       WHERE c.rent_request_id = u.rent_request_id
                         AND c.changed_at BETWEEN u.created_at - interval '5 seconds' AND u.created_at + interval '5 seconds'
                         AND c.new_amount_repaid - c.old_amount_repaid = u.amount)
  ) un ON true
  WHERE LEAST(pl.live - COALESCE(bt.b, 0), rr.total_repayment) > rr.amount_repaid
)
SELECT * FROM a;

create temp table _c2 on commit drop as
WITH c2 AS (
  -- Older-path fee postings above the Rent Plan fee: each non-reversed allocation's correct fee is the fee share of the
  -- cash inside the total it added (cumulative capped at the basis total); the excess is reversed and the correct fee rebooked.
  SELECT q.*, (q.rf - q.rf_ok) + (q.af - q.af_ok) AS excess
  FROM (SELECT la.id AS alloc, la.rent_request_id AS rid, la.source_table, la.source_id, la.transaction_group_id AS grp,
               la.instalment_amount, la.cum, la.bt, la.registration_fee_component AS rf, la.access_fee_component AS af,
               (SELECT c.registration_fee_component FROM public.compute_instalment_allocation(la.rent_request_id, LEAST(la.cum, la.bt)) c)
                 - COALESCE((SELECT c.registration_fee_component FROM public.compute_instalment_allocation(la.rent_request_id, LEAST(la.cum - la.instalment_amount, la.bt)) c), 0) AS rf_ok,
               (SELECT c.access_fee_component FROM public.compute_instalment_allocation(la.rent_request_id, LEAST(la.cum, la.bt)) c)
                 - COALESCE((SELECT c.access_fee_component FROM public.compute_instalment_allocation(la.rent_request_id, LEAST(la.cum - la.instalment_amount, la.bt)) c), 0) AS af_ok
        FROM (SELECT ia.*, sum(ia.instalment_amount) OVER (PARTITION BY ia.rent_request_id ORDER BY ia.created_at, ia.id) AS cum,
                     (SELECT c.basis_total FROM public.compute_instalment_allocation(ia.rent_request_id, 1) c) AS bt
              FROM public.instalment_allocations ia
              WHERE ia.reversed_at IS NULL AND COALESCE(ia.split_version, '') <> 'four_part_v1') la
        WHERE la.cum > la.bt AND la.transaction_group_id IS NOT NULL) q
  WHERE (q.rf - q.rf_ok) + (q.af - q.af_ok) > 0
)
SELECT * FROM c2;

create temp table _c3 on commit drop as
WITH c3 AS (
  -- Allocations whose collection was reversed but whose fee posting never was.
  SELECT ia.id AS alloc, ia.rent_request_id AS rid, ia.source_table, ia.source_id, ia.transaction_group_id AS grp,
         ia.registration_fee_component + ia.access_fee_component AS fees, ia.reversed_at, ia.reversal_reason
  FROM public.instalment_allocations ia
  WHERE ia.reversed_at IS NOT NULL AND ia.reversal_group_id IS NULL AND ia.transaction_group_id IS NOT NULL
)
SELECT * FROM c3;

do $corr$
declare
  c_batch constant text := 'acct_corr_202611';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  v_mode text; r record; e record; v_grp uuid; v_grp2 uuid; v_legs jsonb; v_n int; v_x numeric; v_st text; v_td timestamptz;
  s_wallet_legs bigint; s_wallet_sum numeric; s_wp text; s_wbp text; s_coll text; s_dep text; s_wd text; s_alloc text; s_rr text;
  h text;
begin
  if to_regclass('public.accounting_correction_register') is null or to_regclass('public.money_in_report_exclusions') is null then
    raise exception 'STOP: apply migration 20261108150000 first';
  end if;
  if exists (select 1 from public.accounting_correction_register where batch = c_batch) then
    raise exception 'STOP: batch % is already posted', c_batch;
  end if;
  select value into v_mode from _params where key = 'transaction_date';

  -- 1. The schedule must be exactly what was approved.
  for e in select x.item, x.n, x.amount, s.n as sn, s.amount as samt from _expected x left join (
             select 'A' as item, count(*)::int as n, coalesce(sum(credit), 0) as amount from _a
             union all select 'B', count(*)::int, coalesce(sum(take), 0) from _b
             union all select 'C2', count(*)::int, coalesce(sum(excess), 0) from _c2
             union all select 'C3', count(*)::int, coalesce(sum(fees), 0) from _c3) s on s.item = x.item loop
    if e.sn is distinct from e.n or e.samt is distinct from e.amount then
      raise exception 'STOP: item % is % lines / UGX % in production; approved schedule says % / %', e.item, e.sn, e.samt, e.n, e.amount;
    end if;
  end loop;

  -- 2. Integrity of the schedule.
  if exists (select 1 from _a where credit > unlanded_amount) then
    raise exception 'STOP: a tenant credit is larger than the dropped receipts that explain it';
  end if;
  if exists (select 1 from _a where before + credit > tot) then raise exception 'STOP: a tenant credit would pass the Rent Plan total'; end if;
  if exists (select a5_leg from _b group by a5_leg having count(*) > 1) or exists (select a3_leg from _b group by a3_leg having count(*) > 1) then
    raise exception 'STOP: one ledger leg is matched to two receipts';
  end if;
  if exists (select 1 from _b where take > amount or take <= 0) then raise exception 'STOP: contra outside 0..receipt amount'; end if;
  if exists (select 1 from public.general_ledger g where g.transaction_group_id in (select grp from _c2 union select grp from _c3)
               and (g.ledger_scope <> 'platform' or g.category not in ('access_fee_collected', 'registration_fee_collected', 'treasury_fee_drawdown'))) then
    raise exception 'STOP: a fee group to reverse has a leg that is not a platform fee leg';
  end if;
  if exists (select 1 from public.general_ledger g where g.idempotency_key like c_batch || ':%') then
    raise exception 'STOP: ledger already holds batch keys';
  end if;

  -- 3. Money-safety snapshot: nothing below may change any of these.
  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into s_wp from public.wallets_physical t;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into s_wbp from public.wallet_balances_projection t;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_coll from public.agent_collections t
    where t.rent_request_id in (select rid from _a union select rid from _b union select rid from _c2 union select rid from _c3);
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_dep from public.deposit_requests t;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_wd from public.withdrawal_requests t;
  select md5(coalesce(string_agg((to_jsonb(t) - 'reversal_group_id')::text, '|' order by t.id), '')) into s_alloc
    from public.instalment_allocations t where t.rent_request_id in (select rid from _c2 union select rid from _c3);
  select md5(coalesce(string_agg((to_jsonb(t) - 'amount_repaid' - 'updated_at')::text, '|' order by t.id), '')) into s_rr
    from public.rent_requests t where t.id in (select rid from _a union select rid from _b union select rid from _c2 union select rid from _c3);

  -- 4. Item B: contra of unsupported receipts (platform only).
  for r in select * from _b order by rid, created_at, id loop
    v_td := case when v_mode = 'original' then r.a5_date else v_mode::timestamptz end;
    v_grp := public.create_ledger_transaction(entries := jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.take, 'category', 'cash_receipt_in_transit',
        'source_table', 'agent_collections', 'source_id', r.id::text, 'reference_id', r.a5_group::text, 'currency', 'UGX',
        'transaction_date', v_td, 'classification', 'production',
        'description', format('Contra (accounting only, no money moved): cash in transit for receipt %s, UGX %s of %s, not supported by any float, wallet, mobile-money or deposit record (%s). Original legs %s / %s.',
                              coalesce(r.tracking_id, r.id::text), r.take, r.amount,
                              case when r.decision = 'not_received' then 'field: not received' else 'Rent Plan collected above its total' end, r.a5_leg, r.a3_leg)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.take, 'category', 'tenant_repayment_collected',
        'source_table', 'agent_collections', 'source_id', r.id::text, 'reference_id', r.a5_group::text, 'currency', 'UGX',
        'transaction_date', v_td, 'classification', 'production',
        'description', format('Contra (accounting only, no money moved): Rent Plan receivable restored for unsupported receipt %s, UGX %s. Original legs %s / %s.',
                              coalesce(r.tracking_id, r.id::text), r.take, r.a5_leg, r.a3_leg))),
      idempotency_key := c_batch || ':B:' || r.id::text);
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
    values (v_grp, 'Contra of an unsupported receipt (accounting only): not money received', 'B');
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, rent_request_id,
      original_group_id, original_leg_ids, correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, 'B', 'contra_unsupported_receipt', 'agent_collections', r.id, r.rid, r.a5_group, array[r.a5_leg, r.a3_leg], v_grp,
      r.take, r.amount, r.amount - r.take,
      jsonb_build_object('tracking_id', r.tracking_id, 'agent_id', r.agent_id, 'recorded_at', r.created_at, 'plan_total', r.tot,
        'plan_receipts_marked_genuine', r.live, 'balance_landed', r.landed, 'field_decision', r.decision,
        'basis', case when r.decision = 'not_received' then 'field verification: not received' else 'above Rent Plan total; no float, wallet, mobile-money or deposit evidence' end),
      c_cfo);
  end loop;

  -- 5. Item C2: fee above the Rent Plan fee - reverse the original fee group, rebook the correct fee.
  for r in select * from _c2 order by rid, alloc loop
    select jsonb_agg(jsonb_build_object('ledger_scope', g.ledger_scope,
             'direction', case g.direction when 'cash_in' then 'cash_out' else 'cash_in' end,
             'amount', g.amount, 'category', g.category, 'source_table', 'instalment_allocations', 'source_id', r.alloc::text,
             'reference_id', g.transaction_group_id::text, 'currency', 'UGX',
             'transaction_date', case when v_mode = 'original' then g.transaction_date else v_mode::timestamptz end,
             'classification', 'production',
             'description', format('Reversal of fee posting %s (accounting only): fees recognised above the Rent Plan fee; correct fee UGX %s rebooked.',
                                   g.transaction_group_id, r.rf_ok + r.af_ok)) order by g.created_at, g.id),
           min(g.transaction_date)
      into v_legs, v_td from public.general_ledger g where g.transaction_group_id = r.grp;
    v_grp := public.create_ledger_transaction(entries := v_legs, idempotency_key := c_batch || ':C2:reverse:' || r.alloc::text);
    v_grp2 := null;
    if r.rf_ok + r.af_ok > 0 then
      v_td := case when v_mode = 'original' then v_td else v_mode::timestamptz end;
      v_grp2 := public.create_ledger_transaction(entries := (
          jsonb_build_array(jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.rf_ok + r.af_ok,
            'category', 'treasury_fee_drawdown', 'source_table', 'instalment_allocations', 'source_id', r.alloc::text,
            'reference_id', r.grp::text, 'currency', 'UGX', 'transaction_date', v_td, 'classification', 'production',
            'description', format('Rebooked fee drawdown for fee posting %s at the Rent Plan fee cap', r.grp)))
          || case when r.rf_ok > 0 then jsonb_build_array(jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', r.rf_ok, 'category', 'registration_fee_collected', 'source_table', 'instalment_allocations', 'source_id', r.alloc::text,
            'reference_id', r.grp::text, 'currency', 'UGX', 'transaction_date', v_td, 'classification', 'production',
            'description', format('Registration fee rebooked for fee posting %s at the Rent Plan fee cap', r.grp))) else '[]'::jsonb end
          || case when r.af_ok > 0 then jsonb_build_array(jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', r.af_ok, 'category', 'access_fee_collected', 'source_table', 'instalment_allocations', 'source_id', r.alloc::text,
            'reference_id', r.grp::text, 'currency', 'UGX', 'transaction_date', v_td, 'classification', 'production',
            'description', format('Access fee rebooked for fee posting %s at the Rent Plan fee cap', r.grp))) else '[]'::jsonb end),
        idempotency_key := c_batch || ':C2:rebook:' || r.alloc::text);
    end if;
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item) values
      (r.grp, 'Fee posting replaced by the fee-cap correction (rebooked separately)', 'C2')
    on conflict (transaction_group_id) do nothing;
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item, reverses_group_id) values
      (v_grp, 'Reversal of a fee posting (fee-cap correction): not money received', 'C2', r.grp);
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, rent_request_id,
      original_group_id, original_leg_ids, correction_group_id, rebook_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, 'C2', 'fee_cap_reverse_and_rebook', 'instalment_allocations', r.alloc, r.rid, r.grp,
      (select array_agg(g.id order by g.created_at, g.id) from public.general_ledger g where g.transaction_group_id = r.grp),
      v_grp, v_grp2, r.excess, r.rf + r.af, r.rf_ok + r.af_ok,
      jsonb_build_object('collection_table', r.source_table, 'collection_id', r.source_id, 'instalment_amount', r.instalment_amount,
        'cumulative', r.cum, 'basis_total', r.bt, 'registration_before', r.rf, 'access_before', r.af,
        'registration_after', r.rf_ok, 'access_after', r.af_ok), c_cfo);
  end loop;

  -- 6. Item C3: fee postings of reversed collections, reversed in full.
  for r in select * from _c3 order by rid, alloc loop
    select jsonb_agg(jsonb_build_object('ledger_scope', g.ledger_scope,
             'direction', case g.direction when 'cash_in' then 'cash_out' else 'cash_in' end,
             'amount', g.amount, 'category', g.category, 'source_table', 'instalment_allocations', 'source_id', r.alloc::text,
             'reference_id', g.transaction_group_id::text, 'currency', 'UGX',
             'transaction_date', case when v_mode = 'original' then g.transaction_date else v_mode::timestamptz end,
             'classification', 'production',
             'description', format('Reversal of fee posting %s (accounting only): its collection %s was reversed on %s; the fee was never reversed.',
                                   g.transaction_group_id, r.source_id, r.reversed_at::date)) order by g.created_at, g.id)
      into v_legs from public.general_ledger g where g.transaction_group_id = r.grp;
    v_grp := public.create_ledger_transaction(entries := v_legs, idempotency_key := c_batch || ':C3:' || r.alloc::text);
    update public.instalment_allocations set reversal_group_id = v_grp where id = r.alloc and reversal_group_id is null;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'STOP: allocation % changed since the schedule', r.alloc; end if;
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item) values
      (r.grp, 'Fee posting reversed in full (allocation reversed): not money received', 'C3') on conflict (transaction_group_id) do nothing;
    insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item, reverses_group_id) values
      (v_grp, 'Reversal of a fee posting: not money received', 'C3', r.grp) on conflict (transaction_group_id) do nothing;
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, rent_request_id,
      original_group_id, original_leg_ids, correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, 'C3', 'reverse_fee_of_reversed_collection', 'instalment_allocations', r.alloc, r.rid, r.grp,
      (select array_agg(g.id order by g.created_at, g.id) from public.general_ledger g where g.transaction_group_id = r.grp),
      v_grp, r.fees, r.fees, 0,
      jsonb_build_object('collection_table', r.source_table, 'collection_id', r.source_id, 'collection_reversed_at', r.reversed_at,
        'allocation_reversal_reason', r.reversal_reason), c_cfo);
  end loop;

  -- 7. Item A: tenant balances (amount_repaid only; status never changed).
  perform set_config('welile.balance_edit_source', 'acct_corr_202611_unlanded_collections', true);
  for r in select * from _a order by rid loop
    update public.rent_requests set amount_repaid = amount_repaid + r.credit
     where id = r.rid and amount_repaid = r.before and status is not distinct from r.status;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'STOP: Rent Plan % changed since the schedule (amount repaid or status)', r.rid; end if;
    select amount_repaid, status into v_x, v_st from public.rent_requests where id = r.rid;
    if v_x <> r.before + r.credit or v_st is distinct from r.status then
      raise exception 'STOP: Rent Plan % did not take the credit cleanly (now % / %)', r.rid, v_x, v_st;
    end if;
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, rent_request_id,
      amount, before_value, after_value, detail, created_by)
    values (c_batch, 'A', 'restore_tenant_balance', 'rent_requests', r.rid, r.rid, r.credit, r.before, r.before + r.credit,
      jsonb_build_object('receipts_dropped_by_guard', r.receipts, 'receipts_marked_genuine', r.live, 'contra_by_item_b', r.b_taken,
        'plan_total', r.tot, 'status_unchanged', r.status, 'reaches_total', (r.before + r.credit >= r.tot),
        'note', 'Ledger already records these receipts (DR A5 / CR A3 per receipt); only the Rent Plan balance is corrected.'), c_cfo);
    insert into public.audit_logs (user_id, actor_id, performed_by, action_type, table_name, record_id, reason, old_values, new_values, metadata)
    values (c_cfo, c_cfo, c_cfo, 'tenant_balance_restored_dropped_collections', 'rent_requests', r.rid::text,
      'Receipts recorded 15-16 Sep 2026 that the guard dropped and the 29 Sep clean-up removed are credited back to the Rent Plan balance (accounting only)',
      jsonb_build_object('amount_repaid', r.before), jsonb_build_object('amount_repaid', r.before + r.credit),
      jsonb_build_object('batch', c_batch, 'credit', r.credit, 'receipts', r.receipts, 'status_unchanged', r.status));
  end loop;

  -- 8. Every correction journal: platform only, balanced, excluded from Money In (rebooks are the true fee and count).
  for e in select g.transaction_group_id, count(*) filter (where g.ledger_scope <> 'platform') as nonplat,
                  sum(case when g.direction = 'cash_in' then g.amount else -g.amount end) as net
             from public.general_ledger g where g.idempotency_key like c_batch || ':%' group by 1 loop
    if e.nonplat > 0 or e.net <> 0 then raise exception 'STOP: correction group % is not platform-only and balanced', e.transaction_group_id; end if;
  end loop;
  if exists (select 1 from public.accounting_correction_register c where c.batch = c_batch and c.correction_group_id is not null
               and not exists (select 1 from public.money_in_report_exclusions x where x.transaction_group_id = c.correction_group_id)) then
    raise exception 'STOP: a correction group is not excluded from Money In';
  end if;
  select count(*) into v_n from public.general_ledger g where g.idempotency_key like c_batch || ':%';
  if v_n <> (select 2 * count(*) from _b) + (select coalesce(sum(jsonb_array_length(x.legs)), 0) from (
               select (select jsonb_agg(1) from public.general_ledger g where g.transaction_group_id = c.grp) as legs from _c2 c
               union all select (select jsonb_agg(1) from public.general_ledger g where g.transaction_group_id = c.grp) from _c3 c) x)
             + (select coalesce(sum(1 + (rf_ok > 0)::int + (af_ok > 0)::int) filter (where rf_ok + af_ok > 0), 0) from _c2) then
    raise exception 'STOP: unexpected number of correction legs (%)', v_n;
  end if;

  -- 9. Money-safety: nothing that holds or moves money changed.
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.general_ledger where ledger_scope = 'wallet';
  if v_n <> s_wallet_legs or v_x <> s_wallet_sum then raise exception 'STOP: a wallet-scope ledger leg was written'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into h from public.wallets_physical t;
  if h <> s_wp then raise exception 'STOP: wallets_physical changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into h from public.wallet_balances_projection t;
  if h <> s_wbp then raise exception 'STOP: wallet_balances_projection changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into h from public.agent_collections t
    where t.rent_request_id in (select rid from _a union select rid from _b union select rid from _c2 union select rid from _c3);
  if h <> s_coll then raise exception 'STOP: an agent collection changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into h from public.deposit_requests t;
  if h <> s_dep then raise exception 'STOP: a deposit request changed'; end if;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into h from public.withdrawal_requests t;
  if h <> s_wd then raise exception 'STOP: a withdrawal request changed'; end if;
  select md5(coalesce(string_agg((to_jsonb(t) - 'reversal_group_id')::text, '|' order by t.id), '')) into h
    from public.instalment_allocations t where t.rent_request_id in (select rid from _c2 union select rid from _c3);
  if h <> s_alloc then raise exception 'STOP: an allocation changed beyond its reversal link'; end if;
  select md5(coalesce(string_agg((to_jsonb(t) - 'amount_repaid' - 'updated_at')::text, '|' order by t.id), '')) into h
    from public.rent_requests t where t.id in (select rid from _a union select rid from _b union select rid from _c2 union select rid from _c3);
  if h <> s_rr then raise exception 'STOP: a Rent Plan changed beyond amount_repaid'; end if;

  insert into public.audit_logs (user_id, actor_id, performed_by, action_type, table_name, record_id, reason, metadata)
  values (c_cfo, c_cfo, c_cfo, 'accounting_correction_batch_posted', 'accounting_correction_register', c_batch,
    'September 2026 rent-collection accounting corrections (accounting records only, no money movement)',
    jsonb_build_object('batch', c_batch, 'transaction_date', v_mode,
      'A', (select jsonb_build_object('plans', count(*), 'amount', sum(credit)) from _a),
      'B', (select jsonb_build_object('receipts', count(*), 'amount', sum(take)) from _b),
      'C2', (select jsonb_build_object('allocations', count(*), 'amount', sum(excess)) from _c2),
      'C3', (select jsonb_build_object('allocations', count(*), 'amount', sum(fees)) from _c3),
      'field_decisions', (select count(*) from _field_decisions)));
  raise notice 'batch % posted: A % plans UGX %, B % receipts UGX %, C2 % UGX %, C3 % UGX %', c_batch,
    (select count(*) from _a), (select sum(credit) from _a), (select count(*) from _b), (select sum(take) from _b),
    (select count(*) from _c2), (select sum(excess) from _c2), (select count(*) from _c3), (select sum(fees) from _c3);
end $corr$;

commit;
