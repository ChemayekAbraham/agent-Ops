DO $mig$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.ops_tenant_ops_tool_report(text,text,text,timestamptz,timestamptz,int)'::regprocedure);
  IF position('COALESCE(ac.payment_method,''unknown'')' in d) = 0 THEN
    RAISE NOTICE 'already patched';
    RETURN;
  END IF;
  d := replace(d, 'COALESCE(ac.payment_method,''unknown'')', 'COALESCE(ac.payment_method::text,''unknown'')');
  EXECUTE d;
END
$mig$;