
-- ============================================================================
-- Auto-create pending deposit_requests from unmatched Gmail transactions
-- ============================================================================
-- Scans recent unlinked gmail_transactions (parsed inbound mobile-money
-- credits), identifies the depositor by phone number found inside the email
-- body/snippet, and creates a pending deposit_requests row pre-populated
-- with the TID. The existing matcher + AFTER-INSERT auto-rematch trigger
-- then links them and the FinOps panel can auto-approve via TID.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.auto_create_deposits_from_gmail(
  p_window_hours integer DEFAULT 24
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx RECORD;
  v_phone_match text;
  v_phone_norm  text;
  v_user_id     uuid;
  v_provider    text;
  v_haystack    text;
  v_created     integer := 0;
  v_new_id      uuid;
BEGIN
  FOR v_tx IN
    SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.internal_date,
           g.subject, g.snippet, g.raw_body, g.from_email
      FROM gmail_transactions g
     WHERE g.linked_deposit_request_id IS NULL
       AND g.parsed = true
       AND (g.direction IS NULL OR g.direction IN ('in','credit'))
       AND g.amount IS NOT NULL
       AND g.amount > 0
       AND g.transaction_id IS NOT NULL
       AND length(trim(g.transaction_id)) > 0
       AND (g.internal_date IS NULL
            OR g.internal_date >= (now() - (p_window_hours || ' hours')::interval))
     ORDER BY g.internal_date DESC NULLS LAST
     LIMIT 200
  LOOP
    -- Skip if a deposit_requests row already exists with this TID
    IF EXISTS (
      SELECT 1 FROM deposit_requests d
       WHERE d.transaction_id IS NOT NULL
         AND lower(trim(d.transaction_id)) = lower(trim(v_tx.transaction_id))
    ) THEN
      CONTINUE;
    END IF;

    v_haystack := concat_ws(' ',
      coalesce(v_tx.snippet, ''),
      coalesce(v_tx.subject, ''),
      coalesce(v_tx.counterparty, ''),
      coalesce(v_tx.raw_body, '')
    );

    -- Extract first plausible UG phone number (256XXXXXXXXX or 0XXXXXXXXX)
    v_phone_match := substring(v_haystack from '256[0-9]{9}');
    IF v_phone_match IS NULL THEN
      v_phone_match := substring(v_haystack from '0[7][0-9]{8}');
    END IF;

    IF v_phone_match IS NULL THEN
      CONTINUE;
    END IF;

    -- Normalise to local 0XXXXXXXXX format used in profiles.phone
    IF v_phone_match LIKE '256%' THEN
      v_phone_norm := '0' || substring(v_phone_match from 4);
    ELSE
      v_phone_norm := v_phone_match;
    END IF;

    -- Resolve user by phone (tolerate stored +256/256/0 variants)
    SELECT p.id INTO v_user_id
      FROM profiles p
     WHERE regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') IN (
             regexp_replace(v_phone_match, '[^0-9]', '', 'g'),
             regexp_replace(v_phone_norm,  '[^0-9]', '', 'g'),
             '256' || substring(v_phone_norm from 2)
           )
     LIMIT 1;

    IF v_user_id IS NULL THEN
      CONTINUE;
    END IF;

    -- Don't create if user already has a recent pending request for this exact amount
    -- (let the normal matcher attach the email to that one).
    IF EXISTS (
      SELECT 1 FROM deposit_requests d
       WHERE d.user_id = v_user_id
         AND d.status = 'pending'
         AND abs(d.amount - v_tx.amount) < 0.5
         AND d.created_at >= (now() - (p_window_hours || ' hours')::interval)
    ) THEN
      CONTINUE;
    END IF;

    -- Infer provider from email content
    v_provider := CASE
      WHEN v_haystack ILIKE '%momo%' OR v_haystack ILIKE '%MTN%' THEN 'mtn'
      WHEN v_haystack ILIKE '%airtel%' THEN 'airtel'
      ELSE 'mtn'
    END;

    INSERT INTO deposit_requests (
      user_id, amount, status, provider, transaction_id,
      transaction_date, notes, auto_approved
    ) VALUES (
      v_user_id, v_tx.amount, 'pending', v_provider, trim(v_tx.transaction_id),
      coalesce(v_tx.internal_date, now()),
      'Auto-created from mobile-money confirmation email (no matching deposit request found).',
      false
    )
    RETURNING id INTO v_new_id;

    -- Immediately link the gmail tx so it doesn't get re-picked next cycle
    UPDATE gmail_transactions
       SET linked_deposit_request_id = v_new_id,
           auto_matched_at = now(),
           auto_match_method = 'tid'
     WHERE id = v_tx.id
       AND linked_deposit_request_id IS NULL;

    INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      v_user_id, 'auto_create_deposit_from_email', 'deposit_requests', v_new_id::text,
      jsonb_build_object(
        'amount', v_tx.amount,
        'transaction_id', v_tx.transaction_id,
        'gmail_transaction_id', v_tx.id,
        'matched_phone', v_phone_match,
        'provider', v_provider,
        'triggered_by', 'auto_create_deposits_from_gmail'
      )
    );

    v_created := v_created + 1;
  END LOOP;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_create_deposits_from_gmail(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.auto_create_deposits_from_gmail(integer) TO authenticated, service_role;

-- AFTER-INSERT trigger on gmail_transactions: when a fresh, unlinked
-- inbound credit lands, attempt to spawn a deposit_requests row for it.
CREATE OR REPLACE FUNCTION public.trg_gmail_tx_auto_create_deposit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.linked_deposit_request_id IS NULL
     AND NEW.parsed = true
     AND NEW.amount IS NOT NULL AND NEW.amount > 0
     AND NEW.transaction_id IS NOT NULL
     AND (NEW.direction IS NULL OR NEW.direction IN ('in','credit')) THEN
    BEGIN
      PERFORM public.auto_create_deposits_from_gmail(24);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'auto_create_deposits_from_gmail failed: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_gmail_tx_auto_create_deposit ON public.gmail_transactions;
CREATE TRIGGER trg_gmail_tx_auto_create_deposit
AFTER INSERT ON public.gmail_transactions
FOR EACH ROW EXECUTE FUNCTION public.trg_gmail_tx_auto_create_deposit();

-- Background sweep every 2 minutes (replaces any prior cron of same name)
DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'email-auto-create-deposits-24h';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'email-auto-create-deposits-24h',
  '*/2 * * * *',
  $$ SELECT public.auto_create_deposits_from_gmail(24); $$
);
