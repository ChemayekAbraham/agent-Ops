GRANT EXECUTE ON FUNCTION public.set_merchant_desk_float_to(uuid,uuid,numeric,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.merchant_float_fix_authorized(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL AND (
    public.has_role(_user_id, 'cfo')
    OR public.has_role(_user_id, 'financial_ops')
    OR public.has_role(_user_id, 'super_admin')
    OR _user_id IN (
      '59d45ad2-0d44-433c-b4ec-20927a25c281'::uuid, -- Nankambo Sharimah
      '6b7d9eee-4bc8-47ac-a2e6-b84cbaac8bb4'::uuid, -- Mercy Bayo
      'cfa56623-e6cb-4023-b601-3dbd4fdbc027'::uuid, -- Bayo Mercy
      'cb798acb-68bc-4b4e-a414-a3d374e030b6'::uuid  -- Joshua Wanda
    )
  )
$$;

GRANT EXECUTE ON FUNCTION public.merchant_float_fix_authorized(uuid) TO authenticated;