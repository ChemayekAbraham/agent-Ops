-- WELILE HOMES LANDLORD FLOATS BOOKED AS PAYROLL EXPENSE — batch acct_corr_202611_wh_float_l4.
-- DRAFT, NOT APPROVED. DO NOT RUN without the CFO's explicit approval. Requires migration 20261116100000.
--
-- ACCOUNTING RECORDS ONLY. Platform-scope reclassification: no wallet leg; no wallet, requisition, payout or
-- subscription change; nothing is deleted. Each original CFO direct credit stays as it is.
--
-- Facts (CFO, 12 Nov 2026): the requisitions below were CFO-approved Welile Homes landlord floats, issued through agent
-- Grace Paul Ochieng while the Welile Homes system was not working well. Each requisition lists the landlords and the
-- rent paid. They were booked as payroll expense (X1). Policy (CFO, 12 Nov 2026): A6/L4 hold 12 months of future rent,
-- so rent paid to a landlord settles that landlord's L4 obligation.
--
-- Per requisition line (landlord), one balanced group dated to the original credit:
--   DR L4 wh_landlord_float_settled (cash_out) - settles that landlord's payout obligation
--   CR X1 payroll_expense           (cash_in)  - removes the rent from staff costs
-- Only amounts within each landlord's recognised L4 obligation are included (15 lines, UGX 23,709,400), plus
-- (CFO, 12 Nov 2026) the 9,000,000 landlord float paid through James Katongole on 7 Oct 2026, booked as R&D expense:
-- no landlord list exists, so it settles the overall Welile Homes obligation and is registered as WH3 with
-- 'landlords to be identified' (CR X1 research_development_expense). Total 16 lines, UGX 32,709,400.
-- NOT included, awaiting CFO decision (UGX 3,766,000): Anthony Mukambya 3,465,000 (no subscription, no obligation);
-- Namudde Maureen 166,000 above her 4,800,000 obligation; "Buzzi" 135,000 (requisition 92325DB5, landlord unidentified).
-- Effect: L4 -32,709,400 (obligation settled); X1 -32,709,400 (payroll 23,709,400, R&D 9,000,000); cash, wallets, A6 unchanged.
-- Runs at REPEATABLE READ. Rollback: the same groups with directions swapped (see the end of this file).
begin isolation level repeatable read;

create temp table _orig (leg uuid primary key, ref text not null, amount numeric not null, cat text not null default 'payroll_expense') on commit drop;
insert into _orig values
  ('64646e28-0606-41c2-9a62-8642d692f3c3', 'PAY-MSRFPGPV-3OV7',  4527000),  -- 13 Aug, req AF19FEA7
  ('216a42c4-1730-4d34-ba3a-e36c3d9ebe27', 'PAY-MTU3BP2T-SXR8',  5517000),  -- 09 Sep, SRQ-00051
  ('15463227-5dbf-4210-96d5-42d9ca4f7bed', 'PAY-MUY7COJU-Q0HB',  4700000),  -- 07 Oct, SRQ-00226
  ('2ddd50d8-12a9-43ce-bff9-a6e0b7688605', 'PAY-MWAKJFVB-80M6', 12596400);  -- 10 Nov, SRQ-00471
insert into _orig values
  ('8a4017e5-653c-441a-aa34-136dfc3c60bc', 'PAY-MUY1CVKD-8SJ9',  9000000, 'research_development_expense');  -- 07 Oct, James Katongole
create temp table _l (leg uuid not null, landlord text not null, amount numeric not null, primary key (leg, landlord)) on commit drop;
insert into _l values
  ('64646e28-0606-41c2-9a62-8642d692f3c3', 'Ndaula Thomas',    3294000),
  ('64646e28-0606-41c2-9a62-8642d692f3c3', 'Namudde Maureen',  1233000),
  ('216a42c4-1730-4d34-ba3a-e36c3d9ebe27', 'Ndaula Thomas',    2187000),
  ('216a42c4-1730-4d34-ba3a-e36c3d9ebe27', 'Babirye Patricia',  135000),
  ('216a42c4-1730-4d34-ba3a-e36c3d9ebe27', 'Mwesige Banarbus',  702000),
  ('216a42c4-1730-4d34-ba3a-e36c3d9ebe27', 'Namudde Maureen',  1233000),
  ('15463227-5dbf-4210-96d5-42d9ca4f7bed', 'Ndaula Thomas',    2370000),
  ('15463227-5dbf-4210-96d5-42d9ca4f7bed', 'Namudde Maureen',  1250000),
  ('15463227-5dbf-4210-96d5-42d9ca4f7bed', 'Babirye Patricia',  135000),
  ('2ddd50d8-12a9-43ce-bff9-a6e0b7688605', 'Ndaula Thomas',    1700000),
  ('2ddd50d8-12a9-43ce-bff9-a6e0b7688605', 'Namudde Maureen',  1084000),
  ('2ddd50d8-12a9-43ce-bff9-a6e0b7688605', 'Babirye Patricia',  270000),
  ('2ddd50d8-12a9-43ce-bff9-a6e0b7688605', 'Mwesige Banarbus',  756000),
  ('2ddd50d8-12a9-43ce-bff9-a6e0b7688605', 'Mukama Michael',   3110400),
  ('2ddd50d8-12a9-43ce-bff9-a6e0b7688605', 'Simon Kidugudu',   4250000),
  ('8a4017e5-653c-441a-aa34-136dfc3c60bc', 'Landlords to be identified (via James Katongole)', 9000000);
create temp table _expected (n int not null, amount numeric not null) on commit drop;
insert into _expected values (16, 32709400);

do $corr$
declare
  c_batch constant text := 'acct_corr_202611_wh_float_l4';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  e record; r record; v_n int; v_x numeric; v_grp uuid;
  s_wallet_legs bigint; s_wallet_sum numeric;
begin
  if exists (select 1 from public.accounting_correction_register where batch = c_batch) then
    raise exception 'STOP: batch % is already posted', c_batch;
  end if;
  select * into e from _expected;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from _l;
  if v_n <> e.n or v_x <> e.amount then raise exception 'STOP: input is % / %, approved % / %', v_n, v_x, e.n, e.amount; end if;
  if (select count(*) from public.ledger_account_map where ledger_scope = 'platform' and category = 'wh_landlord_float_settled'
        and wallet_bucket is null and account_code = 'L4' and debit_when = 'cash_out') <> 1 then
    raise exception 'STOP: migration 20261116100000 is not applied';
  end if;

  -- 1. Every original credit must still be what the evidence describes, and its lines must not exceed it.
  for r in select o.*, g.id is not null found, g.ledger_scope, g.category, g.direction, g.amount gl_amount, g.source_table,
                  g.reference_id, (select sum(l.amount) from _l l where l.leg = o.leg) lines
             from _orig o left join public.general_ledger g on g.id = o.leg
  loop
    if not r.found or r.ledger_scope <> 'platform' or r.category <> r.cat or r.direction <> 'cash_out'
       or r.gl_amount <> r.amount or r.source_table <> 'cfo_direct_credit' or r.reference_id <> r.ref then
      raise exception 'STOP: credit % no longer matches the evidence', r.ref;
    end if;
    if r.lines > r.amount then raise exception 'STOP: lines for % exceed the credit', r.ref; end if;
  end loop;

  -- 2. Money-safety snapshot.
  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';

  -- 3. One balanced platform-only group per requisition line, dated to the original credit.
  for r in select l.leg, l.landlord, l.amount, o.ref, o.cat, g.transaction_group_id orig_group, g.transaction_date
             from _l l join _orig o on o.leg = l.leg join public.general_ledger g on g.id = l.leg
            order by g.transaction_date, l.landlord
  loop
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'wh_landlord_float_settled',
        'source_table', 'general_ledger', 'source_id', r.leg::text, 'reference_id', r.ref, 'currency', 'UGX',
        'transaction_date', r.transaction_date, 'classification', 'production',
        'description', format('Correction (accounting only, no money moved): CFO-approved Welile Homes landlord float of UGX %s to %s (%s) settles the landlord payout obligation.', r.amount, r.landlord, r.ref)),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount, 'category', r.cat,
        'source_table', 'general_ledger', 'source_id', r.leg::text, 'reference_id', r.ref, 'currency', 'UGX',
        'transaction_date', r.transaction_date, 'classification', 'production',
        'description', format('Correction (accounting only, no money moved): the same UGX %s for %s was booked as %s; it is landlord rent, not an operating cost.', r.amount, r.landlord, replace(r.cat, '_', ' ')))),
      idempotency_key := c_batch || ':' || r.leg::text || ':' || lower(replace(r.landlord, ' ', '_')));
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, original_group_id,
      original_leg_ids, correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, case when r.cat = 'payroll_expense' then 'WH2' else 'WH3' end,
      'wh_float_to_l4:' || lower(replace(r.landlord, ' ', '_')), 'general_ledger', r.leg, r.orig_group, array[r.leg], v_grp,
      r.amount, r.amount, 0, jsonb_build_object('landlord', r.landlord, 'requisition_payment', r.ref,
        'paid_through', case when r.cat = 'payroll_expense' then 'Grace Paul Ochieng' else 'James Katongole' end,
        'basis', 'CFO 12 Nov 2026: approved Welile Homes landlord float'), c_cfo);
  end loop;

  -- 4. Checks.
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch;
  if v_n <> e.n or v_x <> e.amount then raise exception 'STOP: posted % / %', v_n, v_x; end if;
  if (select count(*) from public.general_ledger where ledger_scope = 'wallet') <> s_wallet_legs
     or (select coalesce(sum(amount), 0) from public.general_ledger where ledger_scope = 'wallet') <> s_wallet_sum then
    raise exception 'STOP: wallet legs changed';
  end if;
  raise notice '% posted: % lines, UGX %', c_batch, v_n, v_x;
end
$corr$;

commit;

-- ROLLBACK (only on CFO instruction): for every group of batch acct_corr_202611_wh_float_l4 in
-- accounting_correction_register, post the same two legs with directions swapped (idempotency key
-- acct_corr_202611_wh_float_l4_rb:<group>) and set rolled_back_at / rollback_group_id. Nothing is deleted.
