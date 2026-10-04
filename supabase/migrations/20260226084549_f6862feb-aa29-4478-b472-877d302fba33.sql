
DROP POLICY "Public can update by token" ON public.location_requests;

CREATE POLICY "Public can update pending by token"
  ON public.location_requests FOR UPDATE
  USING (status = 'pending')
  WITH CHECK (status = 'captured' AND latitude IS NOT NULL AND longitude IS NOT NULL);
