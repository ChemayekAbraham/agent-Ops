CREATE OR REPLACE FUNCTION public.get_partner_ops_promissory_block(p_start date, p_end date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH n AS (SELECT * FROM promissory_notes),
  w AS (
    SELECT * FROM n
    WHERE created_at >= (p_start::timestamp AT TIME ZONE 'Africa/Nairobi')
      AND created_at < ((p_end + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')
  )
  SELECT jsonb_build_object(
    'created_count', (SELECT count(*) FROM w),
    'created_amount', (SELECT coalesce(sum(amount),0) FROM w),
    'pending_count', (SELECT count(*) FROM n WHERE status = 'pending'),
    'pending_amount', (SELECT coalesce(sum(amount),0) FROM n WHERE status = 'pending'),
    'pending_receivable', (SELECT coalesce(sum(greatest(amount - total_collected,0)),0) FROM n WHERE status = 'pending'),
    'pending_oldest_days', (SELECT coalesce(max(extract(day FROM (now() - created_at))),0)::int FROM n WHERE status = 'pending'),
    'activated_count', (SELECT count(*) FROM n WHERE status = 'activated'),
    'activated_amount', (SELECT coalesce(sum(amount),0) FROM n WHERE status = 'activated'),
    'activated_receivable', (SELECT coalesce(sum(greatest(amount - total_collected,0)),0) FROM n WHERE status = 'activated'),
    'activated_oldest_days', (SELECT coalesce(max(extract(day FROM (now() - created_at))),0)::int FROM n WHERE status = 'activated'),
    'total_count', (SELECT count(*) FROM n),
    'total_amount', (SELECT coalesce(sum(amount),0) FROM n),
    'collected_amount', (SELECT coalesce(sum(total_collected),0) FROM n),
    'receivable_amount', (SELECT coalesce(sum(greatest(amount - total_collected,0)),0) FROM n WHERE status IN ('pending','activated')),
    'conversion_rate', (
      SELECT CASE WHEN count(*) > 0
        THEN round((count(*) FILTER (WHERE status = 'activated'))::numeric * 100 / count(*)::numeric, 1)
        ELSE 0 END
      FROM n
    ),
    'by_status', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'status', s.status, 'count', s.cnt, 'amount', s.amt,
               'receivable', s.recv, 'oldest_days', s.oldest
             ) ORDER BY s.amt DESC)
      FROM (
        SELECT status, count(*) AS cnt,
               coalesce(sum(amount),0) AS amt,
               coalesce(sum(greatest(amount - total_collected,0)),0) AS recv,
               coalesce(max(extract(day FROM (now() - created_at))),0)::int AS oldest
        FROM n GROUP BY status
      ) s
    ), '[]'::jsonb)
  );
$function$;

DO $do$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc
  WHERE proname = 'get_partner_ops_range_report'
    AND pronamespace = 'public'::regnamespace
  LIMIT 1;

  IF src IS NULL THEN
    RAISE EXCEPTION 'get_partner_ops_range_report not found';
  END IF;

  IF position('get_partner_ops_promissory_block' IN src) = 0 THEN
    src := replace(
      src,
      'RETURN result;',
      'result := result || jsonb_build_object(''promissory'', public.get_partner_ops_promissory_block(p_start, p_end));
  RETURN result;'
    );
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION public.get_partner_ops_range_report(p_start date, p_end date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS %L',
      src
    );
  END IF;
END
$do$;