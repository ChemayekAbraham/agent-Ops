-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2: promissory note approval funds the attached tenant plans from the
-- partner's own withdrawable wallet, then hands over to the existing
-- self-managed partner pipeline (pending portfolio → Partner Ops → email).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.promissory_note_plan_intents
  ADD COLUMN IF NOT EXISTS commitment_id uuid;

-- 1. DRY core: build a self-managed commitment + pending portfolio for ANY
--    partner (not only auth.uid()), so both the partner-driven self-support
--    flow and promissory-note approval share one implementation.
CREATE OR REPLACE FUNCTION public.psm_confirm_commitment_for(
  p_partner uuid,
  p_rent_request_ids uuid[],
  p_term_months integer DEFAULT 1,
  p_idempotency_key text DEFAULT NULL,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_key text := COALESCE(NULLIF(p_idempotency_key,''), 'psm-' || p_partner::text || '-' || md5(array_to_string(p_rent_request_ids,',')));
  v_existing public.partner_self_commitments%ROWTYPE;
  v_commitment_id uuid;
  v_total numeric;
  v_count integer;
  v_min numeric;
  v_available numeric;
  v_reserved numeric;
  v_rate numeric := 15;
  v_term integer := GREATEST(1, LEAST(COALESCE(p_term_months,1), 12));
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_actor uuid := COALESCE(p_actor, auth.uid(), p_partner);
BEGIN
  IF p_partner IS NULL THEN
    RAISE EXCEPTION 'PARTNER_REQUIRED';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids,1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;

  IF NOT public.funder_has_signed_agreement(p_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || p_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
                              'committed_amount', v_existing.committed_amount,
                              'lines', v_existing.lines_count,
                              'status', v_existing.status);
  END IF;

  -- Release stale holds, then make sure this partner holds every supplied plan.
  UPDATE public.partner_self_plan_claims
     SET status='expired', closed_at=now(), updated_at=now()
   WHERE status='held' AND expires_at <= now();

  INSERT INTO public.partner_self_plan_claims (rent_request_id, partner_id, amount, expires_at, idempotency_key)
  SELECT p.rent_request_id, p_partner, p.funding_amount, now() + interval '15 minutes', v_key
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = ANY(p_rent_request_ids)
    AND (p.held_by IS NULL OR p.held_by = p_partner)
  ON CONFLICT (rent_request_id) WHERE status IN ('held','confirmed') DO NOTHING;

  UPDATE public.partner_self_plan_claims
     SET expires_at = now() + interval '15 minutes', updated_at = now()
   WHERE partner_id = p_partner AND status = 'held' AND rent_request_id = ANY(p_rent_request_ids);

  SELECT COUNT(*), COALESCE(SUM(amount),0), COALESCE(MIN(amount),0)
  INTO v_count, v_total, v_min
  FROM public.partner_self_plan_claims
  WHERE partner_id = p_partner AND status = 'held' AND expires_at > now()
    AND rent_request_id = ANY(p_rent_request_ids);

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_rent_request_ids,1),0) THEN
    RAISE EXCEPTION 'Some selections are no longer available. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_min < 50000 THEN
    RAISE EXCEPTION 'Each plan funded must be at least UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  -- get_user_available_balance already excludes capital held by pending portfolios.
  v_available := public.get_user_available_balance(p_partner);
  v_reserved := public.funder_pending_hold(p_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: plans total UGX %, partner has UGX % available (UGX % already awaiting approval).',
      round(v_total), round(GREATEST(v_available,0)), round(v_reserved)
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (
    p_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval'
  ) RETURNING id INTO v_commitment_id;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months
  )
  SELECT v_commitment_id, p_partner, c.rent_request_id, c.amount, v_rate, v_term
  FROM public.partner_self_plan_claims c
  WHERE c.partner_id = p_partner AND c.status='held' AND c.rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.partner_self_plan_claims
     SET status='confirmed', confirmed_at=now(), commitment_id=v_commitment_id, updated_at=now()
   WHERE partner_id = p_partner AND status='held' AND rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.rent_requests rr
     SET self_funding_partner_id = p_partner,
         self_funding_line_id = l.id,
         updated_at = now()
  FROM public.partner_self_funding_lines l
  WHERE l.commitment_id = v_commitment_id AND rr.id = l.rent_request_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = p_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSP-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    p_partner, COALESCE(v_agent, p_partner), v_code, v_total, v_term,
    v_rate, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, p_partner, v_total, 'self_managed', v_commitment_id, v_term);

  PERFORM public.psm_audit(v_actor, p_partner, 'commitment_pending_ops_approval', 'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'lines', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'available_before', v_available,
                       'idempotency_key', v_key));

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'committed_amount', v_total, 'lines', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'portfolio_id', v_portfolio_id,
    'status', 'pending_ops_approval',
    'available_balance', public.get_user_available_balance(p_partner)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.psm_confirm_commitment_for(uuid, uuid[], integer, text, uuid) TO service_role;

-- 2. Partner-driven self-support now delegates to the shared core.
CREATE OR REPLACE FUNCTION public.partner_self_confirm_commitment(
  p_rent_request_ids uuid[],
  p_term_months integer DEFAULT 1,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;

  RETURN public.psm_confirm_commitment_for(
    v_uid, p_rent_request_ids, p_term_months,
    COALESCE(NULLIF(p_idempotency_key,''), 'psm-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids,','))),
    v_uid
  );
END;
$$;

-- 3. Pledge notice queue: partner is told at note creation which tenants they
--    are backing and what they earn over 12 months.
CREATE TABLE IF NOT EXISTS public.promissory_note_pledge_notices (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  note_id uuid NOT NULL UNIQUE REFERENCES public.promissory_notes(id) ON DELETE CASCADE,
  partner_name text NOT NULL,
  phone text,
  email text,
  amount numeric(14,2) NOT NULL,
  attached_count integer NOT NULL DEFAULT 0,
  attached_amount numeric(14,2) NOT NULL DEFAULT 0,
  monthly_return numeric(14,2) NOT NULL DEFAULT 0,
  annual_return numeric(14,2) NOT NULL DEFAULT 0,
  tenants jsonb NOT NULL DEFAULT '[]'::jsonb,
  sms_status text NOT NULL DEFAULT 'pending',
  email_status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pnpn_sms_status_check CHECK (sms_status IN ('pending','sent','failed','skipped')),
  CONSTRAINT pnpn_email_status_check CHECK (email_status IN ('pending','sent','failed','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_pnpn_pending
  ON public.promissory_note_pledge_notices(created_at)
  WHERE sms_status = 'pending' OR email_status = 'pending';

GRANT SELECT ON public.promissory_note_pledge_notices TO authenticated;
GRANT ALL ON public.promissory_note_pledge_notices TO service_role;

ALTER TABLE public.promissory_note_pledge_notices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own pledge notices"
  ON public.promissory_note_pledge_notices FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.promissory_notes n
      WHERE n.id = note_id AND n.agent_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Ops view pledge notices"
  ON public.promissory_note_pledge_notices FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = (SELECT auth.uid())
        AND ur.role = ANY (ARRAY['operations','cfo','coo','super_admin','manager','partner_ops']::app_role[])
    )
  );

CREATE TRIGGER trg_pnpn_updated_at
  BEFORE UPDATE ON public.promissory_note_pledge_notices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Builder used by note creation: snapshots the pledge for messaging.
CREATE OR REPLACE FUNCTION public.psm_queue_promissory_pledge_notice(p_note_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_note public.promissory_notes;
  v_tenants jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_amount numeric := 0;
BEGIN
  SELECT * INTO v_note FROM public.promissory_notes WHERE id = p_note_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tenant_name', COALESCE(v.tenant_full_name, 'Tenant'),
           'tenant_location', COALESCE(v.tenant_location, v.request_city, ''),
           'principal', i.amount
         ) ORDER BY i.amount DESC), '[]'::jsonb),
         COUNT(*), COALESCE(SUM(i.amount), 0)
  INTO v_tenants, v_count, v_amount
  FROM public.promissory_note_plan_intents i
  LEFT JOIN public.v_partner_self_fundable_plans v ON v.rent_request_id = i.rent_request_id
  WHERE i.note_id = p_note_id AND i.status = 'reserved';

  INSERT INTO public.promissory_note_pledge_notices (
    note_id, partner_name, phone, email, amount,
    attached_count, attached_amount, monthly_return, annual_return, tenants
  ) VALUES (
    p_note_id, v_note.partner_name,
    COALESCE(NULLIF(btrim(v_note.whatsapp_number),''), NULLIF(btrim(v_note.phone_number),'')),
    NULLIF(btrim(v_note.email),''),
    v_note.amount, v_count, v_amount,
    round(v_note.amount * 0.15), round(v_note.amount * 0.15 * 12),
    v_tenants
  )
  ON CONFLICT (note_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.psm_queue_promissory_pledge_notice(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.psm_queue_promissory_pledge_notice(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.psm_queue_promissory_pledge_notice(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.psm_queue_promissory_pledge_notice(uuid) TO service_role;

-- 4. Note creation queues the pledge notice (SMS + email) in the same call.
CREATE OR REPLACE FUNCTION public.agent_create_promissory_note(
  p_payload jsonb,
  p_rent_request_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[] := COALESCE(p_rent_request_ids, '{}'::uuid[]);
  v_amount numeric := COALESCE((p_payload->>'amount')::numeric, 0);
  v_name text := btrim(COALESCE(p_payload->>'partner_name', ''));
  v_whatsapp text := btrim(COALESCE(p_payload->>'whatsapp_number', ''));
  v_type text := COALESCE(NULLIF(btrim(p_payload->>'contribution_type'), ''), 'once_off');
  v_note public.promissory_notes;
  v_valid integer;
  v_sum numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised to create promissory notes' USING ERRCODE = '42501';
  END IF;

  IF length(v_name) < 3 THEN
    RAISE EXCEPTION 'Partner name is required' USING ERRCODE = '22023';
  END IF;
  IF length(regexp_replace(v_whatsapp, '\D', '', 'g')) < 9 THEN
    RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023';
  END IF;
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Promised amount must be greater than zero' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.promissory_notes (
    agent_id, partner_name, whatsapp_number, phone_number, email,
    amount, contribution_type, deduction_day, next_deduction_date
  ) VALUES (
    v_uid, v_name, v_whatsapp,
    NULLIF(btrim(COALESCE(p_payload->>'phone_number','')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'email','')), ''),
    v_amount,
    CASE WHEN v_type = 'monthly' THEN 'monthly' ELSE 'once_off' END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'deduction_day','')::integer END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'next_deduction_date','')::date END
  )
  RETURNING * INTO v_note;

  IF array_length(v_ids, 1) IS NOT NULL AND array_length(v_ids, 1) > 0 THEN
    INSERT INTO public.promissory_note_plan_intents (note_id, rent_request_id, agent_id, amount)
    SELECT v_note.id, p.rent_request_id, v_uid, p.funding_amount
    FROM public.v_partner_self_fundable_plans p
    WHERE p.rent_request_id = ANY (v_ids)
      AND p.held_by IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_plan_intents i
        WHERE i.rent_request_id = p.rent_request_id AND i.status = 'reserved'
      );

    SELECT COUNT(*), COALESCE(SUM(amount), 0) INTO v_valid, v_sum
    FROM public.promissory_note_plan_intents
    WHERE note_id = v_note.id AND status = 'reserved';

    IF v_valid <> array_length(v_ids, 1) THEN
      RAISE EXCEPTION 'PLANS_UNAVAILABLE: some selected rent plans are no longer ready to fund. Refresh and try again, or create the note without attached plans.'
        USING ERRCODE = '23514';
    END IF;

    IF v_sum > v_amount THEN
      RAISE EXCEPTION 'PLANS_EXCEED_AMOUNT: attached plans total more than the promised amount.'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    v_valid := 0;
  END IF;

  PERFORM public.psm_queue_promissory_pledge_notice(v_note.id);

  RETURN jsonb_build_object(
    'note', to_jsonb(v_note),
    'attached_count', COALESCE(v_valid,0),
    'attached_amount', COALESCE(v_sum,0),
    'monthly_return', round(v_amount * 0.15),
    'annual_return', round(v_amount * 0.15 * 12)
  );
END;
$$;

-- 5. Approval: fund the attached plans from the partner's withdrawable wallet.
CREATE OR REPLACE FUNCTION public.approve_promissory_note(p_note_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
declare
  v_note record;
  v_actor uuid := auth.uid();
  v_amount numeric;
  v_idempotency_key text;
  v_group_id uuid;
  v_ids uuid[];
  v_intent_total numeric := 0;
  v_available numeric := 0;
  v_commit jsonb := null;
begin
  if v_actor is null then
    return jsonb_build_object('status','error','message','Not authenticated');
  end if;
  if not exists (
    select 1 from public.user_roles ur
     where ur.user_id = v_actor
       and ur.role = any (array['operations','cfo','coo','super_admin','manager','partner_ops','ceo']::app_role[])
  ) then
    return jsonb_build_object('status','error','message','Not authorised to approve promissory notes');
  end if;
  if p_reason is null or length(btrim(p_reason)) < 20 then
    return jsonb_build_object('status','error','message','A reason of at least 20 characters is required.');
  end if;

  select * into v_note from public.promissory_notes where id = p_note_id for update;
  if not found then
    return jsonb_build_object('status','error','message','Promissory note not found');
  end if;
  if v_note.approval_bonus_paid then
    return jsonb_build_object('status','already_approved');
  end if;

  -- ── Attached tenant plans: the partner's own money funds them now ─────────
  select array_agg(rent_request_id), coalesce(sum(amount),0)
    into v_ids, v_intent_total
  from public.promissory_note_plan_intents
   where note_id = p_note_id and status = 'reserved';

  if v_ids is not null and array_length(v_ids,1) > 0 then
    if v_note.partner_user_id is null then
      return jsonb_build_object('status','error','message',
        'PARTNER_NOT_REGISTERED: this note has tenant plans attached. The partner must register and deposit their funds before it can be approved.');
    end if;

    v_available := public.get_user_available_balance(v_note.partner_user_id);
    if v_intent_total > v_available then
      return jsonb_build_object('status','error','message',
        'PARTNER_FUNDS_SHORT: attached plans total UGX ' || to_char(round(v_intent_total),'FM999,999,999') ||
        ' but the partner has only UGX ' || to_char(round(greatest(v_available,0)),'FM999,999,999') ||
        ' available in their withdrawable wallet.');
    end if;

    begin
      -- 12-month engagement, mirrors the returns promised at note creation.
      v_commit := public.psm_confirm_commitment_for(
        v_note.partner_user_id, v_ids, 12, 'pnote-' || p_note_id::text, v_actor);
    exception when others then
      return jsonb_build_object('status','error','message', sqlerrm);
    end;

    update public.promissory_note_plan_intents
       set status = 'funded',
           commitment_id = (v_commit->>'commitment_id')::uuid,
           updated_at = now()
     where note_id = p_note_id and status = 'reserved';
  end if;

  -- ── Agent validation bonus (unchanged) ───────────────────────────────────
  v_amount := public.partner_note_rate('agent', now());
  if v_amount is null or v_amount <= 0 then
    return jsonb_build_object('status','error','message','No agent bonus rate in force');
  end if;

  v_idempotency_key := 'promissory_note_verified:' || p_note_id::text;

  v_group_id := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object('user_id',v_note.agent_id,'amount',v_amount,
        'direction','cash_out','category','marketing_expense',
        'source_table','promissory_notes','source_id',p_note_id::text,
        'description','Marketing expense: Verified promissory note bonus',
        'ledger_scope','platform'),
      jsonb_build_object('user_id',v_note.agent_id,'amount',v_amount,
        'direction','cash_in','category','agent_commission',
        'source_table','promissory_notes','source_id',p_note_id::text,
        'description','Bonus: Verified promissory note',
        'ledger_scope','wallet','recipient_type','user')),
    v_idempotency_key);

  update public.promissory_notes
     set approved_at = now(), approved_by = v_actor,
         approval_reason = btrim(p_reason), approval_bonus_paid = true,
         status = case when status = 'pending' then 'activated' else status end,
         updated_at = now()
   where id = p_note_id;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  values (v_actor,'update','approve_promissory_note','promissory_notes',p_note_id::text,
    jsonb_build_object('reason',btrim(p_reason),'agent_id',v_note.agent_id,
      'partner_name',v_note.partner_name,'bonus_amount',v_amount,
      'ledger_group_id',v_group_id,
      'attached_plans', coalesce(array_length(v_ids,1),0),
      'attached_amount', v_intent_total,
      'commitment', v_commit));

  begin
    insert into public.notifications (user_id, title, message, type, metadata)
    values (v_note.agent_id,
      'Reward earned: UGX ' || to_char(v_amount,'FM999,999,999'),
      'Your promissory note for ' || v_note.partner_name ||
      ' was verified — UGX ' || to_char(v_amount,'FM999,999,999') ||
      ' has been added to your wallet.',
      'success',
      jsonb_build_object('source_id',p_note_id,'amount',v_amount,'ledger_group_id',v_group_id));
  exception when others then
    raise warning 'approve_promissory_note notification failed for %: %', p_note_id, sqlerrm;
  end;

  return jsonb_build_object('status','approved','amount',v_amount,'ledger_group_id',v_group_id,
                            'funded_plans', coalesce(array_length(v_ids,1),0),
                            'funded_amount', v_intent_total,
                            'commitment', v_commit);
end;
$$;

-- 6. Retry sweep for pledge notices.
SELECT cron.schedule(
  'promissory-pledge-notice-sweep',
  '*/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/notify-promissory-note-pledge',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('limit', 50)
  );
  $cron$
);