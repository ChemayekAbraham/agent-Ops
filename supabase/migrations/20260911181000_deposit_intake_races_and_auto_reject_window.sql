-- Deposit intake: three gaps that left deposits stuck `pending` for weeks and
-- let the same payment be recorded twice.
--
-- ── 1. auto_reject_unmatched_deposits never rejected anything ───────────────
-- Its "an email with this amount might still be ours" guard had no upper time
-- bound and ignored whether the email was already linked to another deposit:
-- ANY inbound receipt with the same amount, received at ANY time after the
-- request, protected it. For common amounts (500, 1,000, 50,000) such a
-- receipt always exists, so the cron has returned "0 rows" on every run and 86
-- requests have sat `pending` for 25-55 days (live 2026-09-11) -- mostly
-- 500-UGX tests and made-up TIDs, but the user sees "pending" forever.
--
-- Now the amount guard only counts an UNLINKED receipt within +/- the lookback
-- window of the request. The TID guard also compares digits-only
-- (normalize_momo_tid) so "TID 1532..." / "MP 4212..." spacing and prefixes
-- still protect a request whose receipt did arrive.
--
-- The same job now also clears pending DUPLICATES: a pending row whose TID is
-- already on an approved deposit, or on an older pending row of the same user.
-- Live examples: the UGX 5,000,000 float top-up TID156133611529 and the
-- 180,000 top-up 43433943084 each have an approved row AND a pending twin --
-- approving the twin would have credited the same payment twice (see 2).
CREATE OR REPLACE FUNCTION public.auto_reject_unmatched_deposits(p_age_hours integer DEFAULT 24, p_email_lookback_hours integer DEFAULT 48)
 RETURNS TABLE(deposit_request_id uuid, amount numeric, user_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row RECORD;
  v_reason text;
  v_lookback interval := (p_email_lookback_hours || ' hours')::interval;
BEGIN
  -- Pass 1: duplicates of a TID that is already recorded. No age wait -- the
  -- original row is the one that counts, so there is nothing to wait for.
  FOR v_row IN
    SELECT d.id, d.user_id, d.amount, d.transaction_id, o.id AS original_id, o.status AS original_status
      FROM deposit_requests d
      CROSS JOIN LATERAL (
        SELECT x.id, x.status
          FROM deposit_requests x
         WHERE x.id <> d.id
           AND lower(btrim(x.transaction_id)) = lower(btrim(d.transaction_id))
           AND (
                 (x.status = 'approved'
                  AND (x.user_id = d.user_id
                       OR lower(coalesce(x.provider, '')) = lower(coalesce(d.provider, ''))))
              OR (x.status = 'pending'
                  AND x.user_id = d.user_id
                  AND (x.created_at, x.id) < (d.created_at, d.id))
               )
         ORDER BY (x.status = 'approved') DESC, x.created_at ASC
         LIMIT 1
      ) o
     WHERE d.status = 'pending'
       AND d.transaction_id IS NOT NULL
       AND length(btrim(d.transaction_id)) > 0
     ORDER BY d.created_at ASC
     LIMIT 200
  LOOP
    v_reason := format(
      'Duplicate submission: this Transaction ID is already recorded on deposit %s (%s). Nothing is lost -- that deposit is the one that counts.',
      v_row.original_id, v_row.original_status
    );

    UPDATE deposit_requests
       SET status = 'rejected',
           rejection_reason = v_reason,
           rejected_at = now(),
           updated_at = now()
     WHERE id = v_row.id
       AND status = 'pending';

    INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      NULL, 'auto_reject_deposit', 'deposit_requests', v_row.id::text,
      jsonb_build_object(
        'amount', v_row.amount, 'user_id', v_row.user_id,
        'reason', v_reason, 'duplicate_of', v_row.original_id,
        'triggered_by', 'auto_reject_unmatched_deposits:duplicate'
      )
    );

    INSERT INTO email_match_audit_log (
      gmail_transaction_id, deposit_request_id, action, matcher_type, amount, actor_id, notes
    ) VALUES (
      NULL, v_row.id, 'auto_reject', 'duplicate_tid', v_row.amount, NULL,
      'Auto-rejected -- duplicate of deposit ' || v_row.original_id::text
    );

    deposit_request_id := v_row.id;
    amount := v_row.amount;
    user_id := v_row.user_id;
    RETURN NEXT;
  END LOOP;

  -- Pass 2: no evidence the money ever arrived.
  FOR v_row IN
    SELECT d.id, d.user_id, d.amount, d.transaction_id, d.created_at
      FROM deposit_requests d
     WHERE d.status = 'pending'
       AND d.created_at < (now() - (p_age_hours || ' hours')::interval)
       AND NOT EXISTS (
         SELECT 1 FROM gmail_transactions g
          WHERE g.linked_deposit_request_id = d.id
       )
       -- An unclaimed receipt of the same amount near the request time may
       -- still be this user's -- leave it for the matcher / Finance.
       AND NOT EXISTS (
         SELECT 1 FROM gmail_transactions g
          WHERE g.parsed = true
            AND g.linked_deposit_request_id IS NULL
            AND g.amount IS NOT NULL
            AND abs(g.amount - d.amount) < 0.5
            AND (g.direction IS NULL OR g.direction IN ('in','credit'))
            AND coalesce(g.internal_date, g.created_at)
                  BETWEEN d.created_at - v_lookback AND d.created_at + v_lookback
       )
       -- Exact TID (uses gmail_transactions_tid_lower_idx) ...
       AND NOT EXISTS (
         SELECT 1 FROM gmail_transactions g
          WHERE d.transaction_id IS NOT NULL
            AND g.transaction_id IS NOT NULL
            AND lower(g.transaction_id) = lower(btrim(d.transaction_id))
       )
       -- ... or the same digits under different spacing/prefix, time-bounded
       -- so the regex only runs over receipts near the request.
       AND NOT EXISTS (
         SELECT 1 FROM gmail_transactions g
          WHERE length(coalesce(public.normalize_momo_tid(d.transaction_id), '')) >= 8
            AND g.transaction_id IS NOT NULL
            AND coalesce(g.internal_date, g.created_at)
                  BETWEEN d.created_at - interval '30 days' AND d.created_at + interval '30 days'
            AND public.normalize_momo_tid(g.transaction_id) = public.normalize_momo_tid(d.transaction_id)
       )
     ORDER BY d.created_at ASC
     LIMIT 200
  LOOP
    v_reason := format(
      'No matching mobile-money confirmation email was received within %s hours of your deposit request. If you did pay, contact support with your Transaction ID and we will reopen it.',
      p_age_hours
    );

    UPDATE deposit_requests
       SET status = 'rejected',
           rejection_reason = v_reason,
           rejected_at = now(),
           updated_at = now()
     WHERE id = v_row.id
       AND status = 'pending';

    INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      NULL, 'auto_reject_deposit', 'deposit_requests', v_row.id::text,
      jsonb_build_object(
        'amount', v_row.amount, 'user_id', v_row.user_id,
        'age_hours', p_age_hours, 'email_lookback_hours', p_email_lookback_hours,
        'reason', v_reason, 'triggered_by', 'auto_reject_unmatched_deposits'
      )
    );

    INSERT INTO email_match_audit_log (
      gmail_transaction_id, deposit_request_id, action, matcher_type, amount, actor_id, notes
    ) VALUES (
      NULL, v_row.id, 'auto_reject', 'no_email', v_row.amount, NULL,
      'Auto-rejected — no matching email confirmation found in window'
    );

    deposit_request_id := v_row.id;
    amount := v_row.amount;
    user_id := v_row.user_id;
    RETURN NEXT;
  END LOOP;
END
$function$;


-- ── 2. enforce_unique_deposit_tid: racy, and blind at the approval moment ───
-- a. The duplicate check was a plain SELECT with no lock, so simultaneous
--    inserts all passed: TID "TID 15320895648" was recorded 13 times by one
--    user in 0.67 s on 2026-08-04 (a double-tap / client retry loop). A
--    transaction-scoped advisory lock on the normalized TID now serializes
--    them; the second insert re-reads after the first commits and is refused.
-- b. pending -> approved returned early without looking for duplicates ("status
--    progression must not be blocked"). So a pending twin of an already
--    APPROVED deposit could be approved and credit the same payment twice.
--    Approval now refuses when another row with the same TID is already
--    approved. Other progressions (e.g. pending -> processing) still pass.
CREATE OR REPLACE FUNCTION public.enforce_unique_deposit_tid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_id uuid;
  v_existing_status text;
  v_existing_amount numeric;
  v_existing_created timestamptz;
  v_norm_tid text;
  v_norm_provider text;
  v_old_active boolean;
  v_new_active boolean;
BEGIN
  IF NEW.transaction_id IS NULL OR length(btrim(NEW.transaction_id)) = 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('rejected', 'cancelled', 'failed') THEN
    RETURN NEW;
  END IF;

  v_norm_tid := lower(btrim(NEW.transaction_id));
  v_norm_provider := lower(coalesce(NEW.provider, ''));
  v_new_active := NEW.status NOT IN ('rejected', 'cancelled', 'failed');

  -- Serialize every writer touching this TID for the rest of the transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended('deposit_tid:' || v_norm_tid, 0));

  IF TG_OP = 'UPDATE' THEN
    v_old_active := OLD.status NOT IN ('rejected', 'cancelled', 'failed');

    -- Status progression within the active lifecycle (for example pending →
    -- processing) must not be blocked by a historical/concurrent duplicate.
    -- No TID is being introduced or reactivated in this path -- EXCEPT the
    -- move to approved, which is when money is credited.
    IF lower(btrim(coalesce(OLD.transaction_id, ''))) = v_norm_tid
       AND lower(coalesce(OLD.provider, '')) = v_norm_provider
       AND v_old_active
       AND v_new_active THEN

      IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
        SELECT id, amount, created_at
          INTO v_existing_id, v_existing_amount, v_existing_created
        FROM public.deposit_requests
        WHERE lower(btrim(transaction_id)) = v_norm_tid
          AND status = 'approved'
          AND id <> NEW.id
        ORDER BY created_at ASC
        LIMIT 1;

        IF v_existing_id IS NOT NULL THEN
          RAISE EXCEPTION
            'Duplicate transaction ID: TID % was already credited on deposit % (recorded %, amount UGX %). This request is a duplicate and cannot be approved.',
            NEW.transaction_id,
            v_existing_id,
            to_char(v_existing_created, 'YYYY-MM-DD HH24:MI'),
            v_existing_amount
            USING ERRCODE = 'unique_violation';
        END IF;
      END IF;

      RETURN NEW;
    END IF;
  END IF;

  SELECT id, status, amount, created_at
    INTO v_existing_id, v_existing_status, v_existing_amount, v_existing_created
  FROM public.deposit_requests
  WHERE lower(btrim(transaction_id)) = v_norm_tid
    AND lower(coalesce(provider, '')) = v_norm_provider
    AND status NOT IN ('rejected', 'cancelled', 'failed')
    AND id <> NEW.id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Duplicate transaction ID: TID % on % was already recorded on % (deposit %, status %, amount UGX %). Each TID can only be used once.',
      NEW.transaction_id,
      coalesce(NEW.provider, 'unknown'),
      to_char(v_existing_created, 'YYYY-MM-DD HH24:MI'),
      v_existing_id,
      v_existing_status,
      v_existing_amount
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$function$;


-- ── 3. auto_create_deposits_from_gmail_impl: two runs, one receipt, two rows ─
-- trg_gmail_tx_auto_create_deposit runs this whole batch on EVERY receipt
-- insert, on top of the 2-minute cron. When a cron run has created + linked a
-- deposit for receipt G but not yet committed, a concurrent run (another
-- receipt landing) still sees G unlinked and the deposit invisible, so it
-- creates a second deposit for the same payment. Live: 2026-09-10 10:16:00 /
-- 10:16:02 (UGX 5,000,000) and 2026-09-11 14:46:00 / 14:46:02 (180,000).
--
-- The receipt loop now takes a row lock with SKIP LOCKED: a concurrent run
-- skips receipts another run is working on, and once that run commits they
-- are linked and drop out of the WHERE. Body otherwise unchanged from live.
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
     for update of g skip locked
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
