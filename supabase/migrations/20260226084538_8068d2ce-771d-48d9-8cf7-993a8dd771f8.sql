
CREATE TABLE public.location_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  rent_request_id uuid NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  target_role text NOT NULL CHECK (target_role IN ('tenant', 'agent')),
  target_user_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  latitude double precision,
  longitude double precision,
  accuracy double precision,
  captured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'captured'))
);

ALTER TABLE public.location_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can manage location requests"
  ON public.location_requests FOR ALL
  USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Public can update by token"
  ON public.location_requests FOR UPDATE
  USING (true)
  WITH CHECK (status = 'captured' AND latitude IS NOT NULL AND longitude IS NOT NULL);

CREATE POLICY "Public can read by token"
  ON public.location_requests FOR SELECT
  USING (true);
