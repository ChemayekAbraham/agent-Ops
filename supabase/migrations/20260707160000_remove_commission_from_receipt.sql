-- Customer-facing payout receipt must NOT expose the merchant agent's
-- commission. Redefine get_payout_receipt to drop the commission lookup and
-- the 'commission' field. get_payout_receipt_by_token delegates to this, so it
-- inherits the change automatically.
CREATE OR REPLACE FUNCTION public.get_payout_receipt(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  wr RECORD;
  recipient_name text;
  processor_name text;
  processor_phone text;
  merchant_branch text;
  receipt_number text;
  pm text;
BEGIN
  SELECT id, amount, payout_method, fin_ops_reference, processed_at, processed_by,
         status, reason, user_id, created_at, receipt_token,
         bank_name, bank_account_number, bank_account_name,
         mobile_money_number, mobile_money_name, mobile_money_provider
    INTO wr
  FROM public.withdrawal_requests
  WHERE id = p_withdrawal_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF wr.status NOT IN ('completed', 'fin_ops_approved') OR wr.processed_at IS NULL THEN
    RETURN jsonb_build_object('status', wr.status, 'paid', false);
  END IF;

  SELECT full_name INTO recipient_name FROM public.profiles WHERE id = wr.user_id;

  IF wr.processed_by IS NOT NULL THEN
    SELECT full_name, phone INTO processor_name, processor_phone
    FROM public.profiles WHERE id = wr.processed_by;

    SELECT label INTO merchant_branch
    FROM public.cashout_agents
    WHERE agent_id = wr.processed_by AND is_active = true
    LIMIT 1;
  END IF;

  receipt_number := 'WD' || to_char(coalesce(wr.processed_at, wr.created_at), 'YYMMDD')
                    || '-' || upper(substr(replace(wr.id::text, '-', ''), 1, 6));

  pm := lower(coalesce(wr.payout_method, ''));

  RETURN jsonb_build_object(
    'paid', true,
    'withdrawal_id', wr.id,
    'receipt_token', wr.receipt_token,
    'receipt_number', receipt_number,
    'transaction_type', 'Cash Withdrawal',
    'status', wr.status,
    'amount', wr.amount,
    'payout_method', wr.payout_method,
    'reference', wr.fin_ops_reference,
    'processed_at', wr.processed_at,
    'recipient_name', recipient_name,
    'processor_name', processor_name,
    'processor_phone', processor_phone,
    'merchant_branch', merchant_branch,
    'reason', wr.reason,
    'bank_name', CASE WHEN pm LIKE '%bank%' THEN wr.bank_name ELSE NULL END,
    'bank_account_number', CASE WHEN pm LIKE '%bank%' THEN wr.bank_account_number ELSE NULL END,
    'bank_account_name', CASE WHEN pm LIKE '%bank%' THEN wr.bank_account_name ELSE NULL END,
    'mobile_money_number', CASE WHEN pm LIKE '%bank%' THEN NULL ELSE wr.mobile_money_number END,
    'mobile_money_name', CASE WHEN pm LIKE '%bank%' THEN NULL ELSE wr.mobile_money_name END,
    'mobile_money_provider', CASE WHEN pm LIKE '%bank%' THEN NULL ELSE wr.mobile_money_provider END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_payout_receipt(uuid) TO anon, authenticated, service_role;
