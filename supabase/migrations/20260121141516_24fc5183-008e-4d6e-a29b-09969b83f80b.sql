-- Create watched_opportunities table for supporters to save opportunities
CREATE TABLE public.watched_opportunities (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rent_request_id UUID NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  notified_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(user_id, rent_request_id)
);

-- Enable RLS
ALTER TABLE public.watched_opportunities ENABLE ROW LEVEL SECURITY;

-- Users can view their own watched opportunities
CREATE POLICY "Users can view their own watched opportunities"
ON public.watched_opportunities FOR SELECT
USING (auth.uid() = user_id);

-- Users can watch opportunities
CREATE POLICY "Users can watch opportunities"
ON public.watched_opportunities FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can unwatch opportunities
CREATE POLICY "Users can unwatch opportunities"
ON public.watched_opportunities FOR DELETE
USING (auth.uid() = user_id);

-- Create function to notify watchers when rent request is fully verified
CREATE OR REPLACE FUNCTION public.notify_watchers_on_verification()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if the request just became fully verified (both agent and manager)
  IF (NEW.agent_verified = true AND NEW.manager_verified = true) AND 
     (OLD.agent_verified IS DISTINCT FROM true OR OLD.manager_verified IS DISTINCT FROM true) THEN
    
    -- Create notifications for all watchers
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    SELECT 
      wo.user_id,
      '✅ Opportunity Ready!',
      'A rent request you''re watching is now fully verified and ready to fund. Rent amount: UGX ' || NEW.rent_amount::text,
      'success',
      jsonb_build_object(
        'rent_request_id', NEW.id,
        'rent_amount', NEW.rent_amount,
        'action', 'view_opportunity'
      )
    FROM public.watched_opportunities wo
    WHERE wo.rent_request_id = NEW.id
      AND wo.notified_at IS NULL;
    
    -- Mark watchers as notified
    UPDATE public.watched_opportunities
    SET notified_at = now()
    WHERE rent_request_id = NEW.id
      AND notified_at IS NULL;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger for verification notifications
CREATE TRIGGER notify_watchers_on_rent_request_verification
  AFTER UPDATE ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_watchers_on_verification();

-- Add index for performance
CREATE INDEX idx_watched_opportunities_user_id ON public.watched_opportunities(user_id);
CREATE INDEX idx_watched_opportunities_rent_request_id ON public.watched_opportunities(rent_request_id);