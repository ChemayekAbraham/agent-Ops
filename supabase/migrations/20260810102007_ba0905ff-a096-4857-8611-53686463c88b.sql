DO $mig$
DECLARE
  r record;
  s text;
  gate text := '    WHERE coalesce(hl.service_center_status, ''not_required'') IN (''not_required'', ''passed'') AND ';
BEGIN
  FOR r IN
    SELECT oid FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN (
        'ops_search_house_listings',
        'ops_house_listing_status_counts',
        'ops_house_quick_filter_counts',
        'ops_house_listing_report'
      )
  LOOP
    s := pg_get_functiondef(r.oid);
    IF position('service_center_status' in s) = 0 THEN
      s := replace(s, E'    WHERE', gate);
      EXECUTE s;
    END IF;
  END LOOP;
END
$mig$;