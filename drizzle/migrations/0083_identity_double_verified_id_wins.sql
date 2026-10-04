CREATE OR REPLACE VIEW public.v_identity_double_users AS
WITH p AS (
  SELECT profiles.id,
         profiles.created_at,
         public.normalize_national_id_fuzzy(profiles.national_id) AS nid,
         "right"(regexp_replace(COALESCE(profiles.phone, ''), '[^0-9]', '', 'g'), 9) AS ph9
  FROM public.profiles
), ver AS (
  SELECT DISTINCT d.user_id
  FROM public.payout_destination_verifications d
  WHERE d.status = 'verified'
), nid_verified AS (
  -- Once an ID is verified on one account, that same ID may never appear again
  SELECT a.id AS user_id,
         'national_id'::text AS kind,
         (SELECT b.id
            FROM p b
            JOIN ver vb ON vb.user_id = b.id
           WHERE b.nid = a.nid AND b.id <> a.id
           ORDER BY b.created_at, b.id
           LIMIT 1) AS first_id,
         0 AS pref
  FROM p a
  WHERE length(COALESCE(a.nid, '')) >= 6
    AND NOT EXISTS (SELECT 1 FROM ver va WHERE va.user_id = a.id)
    AND EXISTS (
      SELECT 1 FROM p b JOIN ver vb ON vb.user_id = b.id
      WHERE b.nid = a.nid AND b.id <> a.id
    )
), nid_rank AS (
  SELECT p.id,
         first_value(p.id) OVER w AS first_id,
         row_number() OVER w AS rn
  FROM p
  WHERE length(COALESCE(p.nid, '')) >= 6
  WINDOW w AS (PARTITION BY p.nid ORDER BY p.created_at, p.id)
), ph_rank AS (
  SELECT p.id,
         first_value(p.id) OVER w AS first_id,
         row_number() OVER w AS rn
  FROM p
  WHERE length(COALESCE(p.ph9, '')) >= 9
  WINDOW w AS (PARTITION BY p.ph9 ORDER BY p.created_at, p.id)
), u AS (
  SELECT user_id, kind, first_id, pref FROM nid_verified
  UNION ALL
  SELECT nid_rank.id, 'national_id'::text, nid_rank.first_id, 1 FROM nid_rank WHERE nid_rank.rn > 1
  UNION ALL
  SELECT ph_rank.id, 'phone'::text, ph_rank.first_id, 2 FROM ph_rank WHERE ph_rank.rn > 1
)
SELECT DISTINCT ON (user_id) user_id, kind, first_id AS first_user_id
FROM u
ORDER BY user_id, pref;