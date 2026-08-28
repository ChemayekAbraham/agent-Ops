CREATE OR REPLACE FUNCTION public.budget_budgetable_accounts()
RETURNS TABLE (code text, label text, section text, nature text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Any signed-in staff member who reviews budgets, can file for at least one
  -- department, or has a resolved home department may read the categories.
  IF NOT public.is_budget_reviewer(v_uid)
     AND public.budget_home_department_id(v_uid) IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.budget_user_department_ids(v_uid) AS dept_id
        WHERE public.budget_can_file_for_department(v_uid, dept_id)
     ) THEN
    RAISE EXCEPTION 'You are not registered in a budgeting department';
  END IF;

  RETURN QUERY
  SELECT c.code, c.label, c.section, c.nature
    FROM public.ledger_account_catalog c
   WHERE public.budget_is_budgetable_account(c.code)
   ORDER BY c.sort_order, c.code;
END;
$$;

REVOKE ALL ON FUNCTION public.budget_budgetable_accounts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_budgetable_accounts() FROM anon;
GRANT EXECUTE ON FUNCTION public.budget_budgetable_accounts() TO authenticated;