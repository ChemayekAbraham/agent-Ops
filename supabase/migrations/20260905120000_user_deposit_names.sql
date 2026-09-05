-- "Known depositor names" — the name-based counterpart of user_deposit_numbers.
-- MTN's till/merchant "received" SMS never carries the payer's phone, only
-- whatever name is on the payer's SIM. When Financial Ops manually routes
-- such a receipt to a recipient (e.g. a relative/associate depositing into
-- an agent's till on the agent's behalf), we remember (payer name -> target
-- user) so the NEXT receipt from that same name auto-credits instantly
-- instead of returning to the manual queue every time.
--
-- Unlike phone numbers, names collide often (duplicate full_name rows are
-- common in profiles). So a learned name is only ever trusted while it is
-- UNCONTESTED: the moment the same normalized name is manually routed to a
-- second, different user, every row for that name is frozen (contested =
-- true) and auto-credit for that name switches off from that point on —
-- mirroring the conflict-freeze already used for user_deposit_numbers.

CREATE TABLE public.user_deposit_names (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  normalized_name text NOT NULL,
  source text NOT NULL CHECK (source IN ('manual_route','name_match_auto')),
  contested boolean NOT NULL DEFAULT false,
  linked_gmail_transaction_id uuid REFERENCES public.gmail_transactions(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, normalized_name)
);

CREATE INDEX idx_user_deposit_names_name ON public.user_deposit_names (normalized_name) WHERE NOT contested;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_deposit_names TO authenticated;
GRANT ALL ON public.user_deposit_names TO service_role;

ALTER TABLE public.user_deposit_names ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance staff manage learned deposit names"
ON public.user_deposit_names
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
);

CREATE TABLE public.user_deposit_name_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_name text NOT NULL,
  attempted_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  existing_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  gmail_transaction_id uuid REFERENCES public.gmail_transactions(id) ON DELETE SET NULL,
  detected_via text NOT NULL CHECK (detected_via IN ('manual_route','name_match_auto')),
  notes text,
  resolved_at timestamp with time zone,
  resolved_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_udn_name_conflicts_open ON public.user_deposit_name_conflicts (created_at DESC) WHERE resolved_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_deposit_name_conflicts TO authenticated;
GRANT ALL ON public.user_deposit_name_conflicts TO service_role;

ALTER TABLE public.user_deposit_name_conflicts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance staff manage deposit name conflicts"
ON public.user_deposit_name_conflicts
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
);

CREATE OR REPLACE FUNCTION public.resolve_user_by_known_name(p_name text)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  phone text,
  email text,
  match_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  v_name := upper(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  IF length(v_name) < 4 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH hits AS (
    SELECT DISTINCT p.id, p.full_name, p.phone, p.email
    FROM public.user_deposit_names d
    JOIN public.profiles p ON p.id = d.user_id
    WHERE d.normalized_name = v_name AND NOT d.contested
  ), agg AS (
    SELECT count(*)::int AS n FROM hits
  )
  SELECT h.id, h.full_name, h.phone, h.email, a.n
  FROM hits h CROSS JOIN agg a;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_user_by_known_name(text) TO authenticated, service_role;

-- ── Backfill from existing manual-route history ─────────────────────────
-- Registers every (payer name -> recipient) pairing Financial Ops has
-- already confirmed by hand, so an established clean track record (e.g. 12
-- straight ESTHER KATUSIIME -> Mata Pius routes) starts auto-crediting on
-- the very next matching receipt instead of waiting for a fresh manual
-- route to "seed" the learning. The payer name lives on the linked
-- gmail_transactions row (`counterparty`), NOT on email_routing_history
-- (whose from_name/from_email are always the IFTTT forwarding mailbox).
WITH pairs AS (
  SELECT
    upper(regexp_replace(trim(coalesce(g.counterparty, '')), '\s+', ' ', 'g')) AS normalized_name,
    r.target_user_id,
    min(r.created_at) AS first_routed_at
  FROM public.email_routing_history r
  JOIN public.gmail_transactions g ON g.id = r.gmail_transaction_id
  WHERE r.route = 'operational_float'
    AND g.counterparty IS NOT NULL
    AND length(trim(g.counterparty)) >= 4
  GROUP BY 1, 2
),
owners AS (
  SELECT normalized_name, count(DISTINCT target_user_id) AS distinct_owners
  FROM pairs
  GROUP BY normalized_name
)
INSERT INTO public.user_deposit_names (user_id, normalized_name, source, contested, created_at)
SELECT p.target_user_id, p.normalized_name, 'manual_route', (o.distinct_owners > 1), p.first_routed_at
FROM pairs p
JOIN owners o USING (normalized_name)
ON CONFLICT (user_id, normalized_name) DO NOTHING;

-- Defense in depth: freeze any name whose backfilled rows collectively
-- resolved to more than one user, even if the CTE above missed an edge case.
UPDATE public.user_deposit_names d
SET contested = true
FROM (
  SELECT normalized_name
  FROM public.user_deposit_names
  GROUP BY normalized_name
  HAVING count(DISTINCT user_id) > 1
) dup
WHERE d.normalized_name = dup.normalized_name AND NOT d.contested;
