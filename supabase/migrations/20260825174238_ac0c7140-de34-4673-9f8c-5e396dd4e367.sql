CREATE TABLE public.landlord_call_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL REFERENCES public.landlords(id) ON DELETE CASCADE,
  house_listing_id uuid,
  status text NOT NULL DEFAULT 'pending',
  comment text,
  follow_up_at timestamptz,
  called_by uuid NOT NULL,
  called_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landlord_call_reports_status_check CHECK (status IN ('pending','closed','missed'))
);

GRANT SELECT, INSERT ON public.landlord_call_reports TO authenticated;
GRANT ALL ON public.landlord_call_reports TO service_role;

ALTER TABLE public.landlord_call_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops staff read landlord call reports"
ON public.landlord_call_reports
FOR SELECT
TO authenticated
USING (
  is_ops_role((SELECT auth.uid()))
  OR has_role((SELECT auth.uid()), 'manager'::app_role)
  OR has_role((SELECT auth.uid()), 'super_admin'::app_role)
  OR has_role((SELECT auth.uid()), 'coo'::app_role)
  OR has_role((SELECT auth.uid()), 'ceo'::app_role)
  OR has_role((SELECT auth.uid()), 'cto'::app_role)
);

CREATE POLICY "Ops staff log landlord calls"
ON public.landlord_call_reports
FOR INSERT
TO authenticated
WITH CHECK (
  called_by = (SELECT auth.uid())
  AND (
    is_ops_role((SELECT auth.uid()))
    OR has_role((SELECT auth.uid()), 'manager'::app_role)
    OR has_role((SELECT auth.uid()), 'super_admin'::app_role)
    OR has_role((SELECT auth.uid()), 'coo'::app_role)
    OR has_role((SELECT auth.uid()), 'ceo'::app_role)
    OR has_role((SELECT auth.uid()), 'cto'::app_role)
  )
);

CREATE INDEX idx_landlord_call_reports_landlord ON public.landlord_call_reports(landlord_id, called_at DESC);
CREATE INDEX idx_landlord_call_reports_called_at ON public.landlord_call_reports(called_at DESC);

CREATE VIEW public.v_landlord_call_summary
WITH (security_invoker = true) AS
SELECT
  landlord_id,
  count(*)::integer AS call_count,
  max(called_at) AS last_call_at,
  (array_agg(status ORDER BY called_at DESC))[1] AS last_status,
  count(*) FILTER (WHERE status = 'pending')::integer AS pending_count,
  count(*) FILTER (WHERE status = 'closed')::integer AS closed_count,
  count(*) FILTER (WHERE status = 'missed')::integer AS missed_count,
  (array_agg(comment ORDER BY called_at DESC) FILTER (WHERE comment IS NOT NULL AND btrim(comment) <> ''))[1] AS latest_comment,
  (array_agg(called_at ORDER BY called_at DESC) FILTER (WHERE comment IS NOT NULL AND btrim(comment) <> ''))[1] AS latest_comment_at,
  (array_agg(follow_up_at ORDER BY called_at DESC) FILTER (WHERE follow_up_at IS NOT NULL))[1] AS last_follow_up_at
FROM public.landlord_call_reports
GROUP BY landlord_id;

GRANT SELECT ON public.v_landlord_call_summary TO authenticated;
GRANT SELECT ON public.v_landlord_call_summary TO service_role;