DO $$
DECLARE r record; def text;
BEGIN
  FOR r IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND pg_get_functiondef(p.oid) ILIKE '%new_values%'
  LOOP
    def := pg_get_functiondef(r.oid);
    def := replace(def, 'new_values', 'metadata');
    EXECUTE def;
  END LOOP;
END $$;