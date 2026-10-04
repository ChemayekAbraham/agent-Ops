CREATE TABLE public.engrep_file_touches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  window_id uuid NOT NULL REFERENCES public.engrep_windows(id) ON DELETE CASCADE,
  evidence_ref text NOT NULL,
  path text NOT NULL,
  blob_sha text NOT NULL,
  engineer_id uuid NULL REFERENCES public.engrep_engineers(id),
  source text NOT NULL,
  touched_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (window_id, evidence_ref, path)
);

CREATE INDEX engrep_file_touches_window_path_idx ON public.engrep_file_touches (window_id, path);
CREATE INDEX engrep_file_touches_path_blob_idx ON public.engrep_file_touches (path, blob_sha);

GRANT SELECT ON public.engrep_file_touches TO authenticated;
GRANT ALL ON public.engrep_file_touches TO service_role;

ALTER TABLE public.engrep_file_touches ENABLE ROW LEVEL SECURITY;

-- Mirrors engrep_rows_select exactly.
CREATE POLICY engrep_file_touches_select ON public.engrep_file_touches
FOR SELECT
USING (
  engrep_is_adjudicator()
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR (engineer_id IN (SELECT e.id FROM public.engrep_engineers e WHERE e.staff_id = hr_my_staff_id()))
);

CREATE OR REPLACE FUNCTION public.engrep_svc_record_file_touch(
  p_window_id uuid,
  p_evidence_ref text,
  p_path text,
  p_blob_sha text,
  p_engineer_id uuid,
  p_source text,
  p_touched_at timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.engrep_file_touches (
    window_id, evidence_ref, path, blob_sha, engineer_id, source, touched_at
  ) VALUES (
    p_window_id, p_evidence_ref, p_path, p_blob_sha, p_engineer_id, p_source, p_touched_at
  )
  ON CONFLICT (window_id, evidence_ref, path) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.engrep_svc_record_file_touch(uuid, text, text, text, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.engrep_svc_record_file_touch(uuid, text, text, text, uuid, text, timestamptz) TO service_role;