
CREATE TABLE public.tenant_ops_filter_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL,
  filters jsonb NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  share_slug text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenant_ops_filter_presets_owner ON public.tenant_ops_filter_presets(owner_id);
CREATE INDEX idx_tenant_ops_filter_presets_shared ON public.tenant_ops_filter_presets(visibility) WHERE visibility='shared';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_ops_filter_presets TO authenticated;
GRANT ALL ON public.tenant_ops_filter_presets TO service_role;

ALTER TABLE public.tenant_ops_filter_presets ENABLE ROW LEVEL SECURITY;

-- Owner can do anything on their own preset
CREATE POLICY "Owners manage their presets"
ON public.tenant_ops_filter_presets
FOR ALL TO authenticated
USING (auth.uid() = owner_id)
WITH CHECK (auth.uid() = owner_id);

-- Any authenticated ops user can read shared presets, or any preset reachable by share_slug
CREATE POLICY "Ops can read shared presets"
ON public.tenant_ops_filter_presets
FOR SELECT TO authenticated
USING (visibility = 'shared' AND public.is_ops_role(auth.uid()));

CREATE OR REPLACE FUNCTION public.touch_tenant_ops_filter_preset()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_touch_tenant_ops_filter_preset
BEFORE UPDATE ON public.tenant_ops_filter_presets
FOR EACH ROW EXECUTE FUNCTION public.touch_tenant_ops_filter_preset();

-- Resolve a preset by its share slug (security definer so non-ops users with the link can load it)
CREATE OR REPLACE FUNCTION public.get_tenant_ops_preset_by_slug(p_slug text)
RETURNS TABLE(id uuid, name text, filters jsonb, visibility text, share_slug text, owner_id uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, name, filters, visibility, share_slug, owner_id, created_at
  FROM public.tenant_ops_filter_presets
  WHERE share_slug = p_slug
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_ops_preset_by_slug(text) TO authenticated;
