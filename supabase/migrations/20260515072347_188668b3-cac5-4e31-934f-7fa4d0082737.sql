
-- 1) Commission paid notification
CREATE OR REPLACE FUNCTION public.notify_agent_commission_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.category = 'agent_commission_earned'
     AND NEW.ledger_scope = 'wallet'
     AND NEW.direction = 'cash_in'
     AND NEW.user_id IS NOT NULL
     AND COALESCE(NEW.classification, 'production') NOT IN ('admin_correction')
     AND NEW.amount > 0 THEN

    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.user_id,
      '💰 Commission Paid',
      'You earned UGX ' || to_char(NEW.amount, 'FM999,999,990') ||
      ' commission. ' || COALESCE(NEW.description, ''),
      'success',
      jsonb_build_object(
        'event', 'commission_paid',
        'amount', NEW.amount,
        'ledger_id', NEW.id,
        'source_table', NEW.source_table,
        'source_id', NEW.source_id,
        'send_push', true
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_agent_commission_paid ON public.general_ledger;
CREATE TRIGGER trg_notify_agent_commission_paid
AFTER INSERT ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.notify_agent_commission_paid();


-- 2) Advance issued notification
CREATE OR REPLACE FUNCTION public.notify_agent_advance_issued()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total_repay numeric;
BEGIN
  total_repay := COALESCE(NEW.principal,0) + COALESCE(NEW.access_fee, NEW.principal * NEW.monthly_rate, 0);

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  VALUES (
    NEW.agent_id,
    '🏦 Advance Issued',
    'Your advance of UGX ' || to_char(NEW.principal, 'FM999,999,990') ||
    ' is active. Total to repay: UGX ' || to_char(total_repay, 'FM999,999,990') ||
    ' over ' || NEW.cycle_days || ' days.',
    'info',
    jsonb_build_object(
      'event', 'advance_issued',
      'advance_id', NEW.id,
      'principal', NEW.principal,
      'total_repayable', total_repay,
      'expires_at', NEW.expires_at,
      'send_push', true
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_agent_advance_issued ON public.agent_advances;
CREATE TRIGGER trg_notify_agent_advance_issued
AFTER INSERT ON public.agent_advances
FOR EACH ROW
EXECUTE FUNCTION public.notify_agent_advance_issued();


-- 3) Advance deducted notification
CREATE OR REPLACE FUNCTION public.notify_agent_advance_deducted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id uuid;
BEGIN
  IF NEW.amount_deducted IS NULL OR NEW.amount_deducted <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT agent_id INTO v_agent_id FROM public.agent_advances WHERE id = NEW.advance_id;
  IF v_agent_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  VALUES (
    v_agent_id,
    '↩️ Advance Repayment',
    'UGX ' || to_char(NEW.amount_deducted, 'FM999,999,990') ||
    ' deducted from your wallet toward your advance. Remaining balance: UGX ' ||
    to_char(NEW.closing_balance, 'FM999,999,990') || '.',
    CASE WHEN NEW.closing_balance <= 0 THEN 'success' ELSE 'info' END,
    jsonb_build_object(
      'event', 'advance_deducted',
      'advance_id', NEW.advance_id,
      'amount_deducted', NEW.amount_deducted,
      'closing_balance', NEW.closing_balance,
      'deduction_status', NEW.deduction_status,
      'send_push', true
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_agent_advance_deducted ON public.agent_advance_ledger;
CREATE TRIGGER trg_notify_agent_advance_deducted
AFTER INSERT ON public.agent_advance_ledger
FOR EACH ROW
EXECUTE FUNCTION public.notify_agent_advance_deducted();
