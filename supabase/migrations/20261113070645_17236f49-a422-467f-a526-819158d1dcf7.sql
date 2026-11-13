DO $migration$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.staff_requisition_pending_prompt()'::regprocedure) INTO v_definition;
  IF position('AND (p.snooze_until IS NULL OR p.snooze_until <= now())' in v_definition) = 0 THEN
    IF position('AND p.state <> ''resolved''' in v_definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected requisition prompt definition';
    END IF;
    v_definition := replace(v_definition, 'AND p.state <> ''resolved''', 'AND p.state <> ''resolved'' AND (p.snooze_until IS NULL OR p.snooze_until <= now())');
    EXECUTE v_definition;
  END IF;
END
$migration$;