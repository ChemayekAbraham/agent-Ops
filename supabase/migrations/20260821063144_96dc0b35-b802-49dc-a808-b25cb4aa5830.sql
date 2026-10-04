CREATE OR REPLACE FUNCTION public.guard_landlord_payment_edit_agent_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_ops boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_ops := has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'financial_ops'::app_role);

  IF v_is_ops THEN
    RETURN NEW;
  END IF;

  IF NEW.agent_id = auth.uid() THEN
    -- Agents may only record their own response; every financial /
    -- ops-controlled field is forced back to its stored value.
    NEW.edit_type := OLD.edit_type;
    NEW.rent_request_id := OLD.rent_request_id;
    NEW.payout_id := OLD.payout_id;
    NEW.tenant_id := OLD.tenant_id;
    NEW.agent_id := OLD.agent_id;
    NEW.landlord_name := OLD.landlord_name;
    NEW.old_amount := OLD.old_amount;
    NEW.new_amount := OLD.new_amount;
    NEW.reason := OLD.reason;
    NEW.edited_by := OLD.edited_by;
    NEW.edited_by_name := OLD.edited_by_name;
    NEW.created_at := OLD.created_at;
    NEW.reverted_on_dispute := OLD.reverted_on_dispute;
    NEW.resolution := OLD.resolution;
    NEW.resolved_by := OLD.resolved_by;
    NEW.resolved_by_name := OLD.resolved_by_name;
    NEW.resolved_at := OLD.resolved_at;
    NEW.resolution_note := OLD.resolution_note;
    NEW.final_amount := OLD.final_amount;
  END IF;

  RETURN NEW;
END;
$$;