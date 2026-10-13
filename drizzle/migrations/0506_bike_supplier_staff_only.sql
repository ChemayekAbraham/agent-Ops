-- Bike lease suppliers must be internal company staff or operations team members.
-- Tenants, agents, landlords and supporters are never eligible.

CREATE OR REPLACE FUNCTION public.has_internal_staff_role(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = p_user_id
      AND ur.enabled IS TRUE
      AND ur.role IN (
        'admin', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'manager',
        'super_admin', 'employee', 'operations', 'hr', 'access_admin', 'rd',
        'tenant_ops', 'landlord_ops', 'agent_ops', 'financial_ops', 'partner_ops'
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.has_internal_staff_role(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_internal_staff_role(uuid) TO authenticated;

-- Same assignment flow, now restricted to internal staff/ops suppliers.
CREATE OR REPLACE FUNCTION public.assign_bike_lease_supplier(p_sale_id uuid, p_supplier_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row public.merchandise_sales; v_name text;
BEGIN
  IF NOT public.can_review_bike_leases(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to assign a supplier to bike leases';
  END IF;
  SELECT * INTO v_row FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Application not found'; END IF;
  IF lower(COALESCE(v_row.item_name, '')) NOT LIKE '%spiro%' THEN
    RAISE EXCEPTION 'This record is not a bike lease application';
  END IF;
  IF v_row.cfo_disbursed_at IS NOT NULL OR COALESCE(v_row.order_status,'') IN ('approved','rejected','cancelled','completed') THEN
    RAISE EXCEPTION 'Supplier can only be changed before the CFO releases funds';
  END IF;
  IF p_supplier_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_supplier_id) THEN
      RAISE EXCEPTION 'Supplier must be a registered platform user';
    END IF;
    IF p_supplier_id = v_row.customer_id THEN
      RAISE EXCEPTION 'The supplier and the leasing agent cannot be the same person';
    END IF;
    IF NOT public.has_internal_staff_role(p_supplier_id) THEN
      RAISE EXCEPTION 'Supplier must be internal company staff or an operations team member. Tenants, agents and landlords cannot be the bike supplier';
    END IF;
    SELECT full_name INTO v_name FROM public.profiles WHERE id = p_supplier_id;
  END IF;
  UPDATE public.merchandise_sales SET supplier_id = p_supplier_id, updated_at = now() WHERE id = p_sale_id;
  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (auth.uid(), 'bike_lease_supplier_assigned', 'merchandise_sales', p_sale_id,
            'Assigned the company supplier who procures this bike',
            jsonb_build_object('supplier_id', p_supplier_id, 'previous_supplier_id', v_row.supplier_id));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('sale_id', p_sale_id, 'supplier_id', p_supplier_id, 'supplier_name', v_name);
END $function$;

-- Server-side staff-only supplier search so the picker never shows or
-- selects tenants, agents, landlords or supporters (client RLS cannot
-- read other users' roles directly).
CREATE OR REPLACE FUNCTION public.search_bike_supplier_candidates(p_search text DEFAULT ''::text)
RETURNS TABLE(user_id uuid, full_name text, phone text, roles text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_words text[];
  v_digits text;
  v_q text := COALESCE(trim(p_search), '');
  v_name_patterns text[];
BEGIN
  IF NOT public.can_review_bike_leases(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view bike supplier candidates';
  END IF;

  v_words := array_remove(string_to_array(regexp_replace(v_q, '[,()%*]', ' ', 'g'), ' '), '');
  v_digits := regexp_replace(v_q, '\D', '', 'g');
  IF array_length(v_words, 1) > 0 THEN
    v_name_patterns := (SELECT array_agg('%' || w || '%') FROM unnest(v_words) AS w);
  END IF;

  RETURN QUERY
  SELECT pr.id, pr.full_name, pr.phone,
         array_agg(DISTINCT ur.role::text ORDER BY ur.role::text)
  FROM public.profiles pr
  JOIN public.user_roles ur
    ON ur.user_id = pr.id
   AND ur.enabled IS TRUE
   AND ur.role IN (
      'admin', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'manager',
      'super_admin', 'employee', 'operations', 'hr', 'access_admin', 'rd',
      'tenant_ops', 'landlord_ops', 'agent_ops', 'financial_ops', 'partner_ops'
   )
  WHERE (
    char_length(v_digits) >= 4
    AND regexp_replace(COALESCE(pr.phone, ''), '\D', '', 'g')
        LIKE '%' || regexp_replace(v_digits, '^(256|0)', '', '') || '%'
  ) OR (
    v_name_patterns IS NOT NULL
    AND COALESCE(pr.full_name, '') ILIKE ALL (v_name_patterns)
  )
  GROUP BY pr.id
  ORDER BY MIN(COALESCE(pr.full_name, ''))
  LIMIT 15;
END $function$;

GRANT EXECUTE ON FUNCTION public.search_bike_supplier_candidates(text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.search_bike_supplier_candidates(text) FROM anon;