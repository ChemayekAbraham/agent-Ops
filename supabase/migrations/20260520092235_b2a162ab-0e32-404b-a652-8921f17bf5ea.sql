
CREATE OR REPLACE FUNCTION public.enforce_auto_deposit_requires_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_is_auto    boolean;
  v_has_ledger boolean;
  v_source     text;
  v_prior      text;
begin
  if NEW.status is distinct from 'approved' then
    return NEW;
  end if;

  v_is_auto := (
    coalesce(NEW.notes, '') like '[auto]%'
    OR exists (select 1 from gmail_transactions g where g.linked_deposit_request_id = NEW.id)
  );

  if not v_is_auto then
    return NEW;
  end if;

  v_has_ledger := exists (
    select 1 from general_ledger gl
     where gl.source_table = 'deposit_requests'
       and gl.source_id    = NEW.id
  );

  if v_has_ledger then
    return NEW;
  end if;

  -- No ledger entry: SILENTLY DEMOTE to pending so the audit row persists.
  -- (Raising an exception here would roll back the audit insert too.)
  v_source := public.derive_deposit_guardrail_source(NEW);
  v_prior  := case when TG_OP = 'UPDATE' then OLD.status else null end;

  insert into public.deposit_guardrail_audit (
    deposit_id, action, source, prior_status, attempted_status,
    missing_match_key, reason, actor, metadata
  ) values (
    NEW.id, 'blocked', v_source, v_prior, 'approved',
    'general_ledger.source_table=deposit_requests AND source_id=' || NEW.id::text,
    'Approval blocked: no general_ledger entry posted for this auto-created deposit. Status forced back to pending.',
    auth.uid(),
    jsonb_build_object(
      'amount', NEW.amount,
      'provider', NEW.provider,
      'transaction_id', NEW.transaction_id,
      'auto_approved', NEW.auto_approved,
      'tg_op', TG_OP
    )
  );

  NEW.status      := 'pending';
  NEW.approved_at := NULL;
  NEW.notes := coalesce(NEW.notes,'')
            || E'\n[guardrail '
            || to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI')
            || '] approval blocked — no general_ledger entry; held as pending.';

  return NEW;
end;
$$;
