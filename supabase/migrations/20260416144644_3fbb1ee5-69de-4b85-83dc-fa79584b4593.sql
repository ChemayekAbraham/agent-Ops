
-- 1. Add wallet_id to general_ledger
ALTER TABLE public.general_ledger
  ADD COLUMN wallet_id uuid REFERENCES public.wallets(id);

CREATE INDEX idx_general_ledger_wallet_id
  ON public.general_ledger(wallet_id);

-- Temporarily disable update prevention trigger for backfill
ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;

UPDATE public.general_ledger gl
SET wallet_id = w.id
FROM public.wallets w
WHERE w.user_id = gl.user_id
  AND gl.wallet_id IS NULL;

ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;

-- 2. Add wallet_id to profiles
ALTER TABLE public.profiles
  ADD COLUMN wallet_id uuid REFERENCES public.wallets(id);

CREATE UNIQUE INDEX idx_profiles_wallet_id
  ON public.profiles(wallet_id);

UPDATE public.profiles p
SET wallet_id = w.id
FROM public.wallets w
WHERE w.user_id = p.id
  AND p.wallet_id IS NULL;

-- 3. Update create_ledger_transaction RPC to auto-resolve wallet_id
CREATE OR REPLACE FUNCTION public.create_ledger_transaction(
  entries jsonb,
  idempotency_key text DEFAULT NULL,
  skip_balance_check boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id uuid;
  v_entry jsonb;
  v_total_in numeric := 0;
  v_total_out numeric := 0;
  v_entry_count int := 0;
  v_total_amount numeric := 0;
  v_user_balance numeric;
  v_lock_key bigint;
  v_wallet_id uuid;
BEGIN
  IF entries IS NULL OR jsonb_typeof(entries) <> 'array' THEN
    RAISE EXCEPTION 'entries must be a JSON array, got: %', COALESCE(jsonb_typeof(entries), 'NULL');
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  IF idempotency_key IS NOT NULL AND idempotency_key <> '' THEN
    v_lock_key := abs(hashtext(idempotency_key));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT transaction_group_id INTO v_group_id
    FROM general_ledger
    WHERE general_ledger.idempotency_key = create_ledger_transaction.idempotency_key
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_group_id IS NOT NULL THEN
      RETURN v_group_id;
    END IF;
  END IF;

  v_group_id := gen_random_uuid();

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    IF (v_entry->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'All amounts must be positive, got: %', v_entry->>'amount';
    END IF;

    IF v_entry->>'direction' = 'cash_in' THEN
      v_total_in := v_total_in + (v_entry->>'amount')::numeric;
    ELSIF v_entry->>'direction' = 'cash_out' THEN
      v_total_out := v_total_out + (v_entry->>'amount')::numeric;

      IF NOT skip_balance_check AND COALESCE(v_entry->>'ledger_scope', 'wallet') = 'wallet' THEN
        SELECT COALESCE(SUM(
          CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END
        ), 0) INTO v_user_balance
        FROM general_ledger
        WHERE user_id = (v_entry->>'user_id')::uuid
          AND ledger_scope = 'wallet';

        IF v_user_balance < (v_entry->>'amount')::numeric THEN
          RAISE EXCEPTION 'Insufficient ledger balance for user %. Available: %, Required: %',
            v_entry->>'user_id', v_user_balance, v_entry->>'amount';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in or cash_out', v_entry->>'direction';
    END IF;

    v_entry_count := v_entry_count + 1;
    v_total_amount := v_total_amount + (v_entry->>'amount')::numeric;
  END LOOP;

  IF v_total_in <> v_total_out THEN
    RAISE EXCEPTION 'Transaction not balanced. Total cash_in (%) <> total cash_out (%)', v_total_in, v_total_out;
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    v_wallet_id := NULL;
    IF (v_entry->>'user_id') IS NOT NULL THEN
      SELECT id INTO v_wallet_id
      FROM public.wallets
      WHERE user_id = (v_entry->>'user_id')::uuid;
    END IF;

    INSERT INTO general_ledger (
      user_id, wallet_id, ledger_scope, direction, category, amount, currency,
      description, source_table, source_id, transaction_group_id,
      idempotency_key, transaction_date, linked_party, reference_id, account
    ) VALUES (
      (v_entry->>'user_id')::uuid,
      v_wallet_id,
      COALESCE(v_entry->>'ledger_scope', 'wallet'),
      v_entry->>'direction',
      v_entry->>'category',
      (v_entry->>'amount')::numeric,
      COALESCE(v_entry->>'currency', 'UGX'),
      v_entry->>'description',
      v_entry->>'source_table',
      (v_entry->>'source_id')::uuid,
      v_group_id,
      create_ledger_transaction.idempotency_key,
      COALESCE((v_entry->>'transaction_date')::timestamptz, now()),
      v_entry->>'linked_party',
      v_entry->>'reference_id',
      v_entry->>'account'
    );
  END LOOP;

  RETURN v_group_id;
END;
$$;
