-- Stop the */2 email auto-match retry from re-scoring months-old deposits.
--
-- public.auto_match_email_deposits is the body of cron job
-- email-auto-match-retry-24h (run_email_auto_match_retry(24)). The amount
-- candidate used `internal_date >= created_at - window` with no upper bound,
-- so each tick walked unmatched Gmail for every still-pending deposit. On
-- 2026-11-06 that was 72 unlinked non-cash pendings, 69 of them older than
-- 14 days (about 99 days on average), and the open candidate select took
-- 558 ms / 145,010 buffer hits.
--
-- This rewrite keeps the recovery pass and the TID exact match. Two amount
-- changes:
--   * the candidate date is a closed window,
--     internal_date BETWEEN created_at - p_window_hours AND created_at + p_window_hours
--     (null internal_date no longer qualifies);
--   * after a TID miss, deposits older than 14 days skip amount and fuzzy
--     scoring. TID is still tried for them.
--
-- The cron schedule is unchanged. No index: the same candidate select for
-- the deposits that still reach it (created_at within 14 days, closed
-- window) was 6.2 ms / 421 buffer hits.
--
-- CREATE OR REPLACE keeps SECURITY DEFINER, search_path, the return shape,
-- and the existing EXECUTE grants (postgres, authenticated, service_role).
-- Do not DROP this function here; a drop would reset those grants.

CREATE OR REPLACE FUNCTION public.auto_match_email_deposits(p_amount_tolerance numeric DEFAULT 0, p_window_hours integer DEFAULT 72)
 RETURNS TABLE(deposit_request_id uuid, gmail_transaction_id uuid, method text, amount numeric, matched_transaction_id text, user_id uuid, provider text, counterparty text, internal_date timestamp with time zone, signals text[], match_score integer, from_email text, from_name text, subject text, snippet text, depositor_email text, depositor_full_name text, depositor_phone text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_pending RECORD;
  v_tid_match RECORD;
  v_amt_match RECORD;
  v_already RECORD;
  v_phone_clean text;
  v_notes_clean text;
begin /* advisor_guard */ if not (pg_trigger_depth() > 0 or public.can_view_finance_reports(auth.uid())) then raise exception 'not authorized' using errcode = '42501'; end if;
  -- 0. Recovery pass: re-emit deposits whose email was already linked but never approved.
  --    Cash-code deposits are excluded — they only credit via the receipt-code flow.
  FOR v_already IN
    SELECT d.id AS dep_id, d.user_id AS dep_user, d.provider AS dep_provider,
           p.full_name, p.phone, p.email,
           g.id AS gid, g.amount AS gamt, g.transaction_id AS gtid,
           g.counterparty AS gcp, g.internal_date AS gdate,
           g.from_email AS gfe, g.from_name AS gfn, g.subject AS gsub, g.snippet AS gsnip,
           g.auto_match_method AS gmethod
      FROM deposit_requests d
      JOIN gmail_transactions g ON g.linked_deposit_request_id = d.id
      LEFT JOIN profiles p ON p.id = d.user_id
     WHERE d.status = 'pending'
       AND d.provider IS DISTINCT FROM 'cash_deposit'
       AND g.auto_matched_at IS NOT NULL
     ORDER BY d.created_at ASC
     LIMIT 500
  LOOP
    deposit_request_id := v_already.dep_id;
    gmail_transaction_id := v_already.gid;
    method := COALESCE(v_already.gmethod, 'tid');
    amount := v_already.gamt;
    matched_transaction_id := v_already.gtid;
    user_id := v_already.dep_user;
    provider := v_already.dep_provider;
    counterparty := v_already.gcp;
    internal_date := v_already.gdate;
    signals := ARRAY[COALESCE(v_already.gmethod, 'tid')];
    match_score := CASE WHEN v_already.gmethod = 'tid' THEN 100 ELSE 1 END;
    from_email := v_already.gfe;
    from_name := v_already.gfn;
    subject := v_already.gsub;
    snippet := v_already.gsnip;
    depositor_email := v_already.email;
    depositor_full_name := v_already.full_name;
    depositor_phone := v_already.phone;
    RETURN NEXT;
  END LOOP;

  FOR v_pending IN
    SELECT d.id, d.user_id, d.amount, d.provider, d.transaction_id, d.notes, d.created_at,
           p.full_name, p.phone, p.email
      FROM deposit_requests d
      LEFT JOIN profiles p ON p.id = d.user_id
     WHERE d.status = 'pending'
       AND d.provider IS DISTINCT FROM 'cash_deposit'  -- cash-code deposits credit ONLY via receipt code
       AND NOT EXISTS (
         SELECT 1 FROM gmail_transactions gx
          WHERE gx.linked_deposit_request_id = d.id
       )
     ORDER BY d.created_at ASC
     LIMIT 500
  LOOP
    v_tid_match := NULL;
    v_amt_match := NULL;
    v_phone_clean := regexp_replace(coalesce(v_pending.phone, ''), '[^0-9]', '', 'g');
    v_notes_clean := nullif(trim(coalesce(v_pending.notes, '')), '');

    -- 1. Exact TID
    IF v_pending.transaction_id IS NOT NULL AND length(trim(v_pending.transaction_id)) > 0 THEN
      SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.internal_date,
             g.from_email, g.from_name, g.subject, g.snippet
        INTO v_tid_match
        FROM gmail_transactions g
       WHERE g.linked_deposit_request_id IS NULL
         AND g.parsed = true
         AND (g.direction IS NULL OR g.direction IN ('in','credit'))
         AND g.transaction_id IS NOT NULL
         AND NOT (lower(coalesce(g.subject,'')) LIKE 'cash deposit code%')
         AND lower(g.transaction_id) = lower(v_pending.transaction_id)
       ORDER BY g.internal_date DESC NULLS LAST
       LIMIT 1;
    END IF;

    IF v_tid_match.id IS NOT NULL THEN
      BEGIN
        UPDATE gmail_transactions
           SET linked_deposit_request_id = v_pending.id,
               auto_matched_at = now(),
               auto_match_method = 'tid'
         WHERE id = v_tid_match.id AND linked_deposit_request_id IS NULL;
        IF FOUND THEN
          deposit_request_id := v_pending.id;
          gmail_transaction_id := v_tid_match.id;
          method := 'tid';
          amount := v_tid_match.amount;
          matched_transaction_id := v_tid_match.transaction_id;
          user_id := v_pending.user_id;
          provider := v_pending.provider;
          counterparty := v_tid_match.counterparty;
          internal_date := v_tid_match.internal_date;
          signals := ARRAY['tid'];
          match_score := 100;
          from_email := v_tid_match.from_email;
          from_name := v_tid_match.from_name;
          subject := v_tid_match.subject;
          snippet := v_tid_match.snippet;
          depositor_email := v_pending.email;
          depositor_full_name := v_pending.full_name;
          depositor_phone := v_pending.phone;
          RETURN NEXT;
          CONTINUE;
        END IF;
      EXCEPTION WHEN unique_violation THEN NULL;
      END;
    END IF;

    -- TID already ran. Deposits older than 14 days are not amount-matched;
    -- the open-ended retry was re-scoring those rows every cron tick.
    IF v_pending.created_at < now() - interval '14 days' THEN
      CONTINUE;
    END IF;

    -- 2. Amount + extra-signal scored match
    WITH cands AS (
      SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.from_email, g.from_name,
             g.subject, g.snippet, g.raw_body, g.internal_date
        FROM gmail_transactions g
       WHERE g.linked_deposit_request_id IS NULL
         AND g.parsed = true
         AND (g.direction IS NULL OR g.direction IN ('in','credit'))
         AND NOT (lower(coalesce(g.subject,'')) LIKE 'cash deposit code%')
         AND g.amount IS NOT NULL
         AND abs(g.amount - v_pending.amount) <= p_amount_tolerance
         AND g.internal_date BETWEEN (v_pending.created_at - make_interval(hours => p_window_hours))
                                 AND (v_pending.created_at + make_interval(hours => p_window_hours))
    ),
    scored AS (
      SELECT c.*,
        (CASE /* any order */ WHEN v_pending.full_name IS NOT NULL AND length(trim(v_pending.full_name)) >= 3
              AND ((c.counterparty IS NOT NULL AND lower(c.counterparty) LIKE '%' || lower(trim(v_pending.full_name)) || '%')
                OR (c.from_name IS NOT NULL AND lower(c.from_name) LIKE '%' || lower(trim(v_pending.full_name)) || '%')
                OR (SELECT count(*) >= 2 AND bool_and(position(w IN lower(coalesce(c.counterparty, '') || ' ' || coalesce(c.from_name, ''))) > 0)
                      FROM unnest(string_to_array(lower(trim(v_pending.full_name)), ' ')) AS w WHERE length(w) >= 2))
              THEN 1 ELSE 0 END) AS s_name,
        (CASE WHEN length(v_phone_clean) >= 6
              AND ((c.raw_body IS NOT NULL AND regexp_replace(c.raw_body, '[^0-9]', '', 'g') LIKE '%' || v_phone_clean || '%')
                OR (c.snippet IS NOT NULL AND regexp_replace(c.snippet, '[^0-9]', '', 'g') LIKE '%' || v_phone_clean || '%')
                OR (c.subject IS NOT NULL AND regexp_replace(c.subject, '[^0-9]', '', 'g') LIKE '%' || v_phone_clean || '%')
                OR (c.counterparty IS NOT NULL AND regexp_replace(c.counterparty, '[^0-9]', '', 'g') LIKE '%' || v_phone_clean || '%')
                OR (c.from_email IS NOT NULL AND regexp_replace(c.from_email, '[^0-9]', '', 'g') LIKE '%' || v_phone_clean || '%'))
              THEN 1 ELSE 0 END) AS s_phone,
        (CASE WHEN v_pending.email IS NOT NULL AND c.from_email IS NOT NULL
              AND lower(trim(c.from_email)) = lower(trim(v_pending.email))
              THEN 1 ELSE 0 END) AS s_sender,
        (CASE WHEN (
              (v_notes_clean IS NOT NULL AND length(v_notes_clean) >= 4
                AND ((c.raw_body IS NOT NULL AND lower(c.raw_body) LIKE '%' || lower(v_notes_clean) || '%')
                  OR (c.subject IS NOT NULL AND lower(c.subject) LIKE '%' || lower(v_notes_clean) || '%')
                  OR (c.snippet IS NOT NULL AND lower(c.snippet) LIKE '%' || lower(v_notes_clean) || '%')))
              OR (v_pending.transaction_id IS NOT NULL AND length(trim(v_pending.transaction_id)) >= 4
                AND ((c.raw_body IS NOT NULL AND lower(c.raw_body) LIKE '%' || lower(trim(v_pending.transaction_id)) || '%')
                  OR (c.subject IS NOT NULL AND lower(c.subject) LIKE '%' || lower(trim(v_pending.transaction_id)) || '%')
                  OR (c.snippet IS NOT NULL AND lower(c.snippet) LIKE '%' || lower(trim(v_pending.transaction_id)) || '%'))))
              THEN 1 ELSE 0 END) AS s_reference
      FROM cands c
    ),
    ranked AS (
      SELECT s.*, (s.s_name + s.s_phone + s.s_sender + s.s_reference) AS score FROM scored s
    )
    SELECT r.id, r.amount, r.transaction_id, r.counterparty, r.internal_date,
           r.from_email, r.from_name, r.subject, r.snippet,
           r.s_name, r.s_phone, r.s_sender, r.s_reference, r.score
      INTO v_amt_match
      FROM ranked r
     ORDER BY r.score DESC, r.internal_date DESC NULLS LAST
     LIMIT 1;

    IF v_amt_match.id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM deposit_requests d2
         WHERE d2.status = 'pending' AND d2.id <> v_pending.id
           AND abs(d2.amount - v_amt_match.amount) <= p_amount_tolerance
      ) AND v_amt_match.score = 0 THEN
        CONTINUE;
      END IF;

      BEGIN
        UPDATE gmail_transactions
           SET linked_deposit_request_id = v_pending.id,
               auto_matched_at = now(),
               auto_match_method = CASE WHEN v_amt_match.score >= 1 THEN 'amount_strong' ELSE 'amount' END
         WHERE id = v_amt_match.id AND linked_deposit_request_id IS NULL;

        IF FOUND THEN
          deposit_request_id := v_pending.id;
          gmail_transaction_id := v_amt_match.id;
          method := CASE WHEN v_amt_match.score >= 1 THEN 'amount_strong' ELSE 'amount' END;
          amount := v_amt_match.amount;
          matched_transaction_id := v_amt_match.transaction_id;
          user_id := v_pending.user_id;
          provider := v_pending.provider;
          counterparty := v_amt_match.counterparty;
          internal_date := v_amt_match.internal_date;
          signals := ARRAY(
            SELECT s FROM (VALUES
              ('amount', 1),
              ('name', v_amt_match.s_name),
              ('phone', v_amt_match.s_phone),
              ('sender', v_amt_match.s_sender),
              ('reference', v_amt_match.s_reference)
            ) AS t(s, hit) WHERE hit = 1
          );
          match_score := v_amt_match.score;
          from_email := v_amt_match.from_email;
          from_name := v_amt_match.from_name;
          subject := v_amt_match.subject;
          snippet := v_amt_match.snippet;
          depositor_email := v_pending.email;
          depositor_full_name := v_pending.full_name;
          depositor_phone := v_pending.phone;
          RETURN NEXT;
        END IF;
      EXCEPTION WHEN unique_violation THEN NULL;
      END;
    END IF;
  END LOOP;
END;
$function$;
