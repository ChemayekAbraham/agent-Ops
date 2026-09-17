-- Notes whose partner_user_id points at an account that no longer exists were
-- treated as "already linked", so no possible-match suggestion was ever offered.
-- Treat a dangling link as unlinked, in both the suggestion and confirm paths.

CREATE OR REPLACE FUNCTION public.promissory_fuzzy_arrival_suggestions(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_from timestamptz := COALESCE(p_from, '1970-01-01'::timestamptz);
  v_to timestamptz := COALESCE(p_to, now() + interval '1 day');
  v_rate_creation numeric := public.promissory_commission_rate('portfolio_creation');
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'ceo') OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'partner_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  WITH pf AS MATERIALIZED (
    SELECT p.id, p.full_name, p.phone, p.created_at,
           lower(regexp_replace(btrim(p.full_name), '\s+', ' ', 'g')) AS nmk,
           right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9) AS pk,
           nullif(lower(btrim(coalesce(p.email,''))), '') AS em
    FROM public.profiles p
    WHERE p.full_name IS NOT NULL AND length(btrim(p.full_name)) >= 5
  ),
  notes AS MATERIALIZED (
    SELECT n.id, n.partner_name, n.created_at, n.agent_id,
           right(regexp_replace(coalesce(n.whatsapp_number,''), '\D', '', 'g'), 9) AS k1,
           right(regexp_replace(coalesce(n.phone_number,''), '\D', '', 'g'), 9) AS k2,
           nullif(lower(btrim(coalesce(n.email,''))), '') AS em,
           lower(regexp_replace(btrim(coalesce(n.partner_name,'')), '\s+', ' ', 'g')) AS nmk
    FROM public.promissory_notes n
    WHERE n.created_at >= v_from AND n.created_at < v_to
      AND (
        n.partner_user_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = n.partner_user_id)
      )
      AND length(btrim(coalesce(n.partner_name,''))) >= 5
  ),
  unresolved AS MATERIALIZED (
    SELECT nt.* FROM notes nt
    WHERE NOT EXISTS (
      SELECT 1 FROM pf p
      WHERE (length(nt.k1) = 9 AND p.pk = nt.k1)
         OR (length(nt.k2) = 9 AND p.pk = nt.k2)
         OR (nt.em IS NOT NULL AND p.em = nt.em)
         OR p.nmk = nt.nmk
    )
  ),
  ntok AS MATERIALIZED (
    SELECT u.id AS note_id, t
    FROM unresolved u CROSS JOIN LATERAL unnest(string_to_array(u.nmk, ' ')) t
    WHERE length(t) >= 3
  ),
  ptok AS MATERIALIZED (
    SELECT p.id, t
    FROM pf p CROSS JOIN LATERAL unnest(string_to_array(p.nmk, ' ')) t
    WHERE length(t) >= 3
  ),
  pairs AS (
    SELECT nt.note_id, pt.id AS cand, count(DISTINCT nt.t) AS shared
    FROM ntok nt JOIN ptok pt ON pt.t = nt.t
    GROUP BY 1, 2
    HAVING count(DISTINCT nt.t) >= 2
  ),
  scored AS (
    SELECT pr.note_id, pr.shared,
           u.partner_name, u.nmk AS note_nmk, u.created_at AS note_created_at,
           p.id AS candidate_user_id, p.full_name AS candidate_name,
           p.phone AS candidate_phone, p.created_at AS candidate_created_at,
           similarity(p.nmk, u.nmk) AS score
    FROM pairs pr
    JOIN unresolved u ON u.id = pr.note_id
    JOIN pf p ON p.id = pr.cand
  ),
  prin AS MATERIALIZED (
    SELECT ip.investor_id,
           count(*)::int AS portfolio_count,
           COALESCE(sum(ip.investment_amount), 0) AS portfolio_amount,
           COALESCE(sum(ip.investment_amount) FILTER (WHERE ip.status = 'active'), 0) AS active_amount
    FROM public.investor_portfolios ip
    WHERE ip.investor_id IN (SELECT DISTINCT candidate_user_id FROM scored)
    GROUP BY ip.investor_id
  ),
  ranked AS (
    SELECT s.*,
           COALESCE(pn.portfolio_count, 0) AS portfolio_count,
           COALESCE(pn.portfolio_amount, 0) AS portfolio_amount,
           COALESCE(pn.active_amount, 0) AS portfolio_active_amount,
           row_number() OVER (PARTITION BY s.note_id ORDER BY s.shared DESC, s.score DESC, s.candidate_created_at ASC) AS rn,
           count(*) OVER (PARTITION BY s.note_id) AS candidate_count
    FROM scored s
    LEFT JOIN prin pn ON pn.investor_id = s.candidate_user_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'note_id', r.note_id,
           'partner_name', r.partner_name,
           'note_created_at', r.note_created_at,
           'candidate_user_id', r.candidate_user_id,
           'candidate_name', r.candidate_name,
           'candidate_phone', r.candidate_phone,
           'candidate_created_at', r.candidate_created_at,
           'shared_words', r.shared,
           'similarity', round(r.score::numeric, 3),
           'candidate_count', r.candidate_count,
           'rank', r.rn,
           'candidate_portfolio_count', r.portfolio_count,
           'candidate_principal', r.portfolio_amount,
           'candidate_principal_active', r.portfolio_active_amount,
           'commission_rate', v_rate_creation,
           'commission_due', ROUND(r.portfolio_amount * v_rate_creation),
           'confidence', CASE
                           WHEN r.shared >= 3 OR r.score >= 0.8 THEN 'high'
                           WHEN r.score >= 0.6 THEN 'medium'
                           ELSE 'low'
                         END
         ) ORDER BY r.shared DESC, r.score DESC), '[]'::jsonb)
    INTO v_result
  FROM ranked r
  WHERE r.rn <= 3;

  RETURN jsonb_build_object('suggestions', v_result, 'rate_creation', v_rate_creation, 'generated_at', now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.promissory_confirm_arrival_match(p_note_id uuid, p_user_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_note public.promissory_notes;
  v_name text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'ceo') OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'partner_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: give a written reason of at least 10 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = p_user_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_ACCOUNT: that account no longer exists.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.promissory_notes
     SET partner_user_id = p_user_id
   WHERE id = p_note_id
     AND (
       partner_user_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = promissory_notes.partner_user_id)
     )
  RETURNING * INTO v_note;

  IF v_note.id IS NULL THEN
    RAISE EXCEPTION 'NOTE_ALREADY_LINKED: this note is already linked to an account.' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, new_values)
  VALUES ('promissory_arrival_match_confirmed', 'promissory_notes', v_note.id::text, v_uid,
          btrim(p_reason),
          jsonb_build_object('partner_user_id', p_user_id, 'matched_name', v_name,
                             'note_partner_name', v_note.partner_name, 'basis', 'fuzzy_name_confirmed'));

  RETURN jsonb_build_object('note_id', v_note.id, 'partner_user_id', p_user_id, 'matched_name', v_name);
END;
$function$;