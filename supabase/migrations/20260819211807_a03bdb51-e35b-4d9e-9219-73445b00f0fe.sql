DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.budget_calls WHERE status = 'open' LOOP
    PERFORM public.budget_notify_cycle_open(r.id);
  END LOOP;
END $$;