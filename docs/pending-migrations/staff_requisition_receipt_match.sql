-- PENDING — do not apply until Benjamin approves.
-- Draft only. Not in supabase/migrations, so it is not part of a publish.
--
-- What this does
--   Adds receipt-read columns on staff_requisitions.
--   Derives amount_unaccounted = typed amount − receipt total (signed).
--   Blocks wallet_credit_status from becoming 'credited' while that gap is
--   open and the CFO has not cleared this typed amount and this receipt total.
--
-- What this does not do
--   Does not post a journal. Does not credit or debit a wallet. Does not claw back.
--   No change to v360. Submit stays allowed; only the payout status flip is held.
--   A requisition with no row in requisition_receipt_paths is not held.
--
-- Before applying, confirm production's staff_requisition_events_action_check.
-- The list below is the repo's constraint (20260924130000) plus receipt_attached
-- (already written by staff-requisition-add-attachment) and the new actions.
-- If production has extra actions, add them here before dropping the old check.
--
-- After applying, deploy staff-requisition-read-receipt and the updated
-- staff-requisition-add-attachment, staff-requisition-decide, and
-- requisition-credit-retry / requisitionWalletCredit. The edge function
-- refuses the credit before any ledger call. This trigger is the backstop
-- for a direct status update. Keep it aligned with
-- supabase/functions/_shared/requisitionReceiptMatch.ts (tolerance UGX 100).

BEGIN;

ALTER TABLE public.staff_requisitions
  ADD COLUMN IF NOT EXISTS requisition_receipt_paths text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS receipt_ocr_amount numeric,
  ADD COLUMN IF NOT EXISTS receipt_ocr_confidence text,
  ADD COLUMN IF NOT EXISTS receipt_ocr_currency text,
  ADD COLUMN IF NOT EXISTS receipt_ocr_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_ocr_error text,
  ADD COLUMN IF NOT EXISTS receipt_ocr_detail jsonb,
  ADD COLUMN IF NOT EXISTS amount_unaccounted numeric,
  ADD COLUMN IF NOT EXISTS approved_amount_unaccounted numeric,
  ADD COLUMN IF NOT EXISTS receipt_compared_amount numeric,
  ADD COLUMN IF NOT EXISTS receipt_match_status text NOT NULL DEFAULT 'no_receipt',
  ADD COLUMN IF NOT EXISTS payout_frozen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS receipt_gap_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_gap_cleared_by uuid,
  ADD COLUMN IF NOT EXISTS receipt_gap_clearance_note text,
  ADD COLUMN IF NOT EXISTS receipt_gap_cleared_typed_amount numeric,
  ADD COLUMN IF NOT EXISTS receipt_gap_cleared_ocr_amount numeric;

ALTER TABLE public.staff_requisitions
  DROP CONSTRAINT IF EXISTS staff_requisitions_receipt_match_status_check;
ALTER TABLE public.staff_requisitions
  ADD CONSTRAINT staff_requisitions_receipt_match_status_check
  CHECK (receipt_match_status IN (
    'no_receipt', 'pending', 'matched', 'mismatch', 'partial', 'needs_manual_review'
  ));

ALTER TABLE public.staff_requisitions
  DROP CONSTRAINT IF EXISTS staff_requisitions_receipt_ocr_confidence_check;
ALTER TABLE public.staff_requisitions
  ADD CONSTRAINT staff_requisitions_receipt_ocr_confidence_check
  CHECK (receipt_ocr_confidence IS NULL OR receipt_ocr_confidence IN ('high', 'low'));

COMMENT ON COLUMN public.staff_requisitions.amount_unaccounted IS
  'typed amount minus receipt total (signed). Positive: typed is higher. Negative: receipt is higher. Null: the receipt was not read; no figure was invented.';
COMMENT ON COLUMN public.staff_requisitions.payout_frozen IS
  'True when a requisition receipt is attached, it does not match the typed amount within UGX 100, the CFO has not cleared this gap, and the wallet is not already credited. Display only; the credit function and staff_requisition_receipt_guard enforce it.';

-- receipt_attached is already inserted by staff-requisition-add-attachment
-- but missing from the repo constraint, so that event insert fails closed.
ALTER TABLE public.staff_requisition_events
  DROP CONSTRAINT IF EXISTS staff_requisition_events_action_check;
ALTER TABLE public.staff_requisition_events
  ADD CONSTRAINT staff_requisition_events_action_check CHECK (action = ANY (ARRAY[
    'created', 'approved', 'rejected', 'returned', 'resubmitted',
    'credited', 'credit_failed', 'comment', 'amount_reduced', 'rerouted',
    'receipt_attached', 'receipt_read', 'receipt_gap_cleared', 'payout_frozen'
  ]));

CREATE OR REPLACE FUNCTION public.staff_requisition_receipt_verdict_for(
  p_typed numeric,
  p_approved numeric,
  p_ocr numeric,
  p_confidence text,
  p_error text,
  p_ocr_at timestamptz,
  p_paths text[],
  p_cleared_at timestamptz,
  p_cleared_typed numeric,
  p_cleared_ocr numeric,
  p_wallet_status text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $function$
DECLARE
  v_paths int := COALESCE(cardinality(p_paths), 0);
  v_typed numeric := CASE WHEN p_typed IS NULL THEN NULL ELSE round(p_typed) END;
  v_approved numeric := CASE WHEN p_approved IS NULL THEN NULL ELSE round(p_approved) END;
  v_ocr numeric := CASE WHEN p_ocr IS NULL THEN NULL ELSE round(p_ocr) END;
  v_error text := NULLIF(btrim(COALESCE(p_error, '')), '');
  v_confidence text := CASE WHEN p_confidence IN ('high', 'low') THEN p_confidence ELSE NULL END;
  v_official numeric := NULL;
  v_unaccounted numeric := NULL;
  v_approved_unaccounted numeric := NULL;
  v_status text;
  v_clearance boolean;
  v_gap boolean;
  v_credited boolean := p_wallet_status = 'credited';
  v_frozen boolean;
  v_message text;
BEGIN
  -- No requisition receipt: payout is not held. Usage-report files stay out of p_paths.
  IF v_paths = 0 THEN
    RETURN jsonb_build_object(
      'status', 'no_receipt',
      'allowed', true,
      'payout_frozen', false,
      'typed_amount', v_typed,
      'ocr_amount', NULL,
      'amount_unaccounted', NULL,
      'approved_unaccounted', NULL,
      'clearance_applies', false,
      'gap_open', false,
      'already_credited', v_credited,
      'message', 'No requisition receipt is attached. Submit is open and payout is not held for a receipt.'
    );
  END IF;

  IF p_ocr_at IS NULL AND v_ocr IS NULL AND v_error IS NULL THEN
    v_status := 'pending';
  ELSIF v_error IS NOT NULL OR v_ocr IS NULL OR v_confidence IS DISTINCT FROM 'high' OR v_typed IS NULL THEN
    -- Do not invent a total. A low-confidence number is not an official total.
    v_status := 'needs_manual_review';
  ELSE
    v_official := v_ocr;
    v_unaccounted := v_typed - v_ocr; -- typed minus receipt
    IF abs(v_unaccounted) <= 100 THEN
      v_status := 'matched';
    ELSIF v_unaccounted > 0 THEN
      v_status := 'partial';
    ELSE
      v_status := 'mismatch';
    END IF;
  END IF;

  IF v_approved IS NOT NULL AND v_official IS NOT NULL THEN
    v_approved_unaccounted := v_approved - v_official;
  END IF;

  v_clearance := p_cleared_at IS NOT NULL
    AND v_typed IS NOT DISTINCT FROM (CASE WHEN p_cleared_typed IS NULL THEN NULL ELSE round(p_cleared_typed) END)
    AND v_official IS NOT DISTINCT FROM (CASE WHEN p_cleared_ocr IS NULL THEN NULL ELSE round(p_cleared_ocr) END);

  v_gap := v_status IN ('pending', 'needs_manual_review', 'partial', 'mismatch');
  v_frozen := v_gap AND NOT v_clearance AND NOT v_credited;

  IF v_credited AND v_gap THEN
    v_message := 'Unaccounted amount is typed minus receipt. The wallet was already credited. Nothing is taken back.';
  ELSIF v_status IN ('partial', 'mismatch') THEN
    v_message := 'Unaccounted amount is typed minus receipt. '
      || CASE WHEN v_clearance
           THEN 'The CFO has cleared this gap, so payout can proceed.'
           ELSE 'Payout is frozen until the receipt matches or the CFO clears this gap.'
         END
      || ' Nothing is taken from the wallet.';
  ELSIF v_status = 'pending' THEN
    v_message := 'Payout is frozen. The receipt has not been read yet, so no amount was recorded. Nothing was credited.';
  ELSIF v_status = 'needs_manual_review' THEN
    v_message := 'The receipt could not be read confidently, so no total was recorded. Nothing is taken from the wallet.';
  ELSE
    v_message := 'Receipt total matches the typed amount within UGX 100.';
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'allowed', NOT v_frozen,
    'payout_frozen', v_frozen,
    'typed_amount', v_typed,
    'ocr_amount', v_official,
    'amount_unaccounted', v_unaccounted,
    'approved_unaccounted', v_approved_unaccounted,
    'clearance_applies', v_clearance,
    'gap_open', v_gap,
    'already_credited', v_credited,
    'message', v_message
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_requisition_receipt_verdict_for(
  numeric, numeric, numeric, text, text, timestamptz, text[], timestamptz, numeric, numeric, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_requisition_receipt_verdict_for(
  numeric, numeric, numeric, text, text, timestamptz, text[], timestamptz, numeric, numeric, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.staff_requisition_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  v jsonb;
BEGIN
  v := public.staff_requisition_receipt_verdict_for(
    NEW.amount,
    NEW.approved_amount,
    NEW.receipt_ocr_amount,
    NEW.receipt_ocr_confidence,
    NEW.receipt_ocr_error,
    NEW.receipt_ocr_at,
    NEW.requisition_receipt_paths,
    NEW.receipt_gap_cleared_at,
    NEW.receipt_gap_cleared_typed_amount,
    NEW.receipt_gap_cleared_ocr_amount,
    NEW.wallet_credit_status
  );
  NEW.receipt_match_status := v ->> 'status';
  NEW.amount_unaccounted := (v ->> 'amount_unaccounted')::numeric;
  NEW.approved_amount_unaccounted := (v ->> 'approved_unaccounted')::numeric;
  NEW.receipt_compared_amount := (v ->> 'typed_amount')::numeric;
  NEW.payout_frozen := COALESCE((v ->> 'payout_frozen')::boolean, false);

  -- Status flip only. A later receipt on an already-credited row is recorded
  -- and does not raise, so nothing is clawed back.
  IF NEW.wallet_credit_status = 'credited'
     AND (TG_OP = 'INSERT' OR OLD.wallet_credit_status IS DISTINCT FROM 'credited')
     AND COALESCE((v ->> 'allowed')::boolean, false) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'payout_frozen: receipt total does not match the typed amount and the CFO has not cleared the gap'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_requisition_receipt_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_requisition_receipt_guard() TO service_role;

DROP TRIGGER IF EXISTS trg_staff_requisition_receipt_guard ON public.staff_requisitions;
CREATE TRIGGER trg_staff_requisition_receipt_guard
  BEFORE INSERT OR UPDATE ON public.staff_requisitions
  FOR EACH ROW
  EXECUTE FUNCTION public.staff_requisition_receipt_guard();

COMMIT;
