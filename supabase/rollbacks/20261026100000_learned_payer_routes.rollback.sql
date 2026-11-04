-- Removes "learn from the first manual route": the sweep goes back to phone-match only, the name match goes back to exact word order, and the
-- learned tables and helper functions are dropped. Deposits already auto-routed stay (they are ordinary deposit requests); learned_payer_auto_routes
-- is the list of them if you want to review before dropping.

DROP TRIGGER IF EXISTS trg_learn_payer_route ON public.email_routing_history;

CREATE OR REPLACE FUNCTION public.auto_create_deposits_from_gmail_impl(p_window_hours integer DEFAULT 24)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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

    if public.is_merchant_agent(v_user_id) then
      begin
        perform public.auto_record_merchant_float_return(v_tx.id, v_user_id, 'phone');
      exception when others then
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

-- Name match back to exact word order.
DO $unpatch$
DECLARE v_def text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname = 'auto_match_email_deposits' AND p.pronamespace = 'public'::regnamespace;
  IF position('any order' IN v_def) = 0 THEN RETURN; END IF;
  v_old := $o$OR (c.from_name IS NOT NULL AND lower(c.from_name) LIKE '%' || lower(trim(v_pending.full_name)) || '%')
                OR (SELECT count(*) >= 2 AND bool_and(position(w IN lower(coalesce(c.counterparty, '') || ' ' || coalesce(c.from_name, ''))) > 0)
                      FROM unnest(string_to_array(lower(trim(v_pending.full_name)), ' ')) AS w WHERE length(w) >= 2))$o$;
  v_new := $n$OR (c.from_name IS NOT NULL AND lower(c.from_name) LIKE '%' || lower(trim(v_pending.full_name)) || '%'))$n$;
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'auto_match_email_deposits changed: the name patch could not be undone (nothing was changed)'; END IF;
  v_def := replace(v_def, v_old, v_new);
  v_def := replace(v_def, 'CASE /* any order */ WHEN', 'CASE WHEN');
  EXECUTE v_def;
END
$unpatch$;

DROP FUNCTION IF EXISTS public.get_learned_payer_suggestions();
DROP FUNCTION IF EXISTS public.learned_payer_target(uuid, boolean);
DROP FUNCTION IF EXISTS public.learn_payer_route_from_history();
DROP FUNCTION IF EXISTS public.payer_name_key(text);
DROP FUNCTION IF EXISTS public.payer_phone_key(text);
DROP TABLE IF EXISTS public.learned_payer_routes;
DROP TABLE IF EXISTS public.learned_payer_route_settings;
-- learned_payer_auto_routes is kept on purpose: it is the record of what was auto-routed. Drop it by hand when you have reviewed it:
-- DROP TABLE public.learned_payer_auto_routes;
