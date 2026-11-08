-- Speed up cron 465: public.auto_create_deposits_from_gmail(336).
--
-- The job runs every 2 minutes. Quiet runs were 9–11s. Measured read-only
-- on 2026-11-06 against live pg_get_functiondef
-- (auto_create_deposits_from_gmail md5 ae92f91819e0553ebf196bdf0f7e9ed8,
--  auto_create_deposits_from_gmail_impl md5 358432fd5176229e9914f8f802a49b71).
-- The outer gmail select and the general_ledger TID probe were already
-- sub-millisecond (idx_general_ledger_deposit_momo_tid_norm is not recreated).
--
-- Three things kept the same 200-row batch expensive:
--   * Rows marked already_credited_cfo or tid never receive a
--     linked_deposit_request_id, so they occupy the LIMIT 200 forever.
--   * The MTN name fallback seq-scanned ~60k profiles and built a token
--     array per row (~672ms each; 10 rows in the current batch).
--   * resolve_user_by_known_phone ORs two profile expressions and seq-scans
--     (~169ms, 22 phones in the current non-terminal batch). The
--     email_routing_history arm of the already-credited check has the same
--     OR shape (~15ms x 69 rows) even though the table is only 819 rows.
--
-- Unchanged: deposit_requests insert, purpose inference, merchant float
-- branch, advisory lock in auto_create_deposits_from_gmail, normalize_momo_tid,
-- the cron schedule, and the 336 argument. SECURITY DEFINER, search_path and
-- the impl's execute grants (postgres owner and service_role) stay.
-- CREATE OR REPLACE keeps those grants; the REVOKE/GRANT below re-states them.
-- The single-row trigger path (welile.gmail_deposit_only_id) stays.
--
-- Indexes are plain CREATE INDEX IF NOT EXISTS because a migration runs inside
-- a transaction, so CONCURRENTLY cannot. Measured sizes, rolled back, not applied:
--   * idx_profiles_gmail_counterparty_token_key  1144 kB, build 4.8s
--     (60,458 named profiles). This is the one that takes a ShareLock on
--     profiles for those seconds. On live, build it with CREATE INDEX
--     CONCURRENTLY first if profile writes must not wait; IF NOT EXISTS
--     below then does nothing.
--   * idx_profiles_mobile_money_last9            40 kB (758 numbers)
--   * idx_email_routing_history_momo_tid         40 kB (801 tids)
-- The two small indexes do not need CONCURRENTLY.

CREATE OR REPLACE FUNCTION public.gmail_counterparty_token_key(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN count(*) >= 2 THEN string_agg(tok, ' ' ORDER BY tok) END
  FROM (
    SELECT DISTINCT m[1] AS tok
    FROM regexp_matches(lower(coalesce(p_name, '')), '[a-z0-9]{3,}', 'g') AS m
  ) s;
$function$;

COMMENT ON FUNCTION public.gmail_counterparty_token_key(text) IS
  'Sorted distinct [a-z0-9] tokens of length >= 3, or null when fewer than 2. Used by the Gmail deposit name fallback. Equal keys are the old token-array match.';

-- Expression indexes run as the role that writes the row. person_name_key had
-- to be granted the same way or profile updates failed. This helper only
-- rewrites the text it is given.
REVOKE ALL ON FUNCTION public.gmail_counterparty_token_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gmail_counterparty_token_key(text) TO anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_profiles_gmail_counterparty_token_key
  ON public.profiles (public.gmail_counterparty_token_key(full_name))
  WHERE full_name IS NOT NULL
    AND full_name NOT ILIKE '[DELETED]%'
    AND public.gmail_counterparty_token_key(full_name) IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_mobile_money_last9
  ON public.profiles ((right(regexp_replace(coalesce(mobile_money_number, ''), '[^0-9]', '', 'g'), 9)))
  WHERE mobile_money_number IS NOT NULL
    AND btrim(mobile_money_number) <> '';

CREATE INDEX IF NOT EXISTS idx_email_routing_history_momo_tid
  ON public.email_routing_history (public.normalize_momo_tid(transaction_id))
  WHERE transaction_id IS NOT NULL
    AND public.normalize_momo_tid(transaction_id) IS NOT NULL;

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
  v_only_gmail_id uuid;
  v_desk_agent  uuid;
  v_name_key    text;
begin
  -- Set by auto_create_deposit_from_gmail_row. Null on the cron path.
  v_only_gmail_id := nullif(current_setting('welile.gmail_deposit_only_id', true), '')::uuid;
  for v_tx in
    select g.id, g.amount, g.transaction_id, g.counterparty, g.counterparty_name,
           g.channel, g.internal_date,
           g.subject, g.snippet, g.raw_body, g.from_email
      from gmail_transactions g
     where g.linked_deposit_request_id is null
       and g.auto_matched_at is null
       and coalesce(g.auto_match_method, '') not in ('already_credited_cfo', 'tid')
       and g.parsed = true
       and g.direction in ('in','credit')
       and g.amount is not null
       and g.amount > 0
       and g.transaction_id is not null
       and length(trim(g.transaction_id)) > 0
       and (g.internal_date is null
            or g.internal_date >= (now() - (p_window_hours || ' hours')::interval))
       and (v_only_gmail_id is null or g.id = v_only_gmail_id)
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
    -- EXISTS (a OR b) is EXISTS a OR EXISTS b. Split so each arm is an index
    -- lookup. The truth value is unchanged.
    if exists (
         select 1 from public.email_routing_history erh
          where erh.gmail_transaction_id = v_tx.id
       )
       or (v_norm_tid is not null and exists (
         select 1 from public.email_routing_history erh
          where erh.transaction_id is not null
            and public.normalize_momo_tid(erh.transaction_id) is not null
            and public.normalize_momo_tid(erh.transaction_id) = v_norm_tid
       ))
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
        -- Same distinct-id rule as resolve_user_by_known_phone: one profile
        -- wins, zero or several stay null. Each arm matches an index.
        if length(v_phone_9) = 9 then
          with hits as (
            select p.id
              from public.profiles p
             where right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 9) = v_phone_9
            union
            select p.id
              from public.profiles p
             where p.mobile_money_number is not null
               and btrim(p.mobile_money_number) <> ''
               and right(regexp_replace(coalesce(p.mobile_money_number, ''), '[^0-9]', '', 'g'), 9) = v_phone_9
            union
            select d.user_id
              from public.user_deposit_numbers d
             where d.phone_last9 = v_phone_9
          )
          select case when count(*) = 1 then (array_agg(id))[1] end
            into v_user_id
            from hits;
        end if;
      end if;
    end if;

    -- A number finance registered to a merchant desk always belongs to that desk, even if it is also on another profile.
    v_desk_agent := null;
    select m.agent_id into v_desk_agent
      from public.merchant_desk_phone_numbers m
     where m.phone9 in (right(regexp_replace(coalesce(v_tx.counterparty, ''), '[^0-9]', '', 'g'), 9),
                        right(regexp_replace(coalesce(v_phone_match, ''), '[^0-9]', '', 'g'), 9))
     limit 1;
    if v_desk_agent is not null then v_user_id := v_desk_agent; end if;

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
        -- Same token set as the old array equality: distinct [a-z0-9]{3,}
        -- tokens, sorted. The key is null below 2 tokens, so a one-word
        -- name still matches nobody. One profile wins; zero or several stay null.
        v_name_key := public.gmail_counterparty_token_key(v_tx.counterparty_name);
        if v_name_key is not null then
          select case when count(*) = 1 then (array_agg(p.id))[1] end
            into v_user_id
            from public.profiles p
           where public.gmail_counterparty_token_key(p.full_name) = v_name_key
             and p.full_name is not null
             and p.full_name not ilike '[DELETED]%'
             and public.gmail_counterparty_token_key(p.full_name) is not null;
        end if;
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


REVOKE ALL ON FUNCTION public.auto_create_deposits_from_gmail_impl(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_create_deposits_from_gmail_impl(integer) TO service_role;
