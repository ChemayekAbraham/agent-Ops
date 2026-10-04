CREATE OR REPLACE FUNCTION public.guard_rent_request_agent_updates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_repayment_delta numeric := COALESCE(NEW.amount_repaid, 0) - COALESCE(OLD.amount_repaid, 0);
  v_current_tx_float_debit numeric := 0;
  v_trusted_allocation boolean := false;
  v_expected_status text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_sensitive_field_editor(v_uid)
     OR public.has_role(v_uid, 'manager'::app_role) THEN
    RETURN NEW;
  END IF;

  IF NOT (public.has_role(v_uid, 'agent'::app_role)
          OR public.has_role(v_uid, 'senior_agent'::app_role)
          OR public.has_role(v_uid, 'sub_agent'::app_role)) THEN
    RETURN NEW;
  END IF;

  IF v_repayment_delta > 0
     AND OLD.agent_id = v_uid
     AND NEW.agent_id = OLD.agent_id
     AND NEW.tenant_id = OLD.tenant_id
     AND NEW.total_repayment = OLD.total_repayment THEN
    SELECT COALESCE(sum(gl.amount), 0)
      INTO v_current_tx_float_debit
      FROM public.general_ledger gl
     WHERE gl.source_table = 'agent_collections'
       AND gl.source_id = OLD.id
       AND gl.user_id = v_uid
       AND gl.category = 'agent_float_used_for_rent'
       AND gl.direction = 'cash_out'
       AND gl.ledger_scope = 'wallet'
       AND gl.wallet_bucket = 'float'
       AND gl.recipient_type = 'operational_wallet'
       AND gl.xmin::text::bigint = txid_current();

    v_expected_status := CASE
      WHEN COALESCE(NEW.amount_repaid, 0) >= COALESCE(NEW.total_repayment, 0)
        THEN 'completed'
      WHEN OLD.status IN ('disbursed', 'funded', 'approved')
        THEN 'repaying'
      ELSE OLD.status
    END;

    v_trusted_allocation :=
      v_current_tx_float_debit = v_repayment_delta
      AND COALESCE(NEW.amount_repaid, 0) <= COALESCE(NEW.total_repayment, 0)
      AND NEW.status = v_expected_status;
  END IF;

  NEW.approved_by := OLD.approved_by;
  NEW.approved_at := OLD.approved_at;
  NEW.funded_at := OLD.funded_at;
  NEW.disbursed_at := OLD.disbursed_at;
  NEW.fund_routed_at := OLD.fund_routed_at;
  NEW.fund_recipient_id := OLD.fund_recipient_id;
  NEW.fund_recipient_type := OLD.fund_recipient_type;
  NEW.fund_recipient_name := OLD.fund_recipient_name;
  NEW.manager_verified := OLD.manager_verified;
  NEW.manager_verified_at := OLD.manager_verified_at;
  NEW.manager_verified_by := OLD.manager_verified_by;

  IF NOT v_trusted_allocation THEN
    NEW.amount_repaid := OLD.amount_repaid;
    NEW.last_payment_amount := OLD.last_payment_amount;
  END IF;

  -- Resubmission safety net: an owning agent moving a REJECTED request back
  -- into the pipeline may only send it to the very first desk. Older app
  -- builds still try to restore the desk that rejected it (e.g.
  -- agent_ops_approved) — silently downgrade instead of failing the click.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND OLD.status = 'rejected'
     AND OLD.agent_id = v_uid
     AND NEW.status <> 'repaying'
     AND NEW.status <> 'deleted_by_agent' THEN
    NEW.status := 'pending';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      v_trusted_allocation
      OR NEW.status IN ('pending', 'rejected', 'deleted_by_agent')
      OR (OLD.status = 'rejected' AND NEW.status = 'repaying')
    ) THEN
      RAISE EXCEPTION 'Agents cannot move a rent request from % to %', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;