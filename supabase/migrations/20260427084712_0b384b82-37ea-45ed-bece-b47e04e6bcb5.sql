-- 1. Tighten the duplicate-pending guard
CREATE OR REPLACE FUNCTION public.prevent_duplicate_pending_withdrawal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  duplicate_id uuid;
  window_minutes int := 10;
BEGIN
  -- Guard fresh submissions and rows still being approved by operators.
  -- Skips terminal states (rejected/completed/cancelled) so legitimate
  -- re-tries after a rejection are never blocked.
  IF NEW.status IS DISTINCT FROM 'pending'
     AND NEW.status IS DISTINCT FROM 'manager_approved' THEN
    RETURN NEW;
  END IF;

  -- Mobile money: same provider + same normalised phone + same amount.
  IF NEW.payout_method = 'mobile_money'
     AND NEW.mobile_money_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status IN ('pending', 'manager_approved')
      AND payout_method = 'mobile_money'
      AND mobile_money_provider IS NOT DISTINCT FROM NEW.mobile_money_provider
      AND regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g')
          = regexp_replace(coalesce(NEW.mobile_money_number, ''), '\D', '', 'g')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;

  -- Bank: same bank + same account number + same amount.
  ELSIF NEW.payout_method = 'bank_transfer'
        AND NEW.bank_account_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status IN ('pending', 'manager_approved')
      AND payout_method = 'bank_transfer'
      AND bank_name IS NOT DISTINCT FROM NEW.bank_name
      AND bank_account_number = NEW.bank_account_number
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;

  -- Cash: same agent location + same amount.
  ELSIF NEW.payout_method = 'cash' THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status IN ('pending', 'manager_approved')
      AND payout_method = 'cash'
      AND coalesce(agent_location, '') = coalesce(NEW.agent_location, '')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;
  END IF;

  -- Agent proxy-partner pattern: payout_method may be null at insert time;
  -- the dedupe key is (agent user_id, partner id, amount).
  IF duplicate_id IS NULL
     AND NEW.proxy_partner_id IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status IN ('pending', 'manager_approved')
      AND proxy_partner_id = NEW.proxy_partner_id
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;
  END IF;

  IF duplicate_id IS NOT NULL THEN
    RAISE EXCEPTION
      'DUPLICATE_PENDING_WITHDRAWAL: identical request already waiting (id=%)',
      duplicate_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

-- 2. One-time cleanup of historical duplicates older than 1 hour.
-- Keep the oldest pending row per (user, recipient, amount) group; reject the rest.
WITH groups AS (
  SELECT
    id,
    user_id,
    amount,
    payout_method,
    coalesce(regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g'), '')
      || '|' || coalesce(bank_account_number, '')
      || '|' || coalesce(agent_location, '')
      || '|' || coalesce(proxy_partner_id::text, '') AS recipient_key,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY
        user_id,
        amount,
        payout_method,
        coalesce(regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g'), ''),
        coalesce(bank_account_number, ''),
        coalesce(agent_location, ''),
        coalesce(proxy_partner_id::text, '')
      ORDER BY created_at ASC
    ) AS rn
  FROM public.withdrawal_requests
  WHERE status = 'pending'
    AND created_at < now() - interval '1 hour'
),
to_reject AS (
  SELECT id FROM groups WHERE rn > 1
),
rejected AS (
  UPDATE public.withdrawal_requests w
  SET status = 'rejected',
      rejection_reason = 'System cleanup: duplicate of older waiting request',
      updated_at = now()
  FROM to_reject
  WHERE w.id = to_reject.id
  RETURNING w.id, w.user_id, w.amount
)
INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
SELECT
  user_id,
  'duplicate_withdrawal_auto_rejected',
  'withdrawal_requests',
  id,
  jsonb_build_object(
    'amount', amount,
    'reason', 'System cleanup: duplicate of older waiting request',
    'cleaned_at', now()
  )
FROM rejected;