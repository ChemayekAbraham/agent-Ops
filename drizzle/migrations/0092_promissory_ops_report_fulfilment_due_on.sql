DO $patch$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.get_promissory_ops_report(timestamp with time zone, timestamp with time zone)'::regprocedure);
  IF position('fulfilment_due_on' in def) = 0 THEN
    def := replace(def, '''journey_stage'', journey_stage,', '''journey_stage'', journey_stage,
          ''fulfilment_due_on'', fulfilment_due_on,');
    EXECUTE def;
  END IF;
END
$patch$;