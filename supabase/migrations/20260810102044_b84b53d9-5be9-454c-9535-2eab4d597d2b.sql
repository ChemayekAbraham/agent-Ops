UPDATE public.house_listings
SET status = 'available', updated_at = now()
WHERE id = '82943fc3-ab0e-4c20-b0e6-a9b39bb096d0'
  AND service_center_status = 'pending'
  AND status = 'rejected';