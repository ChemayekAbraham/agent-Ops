DO $do$
DECLARE
  r record;
  def text;
  newdef text;
  patched int := 0;
BEGIN
  FOR r IN
    SELECT oid FROM pg_proc
    WHERE proname = 'get_agent_products_services_report'
      AND pronamespace = 'public'::regnamespace
  LOOP
    def := pg_get_functiondef(r.oid);

    newdef := replace(
      def,
      'COALESCE(sum(CASE WHEN gl.direction = ''cash_out'' THEN gl.amount END),0) AS float_out,',
      'COALESCE(sum(CASE WHEN gl.direction = ''cash_out'' THEN gl.amount END),0) AS float_out,
           COALESCE(sum(CASE WHEN gl.direction = ''cash_out'' AND gl.category IN (''agent_float_used_for_rent'',''rent_payment_for_tenant'') THEN gl.amount END),0) AS rent_paid_out,'
    );

    newdef := replace(
      newdef,
      'COALESCE(fd.float_out,0) AS float_paid_out,',
      'COALESCE(fd.rent_paid_out,0) AS float_paid_out,'
    );

    IF newdef = def THEN
      RAISE EXCEPTION 'paid-out snippets not found in function oid %', r.oid;
    END IF;

    EXECUTE newdef;
    patched := patched + 1;
  END LOOP;

  IF patched = 0 THEN
    RAISE EXCEPTION 'no get_agent_products_services_report function found';
  END IF;
END
$do$;