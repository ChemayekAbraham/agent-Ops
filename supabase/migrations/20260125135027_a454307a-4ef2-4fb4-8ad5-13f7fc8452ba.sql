-- Create repayment_schedules table to store generated payment schedules
CREATE TABLE public.repayment_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rent_request_id UUID NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL,
    payment_number INTEGER NOT NULL,
    due_date DATE NOT NULL,
    amount NUMERIC NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, paid, missed
    paid_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.repayment_schedules ENABLE ROW LEVEL SECURITY;

-- Policies for repayment_schedules
CREATE POLICY "Users can view their own schedules"
ON public.repayment_schedules
FOR SELECT
USING (
    tenant_id = auth.uid() OR
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'agent') OR
    public.has_role(auth.uid(), 'supporter')
);

CREATE POLICY "System can insert schedules"
ON public.repayment_schedules
FOR INSERT
WITH CHECK (tenant_id = auth.uid() OR public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Users can update own schedule status"
ON public.repayment_schedules
FOR UPDATE
USING (tenant_id = auth.uid() OR public.has_role(auth.uid(), 'manager'));

-- Add schedule_status to rent_requests to track acceptance
ALTER TABLE public.rent_requests 
ADD COLUMN IF NOT EXISTS schedule_status TEXT DEFAULT 'pending_acceptance';
-- Values: pending_acceptance, accepted, rejected

-- Add number_of_payments column to rent_requests
ALTER TABLE public.rent_requests 
ADD COLUMN IF NOT EXISTS number_of_payments INTEGER DEFAULT 1;

-- Create function to notify agent when landlord needs registration
CREATE OR REPLACE FUNCTION public.notify_agent_landlord_registration()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    landlord_has_account BOOLEAN;
    landlord_record RECORD;
    agent_record RECORD;
    tenant_name TEXT;
BEGIN
    -- Get landlord details
    SELECT * INTO landlord_record FROM public.landlords WHERE id = NEW.landlord_id;
    
    -- Check if landlord has a user account (linked via tenant_id or registered_by)
    landlord_has_account := landlord_record.registered_by IS NOT NULL OR landlord_record.verified = true;
    
    -- If landlord doesn't have an account and there's an agent
    IF NOT landlord_has_account AND NEW.agent_id IS NOT NULL THEN
        -- Get tenant name
        SELECT full_name INTO tenant_name FROM public.profiles WHERE id = NEW.tenant_id;
        
        -- Notify the agent
        INSERT INTO public.notifications (user_id, title, message, type, metadata)
        VALUES (
            NEW.agent_id,
            '🏠 Landlord Needs Registration',
            'The landlord "' || COALESCE(landlord_record.name, 'Unknown') || '" for tenant ' || 
            COALESCE(tenant_name, 'Unknown') || ' is not registered. Please verify and register them.',
            'warning',
            jsonb_build_object(
                'rent_request_id', NEW.id,
                'landlord_id', NEW.landlord_id,
                'landlord_name', landlord_record.name,
                'landlord_phone', landlord_record.phone,
                'property_address', landlord_record.property_address,
                'action', 'register_landlord'
            )
        );
    END IF;
    
    RETURN NEW;
END;
$$;

-- Create trigger for landlord registration notification
DROP TRIGGER IF EXISTS on_rent_request_check_landlord ON public.rent_requests;
CREATE TRIGGER on_rent_request_check_landlord
AFTER INSERT ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.notify_agent_landlord_registration();

-- Enable realtime for repayment_schedules
ALTER PUBLICATION supabase_realtime ADD TABLE public.repayment_schedules;