CREATE TABLE public.user_deposit_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  phone_last9 text NOT NULL,
  source text NOT NULL CHECK (source IN ('manual_route','name_match_auto')),
  linked_gmail_transaction_id uuid REFERENCES public.gmail_transactions(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone_last9)
);

CREATE INDEX idx_user_deposit_numbers_last9 ON public.user_deposit_numbers (phone_last9);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_deposit_numbers TO authenticated;
GRANT ALL ON public.user_deposit_numbers TO service_role;

ALTER TABLE public.user_deposit_numbers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance staff manage learned deposit numbers"
ON public.user_deposit_numbers
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

CREATE TABLE public.user_deposit_number_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_last9 text NOT NULL,
  attempted_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  existing_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  existing_source text NOT NULL CHECK (existing_source IN ('user_deposit_numbers','profiles.phone','profiles.mobile_money_number')),
  gmail_transaction_id uuid REFERENCES public.gmail_transactions(id) ON DELETE SET NULL,
  detected_via text NOT NULL CHECK (detected_via IN ('manual_route','name_match_auto')),
  notes text,
  resolved_at timestamp with time zone,
  resolved_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_udn_conflicts_open ON public.user_deposit_number_conflicts (created_at DESC) WHERE resolved_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_deposit_number_conflicts TO authenticated;
GRANT ALL ON public.user_deposit_number_conflicts TO service_role;

ALTER TABLE public.user_deposit_number_conflicts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance staff manage deposit number conflicts"
ON public.user_deposit_number_conflicts
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

CREATE OR REPLACE FUNCTION public.resolve_user_by_known_phone(p_last9 text)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  phone text,
  email text,
  source text,
  match_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last9 text;
BEGIN
  v_last9 := right(regexp_replace(coalesce(p_last9, ''), '[^0-9]', '', 'g'), 9);
  IF length(v_last9) < 9 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH hits AS (
    SELECT p.id, p.full_name, p.phone, p.email,
           CASE
             WHEN right(regexp_replace(coalesce(p.phone,''), '[^0-9]', '', 'g'), 9) = v_last9 THEN 'profiles.phone'
             ELSE 'profiles.mobile_money_number'
           END AS src
    FROM public.profiles p
    WHERE right(regexp_replace(coalesce(p.phone,''), '[^0-9]', '', 'g'), 9) = v_last9
       OR right(regexp_replace(coalesce(p.mobile_money_number,''), '[^0-9]', '', 'g'), 9) = v_last9
    UNION
    SELECT p.id, p.full_name, p.phone, p.email, 'user_deposit_numbers' AS src
    FROM public.user_deposit_numbers d
    JOIN public.profiles p ON p.id = d.user_id
    WHERE d.phone_last9 = v_last9
  ), agg AS (
    SELECT count(DISTINCT id)::int AS n FROM hits
  )
  SELECT DISTINCT ON (h.id) h.id, h.full_name, h.phone, h.email, h.src, a.n
  FROM hits h CROSS JOIN agg a
  ORDER BY h.id, h.src;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_user_by_known_phone(text) TO authenticated, service_role;