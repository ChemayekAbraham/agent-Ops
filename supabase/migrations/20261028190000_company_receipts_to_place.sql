-- Receipts finance has to place: money that reached a company MTN/Airtel line from a merchant desk but never cut that desk's float.
--
-- WHY: the automatic float return matches the SENDER'S PHONE to a profile. When a merchant sends from another number (Immaculate Namulindwa, 28 Oct: 10M
-- from 741003567 and 752383262), the receipt is either booked to a different profile as "no_float" (nothing written down) or not booked at all. Every
-- such case was found and fixed by hand with SQL. This adds the screen's backend so finance does it in the app, in one tap, with a reason on file.
--
-- WHAT THIS ADDS (nothing existing is changed, no money moves by itself):
--   merchant_desk_phone_numbers   extra phone numbers a desk sends from; the list below pre-selects that desk for them
--   company_receipt_dismissals    receipts finance says are NOT a desk's float return (so they leave the list), with the reason
--   get_company_receipts_to_place(p_days)      the list: (a) inbound MTN/Airtel receipts of UGX 1M+ that nothing has claimed, and
--                                              (b) returns booked to a desk as "no_float"/"partial" with nothing written down
--   place_company_receipt_as_float_return(...) books one receipt as that desk's float return, exactly as the automatic job does
--                                              (it calls auto_record_merchant_float_return); moves a wrongly booked "no_float" one first
--   dismiss_company_receipt(...), register_merchant_desk_number(...), remove_merchant_desk_number(...)
-- Finance roles only (assert_financial_ops_area('float')). Nobody can place a receipt on their own desk.
-- Roll back with 20261028190000_company_receipts_to_place.rollback.sql.

CREATE TABLE IF NOT EXISTS public.merchant_desk_phone_numbers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL,
  phone9     text NOT NULL CHECK (phone9 ~ '^[0-9]{9}$'),
  label      text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_desk_phone_numbers_phone9_key UNIQUE (phone9)
);
CREATE INDEX IF NOT EXISTS merchant_desk_phone_numbers_agent_idx ON public.merchant_desk_phone_numbers (agent_id);
ALTER TABLE public.merchant_desk_phone_numbers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.merchant_desk_phone_numbers FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.company_receipt_dismissals (
  gmail_transaction_id uuid PRIMARY KEY,
  reason       text NOT NULL CHECK (length(btrim(reason)) >= 5),
  dismissed_by uuid,
  dismissed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.company_receipt_dismissals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_receipt_dismissals FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_company_receipts_to_place(p_days integer DEFAULT 14)
 RETURNS TABLE(
   gmail_transaction_id uuid, received_at timestamptz, channel text, amount numeric, transaction_id text,
   counterparty text, counterparty_name text, kind text,
   booked_agent_id uuid, booked_agent_name text, excess_amount numeric,
   suggested_agent_id uuid, suggested_agent_name text, times_seen bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 14), 1), 60));
BEGIN
  PERFORM public.assert_financial_ops_area('float');

  RETURN QUERY
  WITH base AS (
    SELECT g.id AS gid, g.internal_date AS at, g.channel AS ch, g.amount AS amt, g.transaction_id AS tid,
           g.counterparty AS cp, g.counterparty_name AS cpn, 'unmatched'::text AS kd,
           NULL::uuid AS booked, 0::numeric AS excess
      FROM gmail_transactions g
     WHERE g.direction IN ('in', 'credit') AND g.parsed IS TRUE
       AND g.channel IN ('airtel_money', 'mtn_momo') AND g.amount >= 1000000 AND g.internal_date >= v_since
       AND g.linked_deposit_request_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM deposit_requests d WHERE lower(btrim(d.transaction_id)) = lower(btrim(g.transaction_id)))
       AND NOT EXISTS (SELECT 1 FROM ledger_reconciled_tids l WHERE l.tid_normalized = regexp_replace(g.transaction_id, '[^0-9]', '', 'g'))
       AND NOT EXISTS (SELECT 1 FROM merchant_float_returns r WHERE r.gmail_transaction_id = g.id)
    UNION ALL
    SELECT g.id, g.internal_date, g.channel, g.amount, g.transaction_id, g.counterparty, g.counterparty_name,
           'no_float_return', r.agent_id, r.excess_amount
      FROM merchant_float_returns r
      JOIN gmail_transactions g ON g.id = r.gmail_transaction_id
     WHERE r.status IN ('no_float', 'partial') AND r.excess_amount > 0 AND r.created_at >= v_since AND r.ledger_group_id IS NULL
  )
  SELECT b.gid, b.at, b.ch, b.amt, b.tid, b.cp, b.cpn, b.kd, b.booked, bp.full_name, b.excess,
         dn.agent_id, sp.full_name,
         count(*) OVER (PARTITION BY b.cp)
    FROM base b
    LEFT JOIN profiles bp ON bp.id = b.booked
    LEFT JOIN merchant_desk_phone_numbers dn ON dn.phone9 = right(regexp_replace(COALESCE(b.cp, ''), '[^0-9]', '', 'g'), 9)
    LEFT JOIN profiles sp ON sp.id = dn.agent_id
   WHERE NOT EXISTS (SELECT 1 FROM company_receipt_dismissals x WHERE x.gmail_transaction_id = b.gid)
   ORDER BY b.at DESC
   LIMIT 200;
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_company_receipt_as_float_return(
  p_gmail_transaction_id uuid, p_agent_id uuid, p_remember_number boolean DEFAULT true, p_note text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_tx record;
  v_old record;
  v_norm text;
  v_phone9 text;
  v_result jsonb;
BEGIN
  PERFORM public.assert_financial_ops_area('float');
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_actor = p_agent_id THEN
    RAISE EXCEPTION 'You cannot place a receipt on your own desk.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cashout_agents WHERE agent_id = p_agent_id AND is_active IS TRUE) THEN
    RAISE EXCEPTION 'That agent has no active merchant desk.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('merchant_float_return:' || p_agent_id::text));

  SELECT id, direction, parsed, amount, transaction_id, counterparty INTO v_tx
    FROM gmail_transactions WHERE id = p_gmail_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That receipt was not found.'; END IF;
  IF v_tx.direction NOT IN ('in', 'credit') OR v_tx.parsed IS NOT TRUE THEN
    RAISE EXCEPTION 'That is not an inbound receipt.';
  END IF;
  v_norm := regexp_replace(COALESCE(v_tx.transaction_id, ''), '[^0-9]', '', 'g');

  SELECT * INTO v_old FROM merchant_float_returns WHERE gmail_transaction_id = v_tx.id;
  IF FOUND THEN
    IF v_old.agent_id = p_agent_id THEN
      RETURN jsonb_build_object('ok', true, 'outcome', 'already_recorded', 'return_id', v_old.id, 'status', v_old.status);
    END IF;
    IF v_old.amount_written_down <> 0 OR v_old.ledger_group_id IS NOT NULL THEN
      RAISE EXCEPTION 'That receipt already cut another desk''s float. Reverse that first.';
    END IF;
    -- Booked to the wrong desk as "no_float" with nothing written down: remove that empty booking so it can be booked properly.
    DELETE FROM ledger_reconciled_tids WHERE tid_normalized = v_norm AND source = 'merchant_float_return' AND source_id = v_old.id;
    DELETE FROM merchant_float_returns WHERE id = v_old.id;
  END IF;

  v_result := public.auto_record_merchant_float_return(v_tx.id, p_agent_id, 'manual_queue');
  IF COALESCE((v_result ->> 'ok')::boolean, false) IS NOT TRUE THEN
    -- Undo the move above as well: nothing changes unless the booking worked.
    RAISE EXCEPTION 'The receipt could not be booked: %', COALESCE(v_result ->> 'outcome', 'unknown');
  END IF;

  UPDATE deposit_match_alerts SET resolved_at = now()
   WHERE alert_type = 'merchant_float_return' AND subject_id = v_tx.id AND resolved_at IS NULL;
  DELETE FROM company_receipt_dismissals WHERE gmail_transaction_id = v_tx.id;

  v_phone9 := right(regexp_replace(COALESCE(v_tx.counterparty, ''), '[^0-9]', '', 'g'), 9);
  IF p_remember_number AND v_phone9 ~ '^[0-9]{9}$' THEN
    INSERT INTO merchant_desk_phone_numbers (agent_id, phone9, label, created_by)
    VALUES (p_agent_id, v_phone9, 'Learned from receipt ' || v_tx.transaction_id, v_actor)
    ON CONFLICT (phone9) DO NOTHING;
  END IF;

  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'merchant_float_return_placed', 'merchant_float_returns', (v_result ->> 'return_id')::uuid,
          jsonb_build_object('agent_id', p_agent_id, 'gmail_transaction_id', v_tx.id, 'tid', v_tx.transaction_id,
                             'amount', v_tx.amount, 'moved_from', v_old.agent_id, 'note', p_note, 'result', v_result));

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dismiss_company_receipt(p_gmail_transaction_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.assert_financial_ops_area('float');
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN RAISE EXCEPTION 'reason_required_min_5_chars'; END IF;
  INSERT INTO company_receipt_dismissals (gmail_transaction_id, reason, dismissed_by)
  VALUES (p_gmail_transaction_id, btrim(p_reason), auth.uid())
  ON CONFLICT (gmail_transaction_id) DO UPDATE SET reason = excluded.reason, dismissed_by = excluded.dismissed_by, dismissed_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.register_merchant_desk_number(p_agent_id uuid, p_phone text, p_label text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_phone9 text := right(regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g'), 9);
BEGIN
  PERFORM public.assert_financial_ops_area('float');
  IF v_phone9 !~ '^[0-9]{9}$' THEN RAISE EXCEPTION 'That is not a phone number.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cashout_agents WHERE agent_id = p_agent_id AND is_active IS TRUE) THEN
    RAISE EXCEPTION 'That agent has no active merchant desk.';
  END IF;
  INSERT INTO merchant_desk_phone_numbers (agent_id, phone9, label, created_by)
  VALUES (p_agent_id, v_phone9, p_label, auth.uid())
  ON CONFLICT (phone9) DO UPDATE SET agent_id = excluded.agent_id, label = COALESCE(excluded.label, merchant_desk_phone_numbers.label);
  RETURN jsonb_build_object('ok', true, 'phone9', v_phone9);
END;
$function$;

CREATE OR REPLACE FUNCTION public.remove_merchant_desk_number(p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.assert_financial_ops_area('float');
  DELETE FROM merchant_desk_phone_numbers WHERE phone9 = right(regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g'), 9);
  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_company_receipts_to_place(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.place_company_receipt_as_float_return(uuid, uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dismiss_company_receipt(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_merchant_desk_number(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_merchant_desk_number(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_company_receipts_to_place(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.place_company_receipt_as_float_return(uuid, uuid, boolean, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dismiss_company_receipt(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_merchant_desk_number(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_merchant_desk_number(text) TO authenticated, service_role;
