-- Segment resolver
CREATE OR REPLACE FUNCTION public.ops_resolve_agent_segment(
  _tier              public.agent_tier DEFAULT NULL,
  _region            text              DEFAULT NULL,
  _district          text              DEFAULT NULL,
  _territory         text              DEFAULT NULL,
  _frozen            boolean           DEFAULT NULL,
  _inactive_days     int               DEFAULT NULL,
  _has_capability    text              DEFAULT NULL,
  _missing_capability text             DEFAULT NULL,
  _limit_preview     int               DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ids uuid[];
  _count bigint;
  _sample jsonb;
BEGIN
  IF NOT (public.has_role(auth.uid(),'manager')
          OR public.has_role(auth.uid(),'operations')
          OR public.has_role(auth.uid(),'coo')
          OR public.has_role(auth.uid(),'ceo')
          OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  WITH base AS (
    SELECT d.*
    FROM public.vw_agent_ops_directory d
    WHERE (_tier      IS NULL OR d.agent_tier = _tier)
      AND (_region    IS NULL OR d.region    = _region)
      AND (_district  IS NULL OR d.district  = _district)
      AND (_territory IS NULL OR d.territory = _territory)
      AND (_frozen    IS NULL OR d.is_frozen = _frozen)
      AND (_inactive_days IS NULL
           OR d.last_active_at IS NULL
           OR d.last_active_at < (now() - make_interval(days => _inactive_days)))
      AND (_has_capability IS NULL OR EXISTS (
            SELECT 1 FROM public.agent_capabilities ac
             WHERE ac.agent_id = d.agent_id
               AND ac.capability = _has_capability
               AND ac.status = 'active'))
      AND (_missing_capability IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.agent_capabilities ac
             WHERE ac.agent_id = d.agent_id
               AND ac.capability = _missing_capability
               AND ac.status = 'active'))
  )
  SELECT array_agg(agent_id), count(*)::bigint
    INTO _ids, _count
    FROM base;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id', d.agent_id,
           'full_name', d.full_name,
           'phone', d.phone,
           'tier', d.agent_tier,
           'is_frozen', d.is_frozen,
           'last_active_at', d.last_active_at
         )), '[]'::jsonb)
    INTO _sample
    FROM (
      SELECT * FROM public.vw_agent_ops_directory
       WHERE agent_id = ANY(COALESCE(_ids,'{}'::uuid[]))
       ORDER BY last_active_at DESC NULLS LAST
       LIMIT GREATEST(_limit_preview, 0)
    ) d;

  RETURN jsonb_build_object(
    'count', COALESCE(_count, 0),
    'agent_ids', COALESCE(to_jsonb(_ids), '[]'::jsonb),
    'sample', _sample
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ops_resolve_agent_segment(public.agent_tier, text, text, text, boolean, int, text, text, int) FROM public;
GRANT EXECUTE ON FUNCTION public.ops_resolve_agent_segment(public.agent_tier, text, text, text, boolean, int, text, text, int) TO authenticated;

-- CSV identifier resolver
CREATE OR REPLACE FUNCTION public.ops_resolve_agents_by_identifier(
  _items text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _matched   jsonb;
  _unmatched jsonb;
  _normalised text[];
BEGIN
  IF NOT (public.has_role(auth.uid(),'manager')
          OR public.has_role(auth.uid(),'operations')
          OR public.has_role(auth.uid(),'coo')
          OR public.has_role(auth.uid(),'ceo')
          OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  IF _items IS NULL OR array_length(_items, 1) IS NULL THEN
    RETURN jsonb_build_object('matched','[]'::jsonb,'unmatched','[]'::jsonb,'matched_count',0,'unmatched_count',0);
  END IF;

  SELECT array_agg(NULLIF(trim(x), ''))
    INTO _normalised
    FROM unnest(_items) AS x;

  WITH input AS (
    SELECT DISTINCT trim(v) AS raw
      FROM unnest(_normalised) AS v
     WHERE v IS NOT NULL AND trim(v) <> ''
  ),
  resolved AS (
    SELECT i.raw,
           p.id   AS agent_id,
           p.full_name,
           p.phone,
           p.email
      FROM input i
      LEFT JOIN public.profiles p
        ON  (i.raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND p.id::text = lower(i.raw))
         OR p.phone = i.raw
         OR lower(p.email) = lower(i.raw)
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'input', raw,
      'agent_id', agent_id,
      'full_name', full_name,
      'phone', phone,
      'email', email
    )) FILTER (WHERE agent_id IS NOT NULL), '[]'::jsonb),
    COALESCE(jsonb_agg(raw) FILTER (WHERE agent_id IS NULL), '[]'::jsonb)
  INTO _matched, _unmatched
  FROM resolved;

  RETURN jsonb_build_object(
    'matched', _matched,
    'unmatched', _unmatched,
    'matched_count', jsonb_array_length(_matched),
    'unmatched_count', jsonb_array_length(_unmatched)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ops_resolve_agents_by_identifier(text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.ops_resolve_agents_by_identifier(text[]) TO authenticated;

-- Multi-capability bulk apply with internal chunking
CREATE OR REPLACE FUNCTION public.ops_bulk_apply_capabilities(
  _agent_ids   uuid[],
  _capabilities text[],
  _action      text,
  _reason      text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _chunk_size int := 5000;
  _i int := 1;
  _total int;
  _cap text;
  _chunk uuid[];
  _affected_total bigint := 0;
  _per_cap jsonb := '[]'::jsonb;
  _r jsonb;
  _cap_affected bigint;
BEGIN
  IF NOT (public.has_role(auth.uid(),'manager')
          OR public.has_role(auth.uid(),'operations')
          OR public.has_role(auth.uid(),'coo')
          OR public.has_role(auth.uid(),'ceo')
          OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  IF _action NOT IN ('enable','disable') THEN
    RAISE EXCEPTION 'action must be enable or disable';
  END IF;
  IF length(coalesce(trim(_reason),'')) < 10 THEN
    RAISE EXCEPTION 'reason must be at least 10 characters';
  END IF;
  IF _agent_ids IS NULL OR array_length(_agent_ids,1) IS NULL THEN
    RAISE EXCEPTION 'no agents supplied';
  END IF;
  IF _capabilities IS NULL OR array_length(_capabilities,1) IS NULL THEN
    RAISE EXCEPTION 'no capabilities supplied';
  END IF;

  _total := array_length(_agent_ids, 1);

  FOREACH _cap IN ARRAY _capabilities LOOP
    _cap_affected := 0;
    _i := 1;
    WHILE _i <= _total LOOP
      _chunk := _agent_ids[_i : LEAST(_i + _chunk_size - 1, _total)];
      _r := public.ops_bulk_set_agent_capability(_chunk, _cap, _action, _reason);
      _cap_affected := _cap_affected + COALESCE((_r->>'affected')::bigint, 0);
      _i := _i + _chunk_size;
    END LOOP;
    _affected_total := _affected_total + _cap_affected;
    _per_cap := _per_cap || jsonb_build_object('capability', _cap, 'affected', _cap_affected);
  END LOOP;

  RETURN jsonb_build_object(
    'requested_agents', _total,
    'capabilities', _capabilities,
    'action', _action,
    'affected_total', _affected_total,
    'per_capability', _per_cap
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ops_bulk_apply_capabilities(uuid[], text[], text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.ops_bulk_apply_capabilities(uuid[], text[], text, text) TO authenticated;