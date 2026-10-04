-- =====================================================================
-- PSO-FACIL-RELEASE-2026-09-21-T
-- Facilitation disbursement: moves the money and records it, together.
-- Modelled on the existing salary payout posting.
-- =====================================================================

create or replace function public.pso_facilitation_disburse(_requisition_id uuid)
returns public.staff_requisitions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_is_disb boolean;
  v_req   public.staff_requisitions%rowtype;
  v_idem  text;
  v_amt   numeric;
begin
  if v_actor is null then
    raise exception 'Disbursement requires a signed-in disburser.';
  end if;

  select exists (select 1 from public.pso_facilitation_disbursers d
                  where d.user_id = v_actor and d.enabled) into v_is_disb;
  if not v_is_disb then
    raise exception 'Only the named facilitation disburser may release these funds.';
  end if;

  select * into v_req from public.staff_requisitions
   where id = _requisition_id for update;

  if v_req.id is null then
    raise exception 'That facilitation request does not exist.';
  end if;
  if coalesce(v_req.request_kind,'requisition') <> 'facilitation' then
    raise exception 'This function releases facilitation only.';
  end if;
  if v_req.stage <> 'approved' then
    raise exception 'Facilitation cannot be disbursed before the COO has approved it.';
  end if;
  if coalesce(v_req.wallet_credit_status,'') = 'credited' then
    raise exception 'This facilitation has already been disbursed.';
  end if;
  if v_actor = v_req.requester_id then
    raise exception 'You cannot disburse your own facilitation.';
  end if;

  v_amt  := coalesce(v_req.approved_amount, v_req.amount);
  v_idem := 'pso_facilitation_' || v_req.id::text;

  perform public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_req.requester_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', v_amt, 'category', 'facilitation_disbursement', 'recipient_type', 'user',
        'classification', 'production',
        'source_table', 'staff_requisitions', 'source_id', v_req.id,
        'description', 'Facilitation disbursed', 'currency', coalesce(v_req.currency,'UGX'),
        'transaction_date', current_date,
        'metadata', jsonb_build_object('source','pso_facilitation',
                                       'requisition_code', v_req.requisition_code,
                                       'disbursed_by', v_actor)
      ),
      jsonb_build_object(
        'user_id', v_req.requester_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', v_amt, 'category', 'facilitation_disbursement', 'recipient_type', 'user',
        'classification', 'production',
        'source_table', 'staff_requisitions', 'source_id', v_req.id,
        'description', 'Facilitation received', 'currency', coalesce(v_req.currency,'UGX'),
        'transaction_date', current_date,
        'metadata', jsonb_build_object('source','pso_facilitation',
                                       'requisition_code', v_req.requisition_code)
      )
    ),
    idempotency_key := v_idem
  );

  insert into public.requisition_wallet_credits
    (source_table, requisition_id, requisition_code, user_id, approver_id,
     amount, currency, status, approved_at, credited_at, metadata)
  values
    ('staff_requisitions', v_req.id, v_req.requisition_code, v_req.requester_id, v_actor,
     v_amt, coalesce(v_req.currency,'UGX'), 'credited', v_req.coo_decided_at, now(),
     jsonb_build_object('source','pso_facilitation'));

  update public.staff_requisitions
     set wallet_credit_status = 'credited'
   where id = v_req.id
  returning * into v_req;

  return v_req;
end;
$function$;

revoke all on function public.pso_facilitation_disburse(uuid) from public, anon;
grant execute on function public.pso_facilitation_disburse(uuid) to authenticated;

do $$
declare v_over integer; v_anon boolean; v_def text;
begin
  select count(*) into v_over from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='pso_facilitation_disburse';
  if v_over <> 1 then raise exception 'FAIL A: % overloads', v_over; end if;

  select has_function_privilege('anon','public.pso_facilitation_disburse(uuid)','execute') into v_anon;
  if v_anon then raise exception 'FAIL B: anon can disburse'; end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='pso_facilitation_disburse';
  if v_def not like '%create_ledger_transaction%' then
    raise exception 'FAIL C: disbursement does not post to the ledger';
  end if;
  if v_def not like '%pso_facilitation_disbursers%' then
    raise exception 'FAIL D: disbursement does not check the named disburser';
  end if;

  if (select count(*) from public.staff_requisitions) <> 96
  or (select count(*) from public.hr_pay_advances) <> 7 then
    raise exception 'FAIL E: existing rows changed';
  end if;

  raise notice 'PSO-FACIL-RELEASE-2026-09-21-T PASSED — disbursement posts to the ledger and stamps in one transaction';
end $$;

-- =====================================================================
-- END PSO-FACIL-RELEASE-2026-09-21-T
-- =====================================================================