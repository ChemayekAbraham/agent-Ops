-- Instant float auto-credit fixes (2026-10-26)
-- 0) Widen gmail_transactions.auto_match_method check for the new/edge-function labels.
-- 1) resolve_learned_payer_route: key-based lookup over learned_payer_routes for the edge function.
-- 2) auto_create_deposits_from_gmail_impl: link already-known TIDs, wider phone fallback, float-by-default purpose.
-- 3) One-time backfill linking recent unlinked receipts to already-approved deposits.

-- ── 0) Match-method labels ──────────────────────────────────────────
ALTER TABLE public.gmail_transactions DROP CONSTRAINT gmail_transactions_auto_match_method_check;
ALTER TABLE public.gmail_transactions ADD CONSTRAINT gmail_transactions_auto_match_method_check
  CHECK (auto_match_method = ANY (ARRAY[
    'tid'::text, 'amount'::text, 'amount_strong'::text,
    'already_approved_tid'::text, 'late_email_tid_match'::text,
    'gmail_phone+tid+amount'::text, 'trigger_linked_instant_approve'::text
  ]));

-- ── 1) Key-based learned-route resolver ─────────────────────────────
-- Mirrors the guardrails of learned_payer_target (settings switch, shared
-- numbers never auto-route) but answers from a plain phone/name key so the
-- gmail-poll edge function can use it before a gmail row exists.
CREATE OR REPLACE FUNCTION public.resolve_learned_payer_route(p_key_type text, p_payer_key text)
RETURNS TABLE(target_user_id uuid, route text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  s record;
  n integer;
  r record;
BEGIN
  IF p_key_type NOT IN ('phone', 'name') OR p_payer_key IS NULL OR length(trim(p_payer_key)) = 0 THEN
    RETURN;
  END IF;
  SELECT * INTO s FROM public.learned_payer_route_settings WHERE id;
  IF NOT FOUND OR NOT s.enabled THEN RETURN; END IF;
  IF p_key_type = 'name' AND NOT s.name_keys_enabled THEN RETURN; END IF;

  SELECT count(DISTINCT l.target_user_id) INTO n
    FROM public.learned_payer_routes l
   WHERE l.key_type = p_key_type AND l.payer_key = p_payer_key AND NOT l.disabled;
  IF n <> 1 THEN RETURN; END IF;   -- 0 = unknown payer; 2+ = shared shop/agent number, never auto-route

  SELECT l.target_user_id, l.route INTO r
    FROM public.learned_payer_routes l
   WHERE l.key_type = p_key_type AND l.payer_key = p_payer_key AND NOT l.disabled
   LIMIT 1;
  RETURN QUERY SELECT r.target_user_id, r.route;
END;
$function$;
REVOKE ALL ON FUNCTION public.resolve_learned_payer_route(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_learned_payer_route(text, text) TO service_role;

-- ── 2) Auto-deposit sweep: link known TIDs, wider phone match, float-by-default ──
CREATE OR REPLACE FUNCTION public.auto_create_deposits_from_gmail_impl(p_window_hours integer DEFAULT 24)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_tx record;
  v_phone_match text;
  v_phone_norm  text;
  v_phone_9     text;
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
  v_existing_id uuid;
  v_l_target    uuid;        -- learned
  v_l_route     text;        -- learned
  v_l_ktype     text;        -- learned
  v_l_key       text;        -- learned
  v_learned     boolean;     -- learned
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
    -- (a) TID already known: link the receipt to the existing deposit
    -- (approved or not) instead of leaving a false "Unmatched" row.
    select d.id into v_existing_id
      from deposit_requests d
     where d.transaction_id is not null
       and lower(trim(d.transaction_id)) = lower(trim(v_tx.transaction_id))
     limit 1;
    if v_existing_id is not null then
      update gmail_transactions
         set linked_deposit_request_id = v_existing_id,
             auto_match_method = coalesce(auto_match_method, 'already_approved_tid')
       where id = v_tx.id
         and linked_deposit_request_id is null;
      continue;
    end if;

    v_user_id := null;        -- learned
    v_learned := false;       -- learned
    v_l_target := null; v_l_route := null; v_l_ktype := null; v_l_key := null;   -- learned

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

    if v_phone_match is not null then          -- learned: was "if null then continue"
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

      -- (b) Wider phone fallback: mobile-money numbers and numbers learned
      -- from earlier positive identifications (unique match only).
      if v_user_id is null then
        v_phone_9 := right(regexp_replace(v_phone_match, '[^0-9]', '', 'g'), 9);
        select h.user_id into v_user_id
          from public.resolve_user_by_known_phone(v_phone_9) h
         where h.match_count = 1
         limit 1;
      end if;
    end if;

    -- learned: no profile owns the payer's number (or the SMS shows none): ask what staff taught the system.
    if v_user_id is null then
      select t.target_user_id, t.route, t.key_type, t.payer_key into v_l_target, v_l_route, v_l_ktype, v_l_key from public.learned_payer_target(v_tx.id) t;
      if v_l_target is null then continue; end if;
      v_user_id := v_l_target;
      v_learned := true;
    end if;

    -- MERCHANT DESK RETURN (2026-09-26): money from an active merchant desk's
    -- phone is company float coming back, not a deposit. Record the return
    -- against the desk automatically; anything it cannot post is alerted.
    if public.is_merchant_agent(v_user_id) then
      if v_learned then continue; end if;      -- learned: never auto-route to a merchant desk
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

    if v_learned then
      -- learned: an agent's personal deposit needs the agent's own confirmation, so it stays for staff.
      if v_l_route = 'personal_deposit' and v_is_agent then continue; end if;
      v_inferred_purpose := v_l_route::deposit_purpose;
      v_inference_reason := 'learned_payer_route';
    elsif v_is_agent then
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

    -- (c) FLOAT-BY-DEFAULT (2026-10-26): a matched payer with no other signal
    -- still defaults to Operational Float, never the generic 'other' bucket.
    if v_inferred_purpose is null then
      v_inferred_purpose := 'operational_float'::deposit_purpose;
      v_inference_reason := 'float_by_default';
    end if;

    begin
      insert into deposit_requests (
        user_id, amount, transaction_id, status, provider,
        deposit_purpose, purpose_audit,
        notes, created_at
      ) values (
        v_user_id, v_tx.amount, v_tx.transaction_id, 'pending', v_provider,
        v_inferred_purpose,
        jsonb_build_object(
          'inferred_at', now(),
          'inferred_by', 'auto_create_deposits_from_gmail',
          'gmail_transaction_id', v_tx.id,
          'is_agent', v_is_agent,
          'inferred_purpose', v_inferred_purpose,
          'inference_reason', coalesce(v_inference_reason, 'no_match'),
          'inference_keyword', v_inference_keyword,
          'requires_confirmation', false,
          'routing_hint', case when v_inferred_purpose = 'operational_float' then 'float' else null end,
          'learned_payer_key_type', v_l_ktype,      -- learned
          'learned_payer_key', v_l_key           -- learned
        ),
        case
          when v_learned
            then '[auto] Auto-routed from Gmail receipt ' || v_tx.id::text
                 || ' — this payer was routed to this wallet by staff before (' || v_l_ktype || ' match).'
          when v_inference_reason = 'agent_float_by_default'
            then '[auto] Auto-created from Gmail receipt ' || v_tx.id::text
                 || ' — agent user, float-by-default routing applied.'
          when v_inference_reason = 'float_by_default'
            then '[auto] Auto-created from Gmail receipt ' || v_tx.id::text
                 || ' — float-by-default routing applied.'
          when v_inferred_purpose = 'operational_float'
            then '[auto] Auto-created from Gmail receipt ' || v_tx.id::text
                 || ' — pre-tagged as operational_float (matched keyword: '
                 || coalesce(v_inference_keyword, 'float') || '). Awaiting confirmation.'
          else '[auto] Auto-created from Gmail receipt ' || v_tx.id::text
               || ' — awaiting purpose confirmation'
        end,
        now()
      ) returning id into v_new_id;
    exception when others then
      -- learned: one auto-route that cannot be created must not stop the sweep. Every other path fails as it always did.
      if v_learned then
        raise warning 'learned payer auto-route skipped for %: %', v_tx.id, sqlerrm;
        continue;
      end if;
      raise;
    end;

    update gmail_transactions
       set linked_deposit_request_id = v_new_id,
           auto_matched_at = now(),
           auto_match_method = 'tid'
     where id = v_tx.id
       and linked_deposit_request_id is null;

    if v_learned then
      insert into learned_payer_auto_routes (gmail_transaction_id, deposit_request_id, transaction_id, key_type, payer_key, target_user_id, route, amount)
      values (v_tx.id, v_new_id, v_tx.transaction_id, v_l_ktype, v_l_key, v_user_id, v_l_route, v_tx.amount)
      on conflict (gmail_transaction_id) do nothing;
    end if;

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$function$;

-- ── 3) One-time backfill: link recent unlinked receipts to already-approved deposits ──
UPDATE public.gmail_transactions g
   SET linked_deposit_request_id = sub.id,
       auto_match_method = coalesce(g.auto_match_method, 'already_approved_tid')
  FROM (
    SELECT DISTINCT ON (lower(trim(d.transaction_id))) d.id, lower(trim(d.transaction_id)) AS tid_key
      FROM public.deposit_requests d
     WHERE d.status = 'approved'
       AND d.transaction_id IS NOT NULL
       AND length(trim(d.transaction_id)) > 0
     ORDER BY lower(trim(d.transaction_id)), d.created_at DESC
  ) sub
 WHERE g.linked_deposit_request_id IS NULL
   AND g.direction IN ('in', 'credit')
   AND g.created_at > now() - interval '48 hours'
   AND g.transaction_id IS NOT NULL
   AND lower(trim(g.transaction_id)) = sub.tid_key;