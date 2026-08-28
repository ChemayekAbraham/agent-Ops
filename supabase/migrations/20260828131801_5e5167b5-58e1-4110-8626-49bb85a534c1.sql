CREATE OR REPLACE FUNCTION public.log_portfolio_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      v_fields := v_fields || 'investment_amount'::text;
      v_before := v_before || jsonb_build_object('investment_amount', OLD.investment_amount);
      v_after := v_after || jsonb_build_object('investment_amount', NEW.investment_amount);
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      v_fields := v_fields || 'contribution_date'::text;
      v_before := v_before || jsonb_build_object('contribution_date', OLD.created_at);
      v_after := v_after || jsonb_build_object('contribution_date', NEW.created_at);
    END IF;
    IF NEW.roi_percentage IS DISTINCT FROM OLD.roi_percentage THEN
      v_fields := v_fields || 'roi_percentage'::text;
      v_before := v_before || jsonb_build_object('roi_percentage', OLD.roi_percentage);
      v_after := v_after || jsonb_build_object('roi_percentage', NEW.roi_percentage);
    END IF;
    IF NEW.duration_months IS DISTINCT FROM OLD.duration_months THEN
      v_fields := v_fields || 'duration_months'::text;
      v_before := v_before || jsonb_build_object('duration_months', OLD.duration_months);
      v_after := v_after || jsonb_build_object('duration_months', NEW.duration_months);
    END IF;
    IF NEW.maturity_date IS DISTINCT FROM OLD.maturity_date THEN
      v_fields := v_fields || 'maturity_date'::text;
      v_before := v_before || jsonb_build_object('maturity_date', OLD.maturity_date);
      v_after := v_after || jsonb_build_object('maturity_date', NEW.maturity_date);
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      v_fields := v_fields || 'status'::text;
      v_before := v_before || jsonb_build_object('status', OLD.status);
      v_after := v_after || jsonb_build_object('status', NEW.status);
    END IF;
    IF NEW.total_roi_earned IS DISTINCT FROM OLD.total_roi_earned
       AND COALESCE(NEW.total_roi_earned, 0) = 0
       AND COALESCE(OLD.total_roi_earned, 0) > 0 THEN
      v_fields := v_fields || 'total_roi_earned'::text;
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
$function$;