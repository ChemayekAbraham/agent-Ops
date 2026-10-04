CREATE OR REPLACE FUNCTION public.list_proxy_agent_partners(
  p_agent_id uuid DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_filter text DEFAULT 'all',
  p_sort text DEFAULT 'linked_at',
  p_dir text DEFAULT 'desc',
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_agent uuid := proxy_cc_resolve_agent(p_agent_id);
  v_lim int := LEAST(GREATEST(COALESCE(p_limit,20),1),100);
  v_off int := GREATEST(COALESCE(p_offset,0),0);
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(p_sort,'linked_at'));
  v_asc boolean := lower(COALESCE(p_dir,'desc')) = 'asc';
  v_total int;
  v_rows jsonb;
BEGIN
  WITH base AS MATERIALIZED (
    SELECT * FROM proxy_agent_partner_rows(v_agent)
  ), filtered AS (
    SELECT * FROM base r
    WHERE (v_q IS NULL OR r.partner_name ILIKE '%'||v_q||'%' OR COALESCE(r.partner_phone,'') ILIKE '%'||v_q||'%')
      AND (
        COALESCE(p_filter,'all') = 'all'
        OR (p_filter = 'came_in' AND r.came_in)
        OR (p_filter = 'returning' AND r.is_returning)
        OR (p_filter = 'not_yet' AND NOT r.came_in)
      )
  ), counted AS (SELECT COUNT(*)::int AS total FROM filtered),
  page AS (
    SELECT * FROM filtered
    ORDER BY
      CASE WHEN v_sort = 'name' AND v_asc THEN partner_name END ASC NULLS LAST,
      CASE WHEN v_sort = 'name' AND NOT v_asc THEN partner_name END DESC NULLS LAST,
      CASE WHEN v_sort = 'funded' AND v_asc THEN total_funded END ASC NULLS LAST,
      CASE WHEN v_sort = 'funded' AND NOT v_asc THEN total_funded END DESC NULLS LAST,
      CASE WHEN v_sort = 'portfolios' AND v_asc THEN portfolios END ASC NULLS LAST,
      CASE WHEN v_sort = 'portfolios' AND NOT v_asc THEN portfolios END DESC NULLS LAST,
      CASE WHEN v_sort NOT IN ('name','funded','portfolios') AND v_asc THEN linked_at END ASC NULLS LAST,
      CASE WHEN v_sort NOT IN ('name','funded','portfolios') AND NOT v_asc THEN linked_at END DESC NULLS LAST
    LIMIT v_lim OFFSET v_off
  )
  SELECT (SELECT total FROM counted),
         COALESCE(jsonb_agg(jsonb_build_object(
           'partner_user_id', partner_user_id,
           'partner_name', partner_name,
           'partner_phone', COALESCE(partner_phone,'—'),
           'sources', sources,
           'linked_at', linked_at,
           'portfolios', portfolios,
           'total_funded', total_funded,
           'last_funded_at', last_funded_at,
           'came_in', came_in,
           'is_returning', is_returning,
           'notes_count', notes_count
         )), '[]'::jsonb)
    INTO v_total, v_rows FROM page;

  RETURN jsonb_build_object('total', COALESCE(v_total,0), 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
END; $$;

GRANT EXECUTE ON FUNCTION public.list_proxy_agent_partners(uuid,text,text,text,text,int,int) TO authenticated, service_role;