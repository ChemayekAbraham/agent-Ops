CREATE TABLE IF NOT EXISTS public.portfolio_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  portfolio_id uuid,
  portfolio_code text,
  partner_id uuid,
  partner_name text,
  changed_fields text[] NOT NULL DEFAULT '{}',
  before_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.portfolio_change_log TO authenticated;
GRANT ALL ON public.portfolio_change_log TO service_role;

ALTER TABLE public.portfolio_change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops and executives can read portfolio change log"
ON public.portfolio_change_log
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'partner_ops')
  OR public.has_role(auth.uid(), 'financial_ops')
);

CREATE INDEX IF NOT EXISTS idx_portfolio_change_log_unnotified
  ON public.portfolio_change_log (changed_at DESC) WHERE notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_portfolio_change_log_portfolio
  ON public.portfolio_change_log (portfolio_id, changed_at DESC);

-- Fire the notifier edge function immediately after a logged change.
CREATE OR REPLACE FUNCTION public.dispatch_portfolio_change_notice()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
    IF v_key IS NULL THEN
      SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1;
    END IF;
    IF v_key IS NOT NULL THEN
      PERFORM net.http_post(
        url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/portfolio-change-notify',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
        body := '{}'::jsonb
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[dispatch_portfolio_change_notice] dispatch failed: %', SQLERRM;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_portfolio_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text;
  v_fields text[] := '{}';
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_row record;
  v_name text;
  v_hint text;
BEGIN
  v_row := COALESCE(NEW, OLD);
  BEGIN
    v_hint := NULLIF(current_setting('app.portfolio_action', true), '');
  EXCEPTION WHEN OTHERS THEN v_hint := NULL; END;

  IF TG_OP = 'INSERT' THEN
    v_action := 'portfolio_created';
    v_after := jsonb_build_object(
      'investment_amount', NEW.investment_amount,
      'contribution_date', NEW.created_at,
      'roi_percentage', NEW.roi_percentage,
      'duration_months', NEW.duration_months,
      'status', NEW.status
    );
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'portfolio_deleted';
    v_before := jsonb_build_object(
      'investment_amount', OLD.investment_amount,
      'contribution_date', OLD.created_at,
      'roi_percentage', OLD.roi_percentage,
      'duration_months', OLD.duration_months,
      'status', OLD.status
    );
  ELSE
    IF NEW.investment_amount IS DISTINCT FROM OLD.investment_amount THEN
      v_fields := v_fields || 'investment_amount';
      v_before := v_before || jsonb_build_object('investment_amount', OLD.investment_amount);
      v_after := v_after || jsonb_build_object('investment_amount', NEW.investment_amount);
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      v_fields := v_fields || 'contribution_date';
      v_before := v_before || jsonb_build_object('contribution_date', OLD.created_at);
      v_after := v_after || jsonb_build_object('contribution_date', NEW.created_at);
    END IF;
    IF NEW.roi_percentage IS DISTINCT FROM OLD.roi_percentage THEN
      v_fields := v_fields || 'roi_percentage';
      v_before := v_before || jsonb_build_object('roi_percentage', OLD.roi_percentage);
      v_after := v_after || jsonb_build_object('roi_percentage', NEW.roi_percentage);
    END IF;
    IF NEW.duration_months IS DISTINCT FROM OLD.duration_months THEN
      v_fields := v_fields || 'duration_months';
      v_before := v_before || jsonb_build_object('duration_months', OLD.duration_months);
      v_after := v_after || jsonb_build_object('duration_months', NEW.duration_months);
    END IF;
    IF NEW.maturity_date IS DISTINCT FROM OLD.maturity_date THEN
      v_fields := v_fields || 'maturity_date';
      v_before := v_before || jsonb_build_object('maturity_date', OLD.maturity_date);
      v_after := v_after || jsonb_build_object('maturity_date', NEW.maturity_date);
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      v_fields := v_fields || 'status';
      v_before := v_before || jsonb_build_object('status', OLD.status);
      v_after := v_after || jsonb_build_object('status', NEW.status);
    END IF;
    IF NEW.total_roi_earned IS DISTINCT FROM OLD.total_roi_earned
       AND COALESCE(NEW.total_roi_earned, 0) = 0
       AND COALESCE(OLD.total_roi_earned, 0) > 0 THEN
      v_fields := v_fields || 'total_roi_earned';
      v_before := v_before || jsonb_build_object('total_roi_earned', OLD.total_roi_earned);
      v_after := v_after || jsonb_build_object('total_roi_earned', NEW.total_roi_earned);
    END IF;

    IF array_length(v_fields, 1) IS NULL THEN
      RETURN NEW;
    END IF;

    -- Classify: explicit caller hint wins, otherwise infer from the diff.
    IF v_hint IS NOT NULL THEN
      v_action := v_hint;
    ELSIF NEW.status IS DISTINCT FROM OLD.status
          AND NEW.status IN ('suspended', 'paused') THEN
      v_action := 'portfolio_suspended';
    ELSIF 'contribution_date' = ANY(v_fields) AND 'maturity_date' = ANY(v_fields) THEN
      v_action := 'portfolio_renewed';
    ELSIF 'investment_amount' = ANY(v_fields)
          AND COALESCE(NEW.investment_amount, 0) > COALESCE(OLD.investment_amount, 0)
          AND 'total_roi_earned' = ANY(v_fields) THEN
      v_action := 'portfolio_compounded';
    ELSIF 'investment_amount' = ANY(v_fields)
          AND COALESCE(NEW.investment_amount, 0) > COALESCE(OLD.investment_amount, 0) THEN
      v_action := 'portfolio_topped_up';
    ELSIF 'investment_amount' = ANY(v_fields) THEN
      v_action := 'portfolio_principal_edited';
    ELSIF 'contribution_date' = ANY(v_fields) THEN
      v_action := 'portfolio_contribution_date_edited';
    ELSIF 'roi_percentage' = ANY(v_fields) OR 'duration_months' = ANY(v_fields) THEN
      v_action := 'portfolio_terms_edited';
    ELSE
      v_action := 'portfolio_updated';
    END IF;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_row.investor_id;

  INSERT INTO public.portfolio_change_log (
    action, portfolio_id, portfolio_code, partner_id, partner_name,
    changed_fields, before_values, after_values, changed_by
  ) VALUES (
    v_action, v_row.id, v_row.portfolio_code, v_row.investor_id, v_name,
    v_fields, v_before, v_after, auth.uid()
  );

  PERFORM public.dispatch_portfolio_change_notice();

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_log_portfolio_change ON public.investor_portfolios;
CREATE TRIGGER trg_log_portfolio_change
AFTER INSERT OR UPDATE OR DELETE ON public.investor_portfolios
FOR EACH ROW EXECUTE FUNCTION public.log_portfolio_change();

-- Partner account suspension / reinstatement
CREATE OR REPLACE FUNCTION public.log_partner_suspension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_partner boolean;
BEGIN
  IF NEW.frozen_at IS NOT DISTINCT FROM OLD.frozen_at THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = NEW.id AND ur.role IN ('supporter', 'partner_ops')
  ) OR EXISTS (
    SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = NEW.id
  ) INTO v_is_partner;

  IF NOT v_is_partner THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.portfolio_change_log (
    action, partner_id, partner_name, changed_fields, before_values, after_values, changed_by
  ) VALUES (
    CASE WHEN NEW.frozen_at IS NOT NULL THEN 'partner_suspended' ELSE 'partner_reinstated' END,
    NEW.id, NEW.full_name, ARRAY['frozen_at'],
    jsonb_build_object('frozen_at', OLD.frozen_at, 'frozen_reason', OLD.frozen_reason),
    jsonb_build_object('frozen_at', NEW.frozen_at, 'frozen_reason', NEW.frozen_reason),
    auth.uid()
  );

  PERFORM public.dispatch_portfolio_change_notice();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_partner_suspension ON public.profiles;
CREATE TRIGGER trg_log_partner_suspension
AFTER UPDATE OF frozen_at ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.log_partner_suspension();