CREATE OR REPLACE FUNCTION public.get_wallet_holder_activity_counts(p_user_ids uuid[])
RETURNS TABLE (
  user_id uuid,
  withdrawal_count integer,
  withdrawal_total numeric,
  last_withdrawal_at timestamptz,
  transfer_count integer,
  transfer_total numeric,
  last_transfer_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.uid AS user_id,
    COALESCE(w.cnt, 0)::int AS withdrawal_count,
    COALESCE(w.total, 0)::numeric AS withdrawal_total,
    w.last_at AS last_withdrawal_at,
    COALESCE(t.cnt, 0)::int AS transfer_count,
    COALESCE(t.total, 0)::numeric AS transfer_total,
    t.last_at AS last_transfer_at
  FROM unnest(COALESCE(p_user_ids, ARRAY[]::uuid[])) AS u(uid)
  LEFT JOIN (
    SELECT wr.user_id AS uid, count(*) AS cnt, sum(wr.amount) AS total, max(wr.created_at) AS last_at
    FROM public.withdrawal_requests wr
    WHERE wr.user_id = ANY(COALESCE(p_user_ids, ARRAY[]::uuid[]))
      AND COALESCE(wr.status, '') NOT IN ('rejected', 'cancelled', 'failed')
    GROUP BY wr.user_id
  ) w ON w.uid = u.uid
  LEFT JOIN (
    SELECT gl.user_id AS uid, count(*) AS cnt, sum(abs(COALESCE(gl.amount, 0))) AS total, max(gl.created_at) AS last_at
    FROM public.general_ledger gl
    WHERE gl.user_id = ANY(COALESCE(p_user_ids, ARRAY[]::uuid[]))
      AND gl.category = 'wallet_transfer'
      AND COALESCE(gl.classification, '') <> 'admin_correction'
    GROUP BY gl.user_id
  ) t ON t.uid = u.uid;
$$;

REVOKE ALL ON FUNCTION public.get_wallet_holder_activity_counts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_wallet_holder_activity_counts(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_holder_activity_counts(uuid[]) TO service_role;