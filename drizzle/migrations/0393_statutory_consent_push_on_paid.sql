CREATE OR REPLACE FUNCTION public.trg_cfo_statutory_consent_notice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.event_type = 'paid' THEN
    INSERT INTO public.cfo_statutory_consent_notices (run_id, paid_at, recipient_id)
    VALUES (NEW.run_id, NEW.created_at, 'cfa56623-e6cb-4023-b601-3dbd4fdbc027')  -- BAYO MERCY (CFO account)
    ON CONFLICT (run_id) DO NOTHING;
    BEGIN
      PERFORM net.http_post(
        url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/statutory-consent-cfo-push',
        headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
        body := '{}'::jsonb);
    EXCEPTION WHEN OTHERS THEN NULL;  -- a failed push must never block the payroll event
    END;
  END IF;
  RETURN NULL;
END $$;