-- Fuzzy (name-based) arrival suggestions for promissory notes.
-- Suggestions only: nothing is linked automatically. Ops must confirm.

CREATE OR REPLACE FUNCTION public.promissory_fuzzy_arrival_suggestions(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_from timestamptz := COALESCE(p_from, '1970-01-01'::timestamptz);
  v_to timestamptz := COALESCE(p_to, now() + interval '1 day');
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

  WITH notes AS (
    SELECT n.id,
           n.partner_name,
           n.created_at,
           right(regexp_replace(coalesce(n.whatsapp_number,''), '\D', '', 'g'), 9) AS k1,
           right(regexp_replace(coalesce(n.phone_number,''), '\D', '', 'g'), 9)   AS k2,
           nullif(lower(btrim(coalesce(n.email,''))), '')                          AS em,
           lower(regexp_replace(btrim(coalesce(n.partner_name,'')), '\s+', ' ', 'g')) AS nmk
    FROM public.promissory_notes n
    WHERE n.created_at >= v_from AND n.created_at < v_to
      AND n.partner_user_id IS NULL
      AND length(btrim(coalesce(n.partner_name,''))) >= 5
  ),
  -- Notes that no exact rule already resolves (phone / email / linked account).
  unresolved AS (
    SELECT nt.*
    FROM notes nt
    WHERE NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (length(nt.k1) = 9 AND right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9) = nt.k1)
         OR (length(nt.k2) = 9 AND right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9) = nt.k2)
         OR (nt.em IS NOT NULL AND lower(btrim(coalesce(p.email,''))) = nt.em)
         OR (lower(regexp_replace(btrim(coalesce(p.full_name,'')), '\s+', ' ', 'g')) = nt.nmk)
    )
  ),
  tokens AS (
    SELECT u.id AS note_id,
           u.nmk,
           array_agg(t ORDER BY length(t) DESC) AS toks
    FROM unresolved u
    CROSS JOIN LATERAL unnest(string_to_array(u.nmk, ' ')) AS t
    WHERE length(t) >= 3
    GROUP BY u.id, u.nmk
  ),
  cands AS (
    SELECT u.id AS note_id,
           u.partner_name,
           u.nmk,
           u.created_at AS note_created_at,
           c.id AS candidate_user_id,
           c.full_name AS candidate_name,
           c.phone AS candidate_phone,
           c.created_at AS candidate_created_at,
           c.score,
           c.shared
    FROM unresolved u
    JOIN tokens tk ON tk.note_id = u.id
    CROSS JOIN LATERAL (
      SELECT p.id, p.full_name, p.phone, p.created_at,
             similarity(lower(regexp_replace(btrim(p.full_name), '\s+', ' ', 'g')), u.nmk) AS score,
             (
               SELECT count(*)
               FROM unnest(tk.toks) t
               WHERE lower(' ' || regexp_replace(btrim(p.full_name), '\s+', ' ', 'g') || ' ')
                     LIKE '% ' || t || ' %'
             ) AS shared
      FROM public.profiles p
      WHERE p.full_name IS NOT NULL
        AND length(btrim(p.full_name)) >= 5
        AND p.full_name ILIKE '%' || tk.toks[1] || '%'
      LIMIT 200
    ) c
    WHERE c.shared >= 2 OR c.score >= 0.55
  ),
  ranked AS (
    SELECT c.*,
           row_number() OVER (PARTITION BY c.note_id ORDER BY c.shared DESC, c.score DESC, c.candidate_created_at ASC) AS rn,
           count(*) OVER (PARTITION BY c.note_id) AS candidate_count
    FROM cands c
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
           'confidence', CASE
                           WHEN r.shared >= 3 OR r.score >= 0.8 THEN 'high'
                           WHEN r.shared >= 2 OR r.score >= 0.6 THEN 'medium'
                           ELSE 'low'
                         END
         ) ORDER BY r.shared DESC, r.score DESC), '[]'::jsonb)
    INTO v_result
  FROM ranked r
  WHERE r.rn <= 3;

  RETURN jsonb_build_object('suggestions', v_result, 'generated_at', now());
END;
$function$;

REVOKE ALL ON FUNCTION public.promissory_fuzzy_arrival_suggestions(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promissory_fuzzy_arrival_suggestions(timestamptz, timestamptz) TO authenticated;

-- Ops confirmation of a fuzzy suggestion. Never automatic.
CREATE OR REPLACE FUNCTION public.promissory_confirm_arrival_match(
  p_note_id uuid,
  p_user_id uuid,
  p_reason text
)
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
     AND partner_user_id IS NULL
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

REVOKE ALL ON FUNCTION public.promissory_confirm_arrival_match(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promissory_confirm_arrival_match(uuid, uuid, text) TO authenticated;