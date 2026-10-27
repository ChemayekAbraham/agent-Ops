-- pg_cron calls auto_create_deposits_from_gmail(336) every 2 minutes. The
-- "already credited via CFO" check ILIKEd general_ledger.transaction_group_id.
-- That column is uuid, so ~~* raised 42883 and the sweep aborted before it
-- could create any deposit.
--
-- transaction_group_id is the ledger group uuid. It never contains a MoMo TID.
-- Casting it to text and keeping ILIKE would silence the error and still never
-- match. cfo-direct-credit writes the email transaction id onto
-- general_ledger.sub_category (text). Match that with normalize_momo_tid.
-- reference_id on those rows is a PAY- / MANUAL- reference, not the TID.
-- idempotency_key is empty. email_routing_history stays the first check.
--
-- agent_float_deposit is included because that is the category on most CFO
-- email credits that store the TID in sub_category. wallet_deposit and
-- partner_funding stay. The thin SQL wrapper is unchanged. CREATE OR REPLACE
-- keeps SECURITY DEFINER, search_path, and the existing execute grants
-- (postgres and service_role only).

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
  v_norm_tid    text;        -- already-credited check
begin
  for v_tx in
    select g.id, g.amount, g.transaction_id, g.counterparty, g.counterparty_name,
           g.channel, g.internal_date,
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

    -- (a2) ALREADY CREDITED VIA CFO DIRECT CREDIT (2026-10-26): cfo-direct-credit
    -- records the credit in email_routing_history + general_ledger but never
    -- creates a deposit_requests row, so without this check the sweep re-creates
    -- a duplicate pending deposit for money that already reached a wallet.
    -- The TID is on sub_category, not transaction_group_id (uuid).
    v_norm_tid := public.normalize_momo_tid(v_tx.transaction_id);
    if exists (
         select 1 from public.email_routing_history erh
          where erh.gmail_transaction_id = v_tx.id
             or (v_norm_tid is not null
                 and public.normalize_momo_tid(erh.transaction_id) = v_norm_tid)
       )
       or (v_norm_tid is not null and exists (
         select 1 from public.general_ledger gl
          where gl.category in ('wallet_deposit', 'partner_funding', 'agent_float_deposit')
            and public.normalize_momo_tid(gl.sub_category) = v_norm_tid
       ))
    then
      update gmail_transactions
         set auto_matched_at = coalesce(auto_matched_at, now()),
             auto_match_method = coalesce(auto_match_method, 'already_credited_cfo')
       where id = v_tx.id;
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

    -- (b2) MTN NAME MATCH (2026-10-26): MTN receipts carry the payer's
    -- registered name. Try the learned-name table first, then a unique
    -- non-deleted profile whose lowercase alphanumeric word set equals the
    -- payer's word set (handles reversed order, e.g. "JUDITH KYOMUGISHA"
    -- vs "kyomugisha judith"). Requires 2+ tokens of 3+ chars so a single
    -- short name can never mis-credit anyone.
    if v_user_id is null
       and v_tx.channel = 'mtn_momo'
       and coalesce(v_tx.counterparty_name, '') <> '' then
      select h.user_id into v_user_id
        from public.resolve_user_by_known_name(v_tx.counterparty_name) h
       where h.match_count = 1
       limit 1;

      if v_user_id is null then
        with target as (
          select array_agg(distinct tok order by tok) as toks
            from regexp_matches(lower(v_tx.counterparty_name), '[a-z0-9]{3,}', 'g') as m(tok)
        ),
        cand as (
          select p.id,
                 (select array_agg(distinct tok order by tok)
                    from regexp_matches(lower(p.full_name), '[a-z0-9]{3,}', 'g') as m(tok)) as toks
            from profiles p
           where p.full_name is not null
             and p.full_name not ilike '[DELETED]%'
        ),
        matched as (
          select c.id
            from cand c
            join target t on c.toks = t.toks
           where coalesce(array_length(t.toks, 1), 0) >= 2
        )
        select case when count(*) = 1 then min(id) end
          into v_user_id
          from matched;
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