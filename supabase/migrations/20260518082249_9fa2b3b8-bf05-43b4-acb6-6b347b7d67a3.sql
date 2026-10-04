
DROP FUNCTION IF EXISTS public.auto_match_email_deposits(numeric, integer);

CREATE OR REPLACE FUNCTION public.auto_match_email_deposits(
  p_amount_tolerance numeric DEFAULT 0,
  p_window_hours integer DEFAULT 168
)
RETURNS TABLE (
  deposit_request_id uuid,
  gmail_transaction_id uuid,
  method text,
  amount numeric,
  matched_transaction_id text,
  user_id uuid,
  provider text,
  counterparty text,
  internal_date timestamptz,
  signals text[],
  match_score integer,
  from_email text,
  from_name text,
  subject text,
  snippet text,
  depositor_email text,
  depositor_full_name text,
  depositor_phone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pending RECORD;
  v_tid_match RECORD;
  v_amt_match RECORD;
  v_phone_clean text;
  v_notes_clean text;
BEGIN
  FOR v_pending IN
    SELECT d.id, d.user_id, d.amount, d.provider, d.transaction_id, d.notes, d.created_at,
           p.full_name, p.phone, p.email
      FROM deposit_requests d
      LEFT JOIN profiles p ON p.id = d.user_id
     WHERE d.status = 'pending'
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

    -- 2. Amount + extra-signal scored match
    WITH cands AS (
      SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.from_email, g.from_name,
             g.subject, g.snippet, g.raw_body, g.internal_date
        FROM gmail_transactions g
       WHERE g.linked_deposit_request_id IS NULL
         AND g.parsed = true
         AND (g.direction IS NULL OR g.direction IN ('in','credit'))
         AND g.amount IS NOT NULL
         AND abs(g.amount - v_pending.amount) <= p_amount_tolerance
         AND (g.internal_date IS NULL OR g.internal_date >= (v_pending.created_at - (p_window_hours || ' hours')::interval))
    ),
    scored AS (
      SELECT c.*,
        (CASE WHEN v_pending.full_name IS NOT NULL AND length(trim(v_pending.full_name)) >= 3
              AND ((c.counterparty IS NOT NULL AND lower(c.counterparty) LIKE '%' || lower(trim(v_pending.full_name)) || '%')
                OR (c.from_name IS NOT NULL AND lower(c.from_name) LIKE '%' || lower(trim(v_pending.full_name)) || '%'))
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
      SELECT s.*, (s_name + s_phone + s_sender + s_reference) AS score FROM scored s
    )
    SELECT id, amount, transaction_id, counterparty, internal_date,
           from_email, from_name, subject, snippet,
           s_name, s_phone, s_sender, s_reference, score
      INTO v_amt_match
      FROM ranked
     ORDER BY score DESC, internal_date DESC NULLS LAST
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
$$;

REVOKE ALL ON FUNCTION public.auto_match_email_deposits(numeric, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.auto_match_email_deposits(numeric, integer) TO authenticated;
