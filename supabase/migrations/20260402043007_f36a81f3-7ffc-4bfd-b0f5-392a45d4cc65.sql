
-- Phase 1: Expand event types enum
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'deposit_approved';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'deposit_rejected';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'withdrawal_requested';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'withdrawal_approved';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'withdrawal_rejected';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'wallet_transfer';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'portfolio_topup';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'rent_disbursed';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'roi_distributed';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'loan_approved';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'loan_rejected';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'expense_transfer';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'agent_collection';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'role_changed';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'user_deleted';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'password_reset';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'login_success';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'listing_created';
ALTER TYPE system_event_type ADD VALUE IF NOT EXISTS 'listing_approved';

-- Phase 2: Fix retention policy — preserve financial events permanently
CREATE OR REPLACE FUNCTION public.cleanup_old_system_events()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.system_events
  WHERE created_at < now() - interval '7 days'
  AND event_type::text NOT IN (
    'payment_made','payment_missed','funds_added','funds_withdrawn',
    'deposit_approved','deposit_rejected',
    'withdrawal_approved','withdrawal_rejected',
    'wallet_transfer','portfolio_topup','rent_disbursed',
    'roi_distributed','loan_approved','loan_rejected',
    'agent_collection','expense_transfer'
  );
END;
$$;

-- Phase 5: Auto-logging triggers on critical tables

-- Trigger function for deposit_requests status changes
CREATE OR REPLACE FUNCTION public.log_deposit_status_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'approved' THEN
      PERFORM public.log_system_event(
        'deposit_approved'::system_event_type,
        COALESCE(NEW.processed_by, NEW.user_id),
        'deposit_requests',
        NEW.id::text,
        jsonb_build_object('amount', NEW.amount, 'user_id', NEW.user_id)
      );
    ELSIF NEW.status = 'rejected' THEN
      PERFORM public.log_system_event(
        'deposit_rejected'::system_event_type,
        COALESCE(NEW.processed_by, NEW.user_id),
        'deposit_requests',
        NEW.id::text,
        jsonb_build_object('amount', NEW.amount, 'user_id', NEW.user_id)
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_deposit_status ON public.deposit_requests;
CREATE TRIGGER trg_log_deposit_status
  AFTER UPDATE ON public.deposit_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.log_deposit_status_event();

-- Trigger function for withdrawal_requests status changes
CREATE OR REPLACE FUNCTION public.log_withdrawal_status_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'approved' OR NEW.status = 'completed' THEN
      PERFORM public.log_system_event(
        'withdrawal_approved'::system_event_type,
        COALESCE(NEW.processed_by, NEW.user_id),
        'withdrawal_requests',
        NEW.id::text,
        jsonb_build_object('amount', NEW.amount, 'user_id', NEW.user_id)
      );
    ELSIF NEW.status = 'rejected' THEN
      PERFORM public.log_system_event(
        'withdrawal_rejected'::system_event_type,
        COALESCE(NEW.processed_by, NEW.user_id),
        'withdrawal_requests',
        NEW.id::text,
        jsonb_build_object('amount', NEW.amount, 'user_id', NEW.user_id, 'reason', NEW.rejection_reason)
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_withdrawal_status ON public.withdrawal_requests;
CREATE TRIGGER trg_log_withdrawal_status
  AFTER UPDATE ON public.withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.log_withdrawal_status_event();

-- Trigger function for general_ledger wallet_transfer inserts
CREATE OR REPLACE FUNCTION public.log_ledger_wallet_transfer_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.category = 'wallet_transfer' AND NEW.direction = 'cash_out' THEN
    PERFORM public.log_system_event(
      'wallet_transfer'::system_event_type,
      NEW.user_id,
      'general_ledger',
      NEW.id::text,
      jsonb_build_object('amount', NEW.amount, 'transaction_group_id', NEW.transaction_group_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_ledger_wallet_transfer ON public.general_ledger;
CREATE TRIGGER trg_log_ledger_wallet_transfer
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.log_ledger_wallet_transfer_event();
