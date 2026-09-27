-- Merchant desk money sent back to the company is a float RETURN, not a deposit.
--
-- PROBLEM
-- -------
-- auto_create_deposits_from_gmail_impl resolves the sender of every inbound
-- MTN/Airtel receipt to a profile and, for any user holding the `agent` role,
-- creates an `operational_float` deposit ("float-by-default", 2026-07-28).
-- gmail-poll-transactions then approves it, crediting the sender's float.
--
-- For an active merchant desk (cashout_agents.is_active) the money arriving on
-- a company line from the desk's own phone is the desk RETURNING company float.
-- Crediting it as a deposit raises the desk's float by the amount returned, so
-- the books show the desk holding money it has just handed back.
--
-- 2026-09-25: TID157335971789 (UGX 5,000,000 from 741003567, Namulindwa
-- Immeculate) and TID157334845929 (UGX 4,000,000 from 743049289, Catherine
-- Nabaggala) were both credited this way. The same pattern recurred on 3, 11,
-- 14, 15, 16, 17 and 21 September and was cleared by hand each time.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Adds alert_type 'merchant_float_return' to deposit_match_alerts.
-- 2. Re-creates auto_create_deposits_from_gmail_impl from the live production
--    definition with ONE change: when the resolved sender is an active merchant
--    desk (is_merchant_agent), no deposit is created. The receipt stays
--    unlinked and a 'merchant_float_return' alert is raised so Financial Ops
--    records the return against the desk with an evidenced write-down.
--
-- The matching gate for the edge-function path lives in
-- supabase/functions/gmail-poll-transactions (_tryAutoCreditOperationalFloat).
--
-- OUT OF SCOPE
-- ------------
-- No ledger row is written or changed. The two 2026-09-25 credits are corrected
-- separately by Financial Ops through finops_post_merchant_evidenced_writedown.
-- A desk that types its own TID into a deposit request is unaffected: that path
-- is an explicit, user-initiated deposit.

ALTER TABLE public.deposit_match_alerts
  DROP CONSTRAINT IF EXISTS deposit_match_alerts_alert_type_check;
ALTER TABLE public.deposit_match_alerts
  ADD CONSTRAINT deposit_match_alerts_alert_type_check
  CHECK (alert_type = ANY (ARRAY[
    'deposit_unmatched'::text,
    'email_receipt_unmatched'::text,
    'gmail_auth_failure'::text,
    'merchant_float_uncredited'::text,
    'merchant_float_return'::text
  ]));

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
    -- phone is company float coming back, not a deposit. Do not create one;
    -- surface it for Financial Ops to record against the desk.
    if public.is_merchant_agent(v_user_id) then
      insert into deposit_match_alerts (
        alert_type, subject_id, subject_label, user_id, amount,
        transaction_reference, severity, details, resolved_at, updated_at
      ) values (
        'merchant_float_return', v_tx.id,
        'Merchant desk sent money to the company - record as a float return',
        v_user_id, v_tx.amount, v_tx.transaction_id, 'high',
        jsonb_build_object(
          'reason', 'merchant_desk_inbound_not_a_deposit',
          'source', 'auto_create_deposits_from_gmail',
          'counterparty', v_tx.counterparty,
          'observed_at', now()
        ),
        null, now()
      )
      on conflict (alert_type, subject_id) do update
        set updated_at = excluded.updated_at;
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
