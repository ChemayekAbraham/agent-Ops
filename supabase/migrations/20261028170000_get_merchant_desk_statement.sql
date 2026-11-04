-- Merchant desk statement: one day of a merchant agent's desk, laid out like the paper the agent keeps.
--
--   opening float
--   + received from the company          (float deliveries)
--   +/- set by hand                       (corrections that moved the float up or down)
--   - paid out to customers               (from float)
--   - telecom charges taken from float
--   - returned to the company             (any phone number, once booked)
--   = closing float
-- then what the company owes the agent for own-money (OOP) payouts, and the net: closing float minus what we owe her.
--
-- Read only. Every figure comes from the same ledger rows and tables the float and the OOP review already use, so it cannot disagree with them.
-- "other_movements" is whatever moved the float that is not one of the lines above (should be 0); if it is not, the statement says so.
-- Finance roles only (same check as get_merchant_float_positions). Day is the Kampala calendar day.
-- Roll back with 20261028170000_get_merchant_desk_statement.rollback.sql.

CREATE OR REPLACE FUNCTION public.get_merchant_desk_statement(p_agent_id uuid, p_day date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_day  date := COALESCE(p_day, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_d0   timestamptz := (v_day::text || ' 00:00 Africa/Kampala')::timestamptz;
  v_d1   timestamptz := ((v_day + 1)::text || ' 00:00 Africa/Kampala')::timestamptz;
  v_name text;
  v_open numeric;
  v_close numeric;
  v_deliv numeric;
  v_up numeric;
  v_down numeric;
  v_paid numeric;
  v_paid_n integer;
  v_tele numeric;
  v_ret numeric;
  v_ret_n integer;
  v_other numeric;
  v_oop_new numeric; v_oop_new_n integer;
  v_oop_owed numeric; v_oop_owed_n integer;
  v_oop_tele numeric; v_oop_tele_n integer;
  v_oop_paid numeric;
BEGIN
  PERFORM public.assert_financial_ops_area('float');

  SELECT full_name INTO v_name FROM profiles WHERE id = p_agent_id;

  SELECT COALESCE(SUM(CASE WHEN direction IN ('cash_in', 'credit') THEN amount ELSE -amount END), 0) INTO v_open
    FROM general_ledger
   WHERE user_id = p_agent_id AND ledger_scope = 'wallet' AND wallet_bucket = 'float' AND transaction_date < v_d0;

  SELECT COALESCE(SUM(CASE WHEN direction IN ('cash_in', 'credit') THEN amount ELSE -amount END), 0) INTO v_close
    FROM general_ledger
   WHERE user_id = p_agent_id AND ledger_scope = 'wallet' AND wallet_bucket = 'float' AND transaction_date < v_d1;

  WITH fl AS (
    SELECT * FROM general_ledger
     WHERE user_id = p_agent_id AND ledger_scope = 'wallet' AND wallet_bucket = 'float'
       AND transaction_date >= v_d0 AND transaction_date < v_d1
  )
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE category = 'agent_float_deposit' AND direction = 'cash_in' AND description NOT ILIKE 'Merchant desk float set to%'), 0),
    COALESCE(SUM(amount) FILTER (WHERE category = 'agent_float_deposit' AND direction = 'cash_in' AND description ILIKE 'Merchant desk float set to%'), 0),
    COALESCE(SUM(amount) FILTER (WHERE category = 'system_balance_correction' AND direction = 'cash_out'), 0),
    COALESCE(SUM(amount) FILTER (WHERE category = 'agent_float_settlement' AND direction = 'cash_out' AND description NOT ILIKE 'Telecom%'), 0),
    COUNT(*) FILTER (WHERE category = 'agent_float_settlement' AND direction = 'cash_out' AND description NOT ILIKE 'Telecom%'),
    COALESCE(SUM(amount) FILTER (WHERE category = 'agent_float_settlement' AND direction = 'cash_out' AND description ILIKE 'Telecom%'), 0),
    COALESCE(SUM(amount) FILTER (WHERE category = 'merchant_float_correction_writedown' AND direction = 'cash_out'), 0),
    COUNT(*) FILTER (WHERE category = 'merchant_float_correction_writedown' AND direction = 'cash_out')
  INTO v_deliv, v_up, v_down, v_paid, v_paid_n, v_tele, v_ret, v_ret_n
  FROM fl;

  v_other := v_close - (v_open + v_deliv + v_up - v_down - v_paid - v_tele - v_ret);

  SELECT COALESCE(SUM(shortfall_amount), 0), COUNT(*) INTO v_oop_new, v_oop_new_n
    FROM merchant_out_of_pocket_advances
   WHERE agent_id = p_agent_id AND kind = 'payout' AND status <> 'rejected'
     AND created_at >= v_d0 AND created_at < v_d1;

  SELECT COALESCE(SUM(shortfall_amount), 0), COUNT(*) INTO v_oop_owed, v_oop_owed_n
    FROM merchant_out_of_pocket_advances
   WHERE agent_id = p_agent_id AND kind = 'payout' AND status IN ('pending_reimbursement', 'needs_review');

  SELECT COALESCE(SUM(shortfall_amount), 0), COUNT(*) INTO v_oop_tele, v_oop_tele_n
    FROM merchant_out_of_pocket_advances
   WHERE agent_id = p_agent_id AND kind = 'telecom' AND status IN ('pending_reimbursement', 'needs_review');

  SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_oop_paid
    FROM merchant_out_of_pocket_advances
   WHERE agent_id = p_agent_id AND status = 'reimbursed' AND reimbursed_at >= v_d0 AND reimbursed_at < v_d1;

  RETURN jsonb_build_object(
    'agent_id', p_agent_id,
    'agent_name', v_name,
    'day', v_day,
    'opening_float', v_open,
    'received_from_company', v_deliv,
    'float_set_up_by_hand', v_up,
    'float_set_down_by_hand', v_down,
    'paid_out_from_float', v_paid,
    'paid_out_count', v_paid_n,
    'telecom_from_float', v_tele,
    'returned_to_company', v_ret,
    'returned_count', v_ret_n,
    'other_movements', v_other,
    'closing_float', v_close,
    'oop_opened_today', v_oop_new,
    'oop_opened_today_count', v_oop_new_n,
    'oop_owed_payouts', v_oop_owed,
    'oop_owed_payouts_count', v_oop_owed_n,
    'oop_owed_telecom', v_oop_tele,
    'oop_owed_telecom_count', v_oop_tele_n,
    'oop_reimbursed_today', v_oop_paid,
    'net_company_owes_agent', v_oop_owed - v_close
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_merchant_desk_statement(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_merchant_desk_statement(uuid, date) TO authenticated, service_role;
