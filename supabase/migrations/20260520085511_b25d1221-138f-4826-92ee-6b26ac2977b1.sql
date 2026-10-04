
CREATE OR REPLACE FUNCTION public.reopen_deposit_for_repair(p_deposit_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_caller uuid := auth.uid();
  v_row    record;
  v_has_ledger boolean;
begin
  if v_caller is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_row from deposit_requests where id = p_deposit_id for update;
  if not found then
    raise exception 'Deposit % not found', p_deposit_id using errcode = 'no_data_found';
  end if;

  -- Caller must be the agent who logged it OR the user it belongs to
  if v_row.agent_id is distinct from v_caller and v_row.user_id is distinct from v_caller then
    raise exception 'Not authorized to repair this deposit' using errcode = '42501';
  end if;

  if v_row.status <> 'approved' then
    raise exception 'Only approved deposits can be reopened (current status: %)', v_row.status using errcode = 'check_violation';
  end if;

  -- Safety: if a ledger entry already exists, this is NOT a stuck deposit. Refuse.
  select exists (
    select 1 from general_ledger
     where source_table = 'deposit_requests' and source_id = p_deposit_id
  ) into v_has_ledger;

  if v_has_ledger then
    raise exception 'Deposit % already has a ledger entry — nothing to repair', p_deposit_id using errcode = 'check_violation';
  end if;

  update deposit_requests
     set status      = 'pending',
         approved_at = null,
         auto_approved = false,
         purpose_audit = coalesce(purpose_audit, '{}'::jsonb) || jsonb_build_object(
           'reopened_for_repair_at', now(),
           'reopened_by', v_caller,
           'previous_status', 'approved',
           'reason', 'No general_ledger entry — repair workflow'
         ),
         updated_at = now()
   where id = p_deposit_id;

  -- Audit log (project standard requires action_type, table_name, record_id, reason ≥10 chars)
  begin
    insert into audit_logs (action_type, table_name, record_id, reason, user_id, metadata)
    values (
      'deposit_reopened_for_repair',
      'deposit_requests',
      p_deposit_id,
      'Reopened stuck auto-deposit (no ledger entry) for purpose confirmation',
      v_caller,
      jsonb_build_object('amount', v_row.amount, 'transaction_id', v_row.transaction_id, 'provider', v_row.provider)
    );
  exception when others then null; -- non-fatal
  end;

  -- System event
  begin
    insert into system_events (event_type, actor_id, subject_id, payload)
    values (
      'deposit.repair_reopened',
      v_caller,
      p_deposit_id,
      jsonb_build_object(
        'deposit_id', p_deposit_id,
        'amount', v_row.amount,
        'transaction_id', v_row.transaction_id,
        'provider', v_row.provider,
        'original_user_id', v_row.user_id,
        'agent_id', v_row.agent_id
      )
    );
  exception when others then null; -- non-fatal
  end;

  return jsonb_build_object(
    'ok', true,
    'deposit_id', p_deposit_id,
    'new_status', 'pending'
  );
end;
$$;

GRANT EXECUTE ON FUNCTION public.reopen_deposit_for_repair(uuid) TO authenticated;
