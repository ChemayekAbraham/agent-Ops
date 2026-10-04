
CREATE TABLE IF NOT EXISTS public.deposit_guardrail_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('blocked','reverted')),
  source text NOT NULL,
  prior_status text,
  attempted_status text,
  missing_match_key text,
  reason text NOT NULL,
  actor uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deposit_guardrail_audit_deposit ON public.deposit_guardrail_audit(deposit_id);
CREATE INDEX IF NOT EXISTS idx_deposit_guardrail_audit_created ON public.deposit_guardrail_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposit_guardrail_audit_action ON public.deposit_guardrail_audit(action);

ALTER TABLE public.deposit_guardrail_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "guardrail_audit_read_privileged" ON public.deposit_guardrail_audit;
CREATE POLICY "guardrail_audit_read_privileged"
ON public.deposit_guardrail_audit
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(),'manager')
  OR public.has_role(auth.uid(),'cfo')
  OR public.has_role(auth.uid(),'ceo')
  OR public.has_role(auth.uid(),'coo')
  OR public.has_role(auth.uid(),'operations')
  OR public.has_role(auth.uid(),'super_admin')
);

CREATE OR REPLACE FUNCTION public.derive_deposit_guardrail_source(p_deposit public.deposit_requests)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
begin
  if coalesce(p_deposit.notes,'') like '[auto]%' then return 'auto_gmail'; end if;
  if exists (select 1 from gmail_transactions g where g.linked_deposit_request_id = p_deposit.id) then
    return 'auto_gmail';
  end if;
  if coalesce(p_deposit.notes,'') like '%[backfill%' then return 'backfill'; end if;
  if p_deposit.processed_by is not null then return 'manual'; end if;
  return 'unknown';
end;
$$;

CREATE OR REPLACE FUNCTION public.enforce_auto_deposit_requires_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_is_auto boolean;
  v_has_ledger boolean;
  v_source text;
  v_prior text;
begin
  if NEW.status is distinct from 'approved' then
    return NEW;
  end if;

  v_is_auto := (
    coalesce(NEW.notes, '') like '[auto]%'
    OR exists (select 1 from gmail_transactions g where g.linked_deposit_request_id = NEW.id)
  );

  if not v_is_auto then return NEW; end if;

  v_has_ledger := exists (
    select 1 from general_ledger gl
     where gl.source_table = 'deposit_requests'
       and gl.source_id    = NEW.id
  );

  if not v_has_ledger then
    v_source := public.derive_deposit_guardrail_source(NEW);
    v_prior  := case when TG_OP = 'UPDATE' then OLD.status else null end;

    insert into public.deposit_guardrail_audit (
      deposit_id, action, source, prior_status, attempted_status,
      missing_match_key, reason, actor, metadata
    ) values (
      NEW.id, 'blocked', v_source, v_prior, NEW.status,
      'general_ledger.source_table=deposit_requests AND source_id=' || NEW.id::text,
      'Approval blocked: no general_ledger entry posted for this auto-created deposit.',
      auth.uid(),
      jsonb_build_object(
        'amount', NEW.amount,
        'provider', NEW.provider,
        'transaction_id', NEW.transaction_id,
        'auto_approved', NEW.auto_approved,
        'tg_op', TG_OP
      )
    );

    raise exception
      'Guardrail: auto-created deposit % cannot be marked approved without a general_ledger entry. Route through DepositFlow / approve-deposit so the ledger is posted and the correct wallet bucket is credited.',
      NEW.id
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;

CREATE OR REPLACE FUNCTION public.log_deposit_guardrail_revert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_has_ledger boolean;
  v_source text;
begin
  if OLD.status = 'approved' and NEW.status = 'pending' then
    v_has_ledger := exists (
      select 1 from general_ledger gl
       where gl.source_table = 'deposit_requests'
         and gl.source_id    = NEW.id
    );

    if not v_has_ledger then
      v_source := public.derive_deposit_guardrail_source(NEW);

      insert into public.deposit_guardrail_audit (
        deposit_id, action, source, prior_status, attempted_status,
        missing_match_key, reason, actor, metadata
      ) values (
        NEW.id, 'reverted', v_source, OLD.status, NEW.status,
        'general_ledger.source_table=deposit_requests AND source_id=' || NEW.id::text,
        'Reverted approved → pending: no general_ledger entry exists for this deposit.',
        auth.uid(),
        jsonb_build_object(
          'amount', NEW.amount,
          'provider', NEW.provider,
          'transaction_id', NEW.transaction_id,
          'notes_excerpt', left(coalesce(NEW.notes,''), 300)
        )
      );
    end if;
  end if;
  return NEW;
end;
$$;

DROP TRIGGER IF EXISTS trg_log_deposit_guardrail_revert ON public.deposit_requests;
CREATE TRIGGER trg_log_deposit_guardrail_revert
AFTER UPDATE OF status ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.log_deposit_guardrail_revert();
