-- Merchant desk float returns are recorded AUTOMATICALLY.
--
-- CONTEXT
-- -------
-- 20260926090000 stopped money sent from an active merchant desk's phone to a
-- company line from being auto-credited as a deposit, and raised a
-- 'merchant_float_return' alert for Financial Ops to post the write-down by
-- hand. The instruction from the CEO (2026-09-26) is that the system itself
-- must detect the return and adjust the desk's books: "If they send back the
-- system should automatically detect that and do reactive changes."
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. merchant_float_returns: one row per provider receipt (unique gmail row and
--    unique TID) that was recorded as a desk returning float. It is the
--    evidence record for the ledger legs; the actor is the system and the
--    evidence is the company's own mobile-money receipt.
-- 2. auto_record_merchant_float_return(gmail_transaction_id, agent_id,
--    match_method): service_role only. Reduces the desk's float by the amount
--    returned, capped at the float on the books (float never goes negative).
--    Any excess, and any receipt that cannot be posted, is raised as a
--    'merchant_float_return' alert for Financial Ops instead.
-- 3. auto_create_deposits_from_gmail_impl calls it in place of raising the
--    alert. The edge function gmail-poll-transactions does the same.
--
-- LEDGER SHAPE
-- ------------
-- Identical to post_merchant_evidenced_writedown, the route Financial Ops used
-- for the same correction on 2026-09-25, so manual and automatic returns are
-- accounted the same way:
--   wallet   / float / cash_out  merchant_float_correction_writedown  (desk)
--   platform /       / cash_in   merchant_float_correction_writedown
-- The category is already allowlisted and routed to the float bucket by
-- wallet_route_for_category. Its platform leg has no ledger_account_map row
-- (resolves to A9); that is pre-existing for the manual route and is left for
-- a separate mapping decision, not changed here.
--
-- Rule 2 (enforce_no_merchant_agent_auto_debit) blocks the old OUTBOUND
-- "Auto-debit (phone match)" against merchant floats. This is a different
-- event: money that actually arrived on a company line from the desk's own
-- phone. The legs do not use that description and are not affected by it.
--
-- DOUBLE-CREDIT GUARD
-- -------------------
-- The TID is written to ledger_reconciled_tids, so a later deposit request
-- carrying the same TID is refused by enforce_tid_deposit_uniqueness instead
-- of re-crediting the desk.

-- ── 1. Evidence table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.merchant_float_returns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_transaction_id uuid NOT NULL UNIQUE,
  transaction_id       text NOT NULL UNIQUE,
  desk_id              uuid NOT NULL REFERENCES public.cashout_agents(id),
  agent_id             uuid NOT NULL,
  amount_received      numeric NOT NULL CHECK (amount_received > 0),
  amount_written_down  numeric NOT NULL DEFAULT 0 CHECK (amount_written_down >= 0),
  excess_amount        numeric NOT NULL DEFAULT 0 CHECK (excess_amount >= 0),
  float_before         numeric,
  float_after          numeric,
  match_method         text,
  status               text NOT NULL CHECK (status IN ('posted','partial','no_float')),
  ledger_group_id      uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merchant_float_returns_agent_idx
  ON public.merchant_float_returns (agent_id, created_at DESC);

ALTER TABLE public.merchant_float_returns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS merchant_float_returns_finance_read ON public.merchant_float_returns;
CREATE POLICY merchant_float_returns_finance_read ON public.merchant_float_returns
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'super_admin')
    OR agent_id = auth.uid()
  );

REVOKE INSERT, UPDATE, DELETE ON public.merchant_float_returns FROM anon, authenticated;

-- ── 2. The automatic write-down ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_record_merchant_float_return(
  p_gmail_transaction_id uuid,
  p_agent_id uuid,
  p_match_method text DEFAULT 'phone'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tx          record;
  v_existing    record;
  v_desk_id     uuid;
  v_tid_norm    text;
  v_float       numeric;
  v_post        numeric;
  v_excess      numeric;
  v_status      text;
  v_return_id   uuid;
  v_group_id    uuid;
  v_float_after numeric;
  v_sync        jsonb;
  v_reason      text;
  v_alert_label constant text := 'Merchant desk sent money to the company - check the float return';
BEGIN
  SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.direction,
         g.parsed, g.linked_deposit_request_id
    INTO v_tx
    FROM gmail_transactions g
   WHERE g.id = p_gmail_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'gmail_row_not_found');
  END IF;

  IF v_tx.parsed IS NOT TRUE
     OR v_tx.direction NOT IN ('in','credit')
     OR coalesce(v_tx.amount, 0) <= 0
     OR nullif(btrim(coalesce(v_tx.transaction_id, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'not_an_inbound_receipt');
  END IF;

  SELECT id INTO v_desk_id
    FROM cashout_agents
   WHERE agent_id = p_agent_id AND is_active IS TRUE
   ORDER BY created_at
   LIMIT 1;
  IF v_desk_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'not_a_merchant_desk');
  END IF;

  -- Serialise per desk so two receipts cannot both read the same float.
  PERFORM pg_advisory_xact_lock(hashtext('merchant_float_return:' || p_agent_id::text));

  -- Idempotent: the same receipt is only ever recorded once.
  SELECT * INTO v_existing
    FROM merchant_float_returns
   WHERE gmail_transaction_id = v_tx.id
      OR lower(btrim(transaction_id)) = lower(btrim(v_tx.transaction_id))
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'already_recorded',
                              'return_id', v_existing.id, 'status', v_existing.status);
  END IF;

  v_tid_norm := coalesce(public.extract_tid_normalized(v_tx.transaction_id),
                         nullif(regexp_replace(v_tx.transaction_id, '[^0-9]', '', 'g'), ''),
                         lower(btrim(v_tx.transaction_id)));

  v_reason := NULL;
  IF v_tx.linked_deposit_request_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM deposit_requests d
                 WHERE d.transaction_id IS NOT NULL
                   AND lower(btrim(d.transaction_id)) = lower(btrim(v_tx.transaction_id))) THEN
    -- The desk (or a person) already filed this TID as a deposit. That is an
    -- explicit decision; do not second-guess it automatically.
    v_reason := 'tid_already_filed_as_deposit';
  ELSIF EXISTS (SELECT 1 FROM ledger_reconciled_tids WHERE tid_normalized = v_tid_norm) THEN
    v_reason := 'tid_already_credited';
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO deposit_match_alerts (
      alert_type, subject_id, subject_label, user_id, amount,
      transaction_reference, severity, details, resolved_at, updated_at
    ) VALUES (
      'merchant_float_return', v_tx.id, v_alert_label, p_agent_id, v_tx.amount,
      v_tx.transaction_id, 'high',
      jsonb_build_object('reason', v_reason, 'desk_id', v_desk_id,
                         'counterparty', v_tx.counterparty, 'observed_at', now()),
      NULL, now()
    )
    ON CONFLICT (alert_type, subject_id) DO UPDATE SET updated_at = excluded.updated_at;
    RETURN jsonb_build_object('ok', false, 'outcome', v_reason);
  END IF;

  SELECT coalesce(float_balance, 0) INTO v_float FROM wallets WHERE user_id = p_agent_id;
  v_float  := greatest(coalesce(v_float, 0), 0);
  v_post   := least(round(v_tx.amount), round(v_float));
  v_excess := round(v_tx.amount) - v_post;
  v_status := CASE WHEN v_post <= 0 THEN 'no_float'
                   WHEN v_excess > 0 THEN 'partial'
                   ELSE 'posted' END;

  INSERT INTO merchant_float_returns (
    gmail_transaction_id, transaction_id, desk_id, agent_id, amount_received,
    amount_written_down, excess_amount, float_before, match_method, status
  ) VALUES (
    v_tx.id, btrim(v_tx.transaction_id), v_desk_id, p_agent_id, v_tx.amount,
    v_post, v_excess, v_float, p_match_method, v_status
  ) RETURNING id INTO v_return_id;

  IF v_post > 0 THEN
    v_group_id := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', p_agent_id,
          'amount', v_post,
          'direction', 'cash_out',
          'category', 'merchant_float_correction_writedown',
          'ledger_scope', 'wallet',
          'wallet_bucket', 'float',
          'recipient_type', 'operational_wallet',
          'classification', 'admin_correction',
          'solvency_bypass_reason', 'other_with_note',
          'source_table', 'merchant_float_returns',
          'source_id', v_return_id,
          'reference_id', btrim(v_tx.transaction_id),
          'description', format(
            'Merchant float returned to company (automatic). UGX %s received from the desk phone on a company line, TID %s. Float reduced by UGX %s.',
            v_tx.amount, btrim(v_tx.transaction_id), v_post),
          'currency', 'UGX',
          'transaction_date', now()
        ),
        jsonb_build_object(
          'amount', v_post,
          'direction', 'cash_in',
          'category', 'merchant_float_correction_writedown',
          'ledger_scope', 'platform',
          'classification', 'admin_correction',
          'source_table', 'merchant_float_returns',
          'source_id', v_return_id,
          'reference_id', btrim(v_tx.transaction_id),
          'description', 'Platform: merchant float returned by desk (automatic), TID ' || btrim(v_tx.transaction_id),
          'currency', 'UGX',
          'transaction_date', now()
        )
      ),
      idempotency_key := 'merchant_float_return:' || v_tx.id::text,
      skip_balance_check := true
    );

    v_sync := public.sync_merchant_desk_float_cache(v_desk_id, 'automatic float return ' || v_return_id::text);
  END IF;

  SELECT coalesce(float_balance, 0) INTO v_float_after FROM wallets WHERE user_id = p_agent_id;

  UPDATE merchant_float_returns
     SET ledger_group_id = v_group_id,
         float_after     = v_float_after
   WHERE id = v_return_id;

  -- Consume the TID so it can never also be credited as a deposit.
  INSERT INTO ledger_reconciled_tids (tid_normalized, source, source_id, amount, user_id, notes)
  VALUES (v_tid_norm, 'merchant_float_return', v_return_id, v_tx.amount, p_agent_id,
          'Merchant desk float return, recorded automatically from the provider receipt')
  ON CONFLICT (tid_normalized) DO NOTHING;

  IF v_status <> 'posted' THEN
    INSERT INTO deposit_match_alerts (
      alert_type, subject_id, subject_label, user_id, amount,
      transaction_reference, severity, details, resolved_at, updated_at
    ) VALUES (
      'merchant_float_return', v_tx.id, v_alert_label, p_agent_id, v_tx.amount,
      v_tx.transaction_id, 'high',
      jsonb_build_object(
        'reason', CASE WHEN v_status = 'no_float' THEN 'desk_had_no_float_on_books'
                       ELSE 'return_exceeds_float_on_books' END,
        'desk_id', v_desk_id, 'return_id', v_return_id,
        'float_before', v_float, 'written_down', v_post, 'excess', v_excess,
        'counterparty', v_tx.counterparty, 'observed_at', now()),
      NULL, now()
    )
    ON CONFLICT (alert_type, subject_id) DO UPDATE SET updated_at = excluded.updated_at;
  END IF;

  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (NULL, 'merchant_float_return_auto_recorded', 'merchant_float_returns', v_return_id,
          jsonb_build_object('desk_id', v_desk_id, 'agent_id', p_agent_id,
                             'gmail_transaction_id', v_tx.id, 'tid', v_tx.transaction_id,
                             'amount_received', v_tx.amount, 'written_down', v_post,
                             'excess', v_excess, 'float_before', v_float,
                             'float_after', v_float_after, 'ledger_group_id', v_group_id,
                             'match_method', p_match_method, 'cache_sync', v_sync));

  RETURN jsonb_build_object(
    'ok', true, 'outcome', v_status, 'return_id', v_return_id,
    'ledger_group_id', v_group_id, 'amount_received', v_tx.amount,
    'written_down', v_post, 'excess', v_excess,
    'float_before', v_float, 'float_after', v_float_after
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_record_merchant_float_return(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_record_merchant_float_return(uuid, uuid, text) TO service_role;

-- ── 3. Database auto-create path: record the return instead of alerting ──
-- Re-created from the live definition (verified 2026-09-26, identical to the
-- base 20260926090000 was built from). Only the merchant-desk block changes.
CREATE OR REPLACE FUNCTION public.auto_create_deposits_from_gmail_impl(p_window_hours integer DEFAULT 24)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tx record;
  v_phone_match text;
  v_phone_norm  text;
  v_bare_count  integer;
  v_user_id     uuid;
  v_provider    text;
  v_haystack    text;
  v_haystack_l  text;
  v_is_agent    boolean;
  v_inferred_purpose deposit_purpose;
  v_inference_reason text;
  v_inference_keyword text;
  v_created     integer := 0;
  v_new_id      uuid;
begin
  for v_tx in
    select g.id, g.amount, g.transaction_id, g.counterparty, g.internal_date,
           g.subject, g.snippet, g.raw_body, g.from_email
      from gmail_transactions g
     where g.linked_deposit_request_id is null
       and g.parsed = true
       and g.direction in ('in','credit')
       and g.amount is not null
       and g.amount > 0
       and g.transaction_id is not null
       and length(trim(g.transaction_id)) > 0
       and (g.internal_date is null
            or g.internal_date >= (now() - (p_window_hours || ' hours')::interval))
     order by g.internal_date desc nulls last
     limit 200
  loop
    if exists (
      select 1 from deposit_requests d
       where d.transaction_id is not null
         and lower(trim(d.transaction_id)) = lower(trim(v_tx.transaction_id))
    ) then
      continue;
    end if;

    v_haystack := concat_ws(' ',
      coalesce(v_tx.snippet, ''),
      coalesce(v_tx.subject, ''),
      coalesce(v_tx.counterparty, ''),
      coalesce(v_tx.raw_body, '')
    );

    v_phone_match := substring(v_haystack from '256[0-9]{9}');
    if v_phone_match is null then
      v_phone_match := substring(v_haystack from '0[7][0-9]{8}');
    end if;
    -- Bare 9-digit fallback (Airtel writes "from 704825473"). Only accepted
    -- when EXACTLY ONE distinct bare number appears in the whole email, so a
    -- digit run inside a reference string can never mis-credit someone.
    if v_phone_match is null then
      select count(distinct m[1]) into v_bare_count
        from regexp_matches(v_haystack, '(?<![0-9])(7[0-9]{8})(?![0-9])', 'g') as m;
      if coalesce(v_bare_count, 0) = 1 then
        v_phone_match := '0' || substring(v_haystack from '(?<![0-9])(7[0-9]{8})(?![0-9])');
      end if;
    end if;
    if v_phone_match is null then continue; end if;

    if v_phone_match like '256%' then
      v_phone_norm := '0' || substring(v_phone_match from 4);
    else
      v_phone_norm := v_phone_match;
    end if;

    select p.id into v_user_id
      from profiles p
     where regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') in (
             regexp_replace(v_phone_match, '[^0-9]', '', 'g'),
             regexp_replace(v_phone_norm,  '[^0-9]', '', 'g'),
             '256' || substring(v_phone_norm from 2)
           )
     limit 1;
    if v_user_id is null then continue; end if;

    -- MERCHANT DESK RETURN (2026-09-26): money from an active merchant desk's
    -- phone is company float coming back, not a deposit. Record the return
    -- against the desk automatically; anything it cannot post is alerted.
    if public.is_merchant_agent(v_user_id) then
      begin
        perform public.auto_record_merchant_float_return(v_tx.id, v_user_id, 'phone');
      exception when others then
        -- One failed posting must not abort the rest of the batch. The
        -- subtransaction is rolled back; Financial Ops gets the receipt.
        insert into deposit_match_alerts (
          alert_type, subject_id, subject_label, user_id, amount,
          transaction_reference, severity, details, resolved_at, updated_at
        ) values (
          'merchant_float_return', v_tx.id,
          'Merchant desk sent money to the company - check the float return',
          v_user_id, v_tx.amount, v_tx.transaction_id, 'high',
          jsonb_build_object('reason', 'auto_record_failed', 'error', sqlerrm,
                             'source', 'auto_create_deposits_from_gmail',
                             'counterparty', v_tx.counterparty, 'observed_at', now()),
          null, now()
        )
        on conflict (alert_type, subject_id) do update
          set updated_at = excluded.updated_at, details = excluded.details;
      end;
      continue;
    end if;

    if exists (
      select 1 from deposit_requests d
       where d.user_id = v_user_id
         and d.status = 'pending'
         and abs(d.amount - v_tx.amount) < 0.5
         and d.created_at >= (now() - (p_window_hours || ' hours')::interval)
    ) then continue; end if;

    v_provider := case
      when v_haystack ilike '%momo%' or v_haystack ilike '%mtn%' then 'mtn'
      when v_haystack ilike '%airtel%' then 'airtel'
      else 'mtn'
    end;

    v_is_agent := exists (
      select 1 from user_roles ur
       where ur.user_id = v_user_id
         and ur.role = 'agent'
         and coalesce(ur.enabled, true) = true
    );

    v_haystack_l := lower(v_haystack);
    v_inferred_purpose := null;
    v_inference_reason := null;
    v_inference_keyword := null;

    if v_is_agent then
      -- FLOAT-BY-DEFAULT FOR AGENTS (2026-07-28)
      if v_haystack_l ~ '\m(operational\s+float|op\.?\s*float|agent\s+float|company\s+float|welile\s+float|float\s+top\s*-?\s*up|top\s*-?\s*up\s+float|fund\s+float|float\s+funding|float\s+deposit|reload\s+float|recharge\s+float)\M' then
        v_inferred_purpose := 'operational_float';
        v_inference_reason := 'sms_keyword_match';
        v_inference_keyword := substring(v_haystack_l from '\m(operational\s+float|op\.?\s*float|agent\s+float|company\s+float|welile\s+float|float\s+top\s*-?\s*up|top\s*-?\s*up\s+float|fund\s+float|float\s+funding|float\s+deposit|reload\s+float|recharge\s+float)\M');
      elsif v_haystack_l ~ '\mfloat\M' then
        v_inferred_purpose := 'operational_float';
        v_inference_reason := 'sms_keyword_match';
        v_inference_keyword := 'float';
      else
        v_inferred_purpose := 'operational_float';
        v_inference_reason := 'agent_float_by_default';
        v_inference_keyword := null;
      end if;
    end if;

    insert into deposit_requests (
      user_id, amount, transaction_id, status, provider,
      deposit_purpose, purpose_audit,
      notes, created_at
    ) values (
      v_user_id, v_tx.amount, v_tx.transaction_id, 'pending', v_provider,
      coalesce(v_inferred_purpose, 'other'::deposit_purpose),
      jsonb_build_object(
        'inferred_at', now(),
        'inferred_by', 'auto_create_deposits_from_gmail',
        'gmail_transaction_id', v_tx.id,
        'is_agent', v_is_agent,
        'inferred_purpose', v_inferred_purpose,
        'inference_reason', coalesce(v_inference_reason, 'no_match'),
        'inference_keyword', v_inference_keyword,
        'requires_confirmation', v_inferred_purpose is null,
        'routing_hint', case when v_inferred_purpose = 'operational_float' then 'float' else null end
      ),
      case
        when v_inference_reason = 'agent_float_by_default'
          then '[auto] Auto-created from Gmail receipt ' || v_tx.id::text
               || ' — agent user, float-by-default routing applied.'
        when v_inferred_purpose = 'operational_float'
          then '[auto] Auto-created from Gmail receipt ' || v_tx.id::text
               || ' — pre-tagged as operational_float (matched keyword: '
               || coalesce(v_inference_keyword, 'float') || '). Awaiting confirmation.'
        else '[auto] Auto-created from Gmail receipt ' || v_tx.id::text
             || ' — awaiting purpose confirmation'
      end,
      now()
    ) returning id into v_new_id;

    update gmail_transactions
       set linked_deposit_request_id = v_new_id,
           auto_matched_at = now(),
           auto_match_method = 'tid'
     where id = v_tx.id
       and linked_deposit_request_id is null;

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$function$;
