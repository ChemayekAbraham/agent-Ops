-- 1. Link columns on gmail_transactions
ALTER TABLE public.gmail_transactions
  ADD COLUMN IF NOT EXISTS linked_deposit_request_id uuid REFERENCES public.deposit_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auto_matched_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_match_method text CHECK (auto_match_method IN ('tid','amount'));

-- Each gmail transaction can only back one deposit_request (prevents double-credit races).
CREATE UNIQUE INDEX IF NOT EXISTS gmail_transactions_linked_deposit_uniq
  ON public.gmail_transactions(linked_deposit_request_id)
  WHERE linked_deposit_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS gmail_transactions_tid_lower_idx
  ON public.gmail_transactions(lower(transaction_id))
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS gmail_transactions_match_lookup_idx
  ON public.gmail_transactions(direction, parsed, linked_deposit_request_id, internal_date DESC);

-- 2. RPC: auto-match unlinked parsed inbound emails to pending deposit_requests.
--    Returns one row per newly linked pair so the UI can display + bulk-approve.
CREATE OR REPLACE FUNCTION public.auto_match_email_deposits(
  p_amount_tolerance numeric DEFAULT 0,
  p_window_hours integer DEFAULT 168 -- 7 days
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
  internal_date timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pending RECORD;
  v_match RECORD;
BEGIN
  -- Loop pending deposits oldest-first so they are matched FIFO.
  FOR v_pending IN
    SELECT id, user_id, amount, provider, transaction_id, created_at
      FROM deposit_requests
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT 500
  LOOP
    v_match := NULL;

    -- Prefer exact TID match (case-insensitive). Unlinked, inbound, parsed.
    IF v_pending.transaction_id IS NOT NULL AND length(trim(v_pending.transaction_id)) > 0 THEN
      SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.internal_date
        INTO v_match
        FROM gmail_transactions g
       WHERE g.linked_deposit_request_id IS NULL
         AND g.parsed = true
         AND (g.direction IS NULL OR g.direction IN ('in','credit'))
         AND g.transaction_id IS NOT NULL
         AND lower(g.transaction_id) = lower(v_pending.transaction_id)
       ORDER BY g.internal_date DESC NULLS LAST
       LIMIT 1;
    END IF;

    -- Fallback: amount + time-window match (no other pending deposit shares this exact amount in window — avoid ambiguity).
    IF v_match.id IS NULL THEN
      SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.internal_date
        INTO v_match
        FROM gmail_transactions g
       WHERE g.linked_deposit_request_id IS NULL
         AND g.parsed = true
         AND (g.direction IS NULL OR g.direction IN ('in','credit'))
         AND g.amount IS NOT NULL
         AND abs(g.amount - v_pending.amount) <= p_amount_tolerance
         AND (g.internal_date IS NULL OR g.internal_date >= (v_pending.created_at - (p_window_hours || ' hours')::interval))
         -- Ambiguity guard: skip if more than one pending deposit shares this exact amount in window
         AND NOT EXISTS (
           SELECT 1 FROM deposit_requests d2
            WHERE d2.status = 'pending'
              AND d2.id <> v_pending.id
              AND abs(d2.amount - g.amount) <= p_amount_tolerance
         )
       ORDER BY g.internal_date DESC NULLS LAST
       LIMIT 1;
    END IF;

    IF v_match.id IS NOT NULL THEN
      -- Atomically claim the gmail row. Unique partial index prevents double-claim.
      BEGIN
        UPDATE gmail_transactions
           SET linked_deposit_request_id = v_pending.id,
               auto_matched_at = now(),
               auto_match_method = CASE
                 WHEN v_pending.transaction_id IS NOT NULL
                  AND v_match.transaction_id IS NOT NULL
                  AND lower(v_match.transaction_id) = lower(v_pending.transaction_id)
                 THEN 'tid' ELSE 'amount'
               END
         WHERE id = v_match.id
           AND linked_deposit_request_id IS NULL;

        IF FOUND THEN
          deposit_request_id := v_pending.id;
          gmail_transaction_id := v_match.id;
          method := CASE
            WHEN v_pending.transaction_id IS NOT NULL
             AND v_match.transaction_id IS NOT NULL
             AND lower(v_match.transaction_id) = lower(v_pending.transaction_id)
            THEN 'tid' ELSE 'amount'
          END;
          amount := v_match.amount;
          matched_transaction_id := v_match.transaction_id;
          user_id := v_pending.user_id;
          provider := v_pending.provider;
          counterparty := v_match.counterparty;
          internal_date := v_match.internal_date;
          RETURN NEXT;
        END IF;
      EXCEPTION WHEN unique_violation THEN
        -- Another caller linked it first; skip.
        NULL;
      END;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_match_email_deposits(numeric, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.auto_match_email_deposits(numeric, integer) TO authenticated;