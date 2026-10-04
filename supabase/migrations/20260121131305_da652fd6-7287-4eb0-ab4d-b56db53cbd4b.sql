-- Add verification fields to rent_requests
ALTER TABLE public.rent_requests
ADD COLUMN IF NOT EXISTS agent_verified BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS agent_verified_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS agent_verified_by UUID REFERENCES public.profiles(id),
ADD COLUMN IF NOT EXISTS manager_verified BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS manager_verified_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS manager_verified_by UUID REFERENCES public.profiles(id);

-- Add verification fields to landlords table
ALTER TABLE public.landlords
ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES public.profiles(id),
ADD COLUMN IF NOT EXISTS ready_to_receive BOOLEAN DEFAULT false;

-- Create landlord payment proofs table
CREATE TABLE IF NOT EXISTS public.landlord_payment_proofs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rent_request_id UUID NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  landlord_id UUID NOT NULL REFERENCES public.landlords(id) ON DELETE CASCADE,
  supporter_id UUID NOT NULL REFERENCES public.profiles(id),
  amount NUMERIC NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('mtn', 'airtel')),
  transaction_id TEXT NOT NULL,
  proof_image_url TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  verified_by UUID REFERENCES public.profiles(id),
  verified_at TIMESTAMPTZ,
  rejection_reason TEXT,
  payment_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  reward_credited BOOLEAN DEFAULT false,
  reward_credited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.landlord_payment_proofs ENABLE ROW LEVEL SECURITY;

-- RLS policies for landlord_payment_proofs
CREATE POLICY "Supporters can view their own payment proofs"
ON public.landlord_payment_proofs
FOR SELECT
USING (auth.uid() = supporter_id);

CREATE POLICY "Supporters can create payment proofs"
ON public.landlord_payment_proofs
FOR INSERT
WITH CHECK (auth.uid() = supporter_id);

CREATE POLICY "Managers can view all payment proofs"
ON public.landlord_payment_proofs
FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Managers can update payment proofs"
ON public.landlord_payment_proofs
FOR UPDATE
USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Agents can view payment proofs for their tenants"
ON public.landlord_payment_proofs
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.rent_requests rr
    WHERE rr.id = landlord_payment_proofs.rent_request_id
    AND rr.agent_id = auth.uid()
  )
);

-- Create trigger for updated_at
CREATE TRIGGER update_landlord_payment_proofs_updated_at
BEFORE UPDATE ON public.landlord_payment_proofs
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Notify managers when payment proof is submitted
CREATE OR REPLACE FUNCTION public.notify_payment_proof_submitted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  manager_record RECORD;
  supporter_name TEXT;
  landlord_name TEXT;
BEGIN
  -- Get names
  SELECT full_name INTO supporter_name FROM public.profiles WHERE id = NEW.supporter_id;
  SELECT name INTO landlord_name FROM public.landlords WHERE id = NEW.landlord_id;
  
  -- Notify all managers
  FOR manager_record IN 
    SELECT user_id FROM public.user_roles WHERE role = 'manager'
  LOOP
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      manager_record.user_id,
      '💳 Payment Proof Submitted',
      COALESCE(supporter_name, 'A supporter') || ' paid ' || NEW.amount || ' to ' || COALESCE(landlord_name, 'landlord') || ' via ' || UPPER(NEW.payment_method) || '. Please verify.',
      'info',
      jsonb_build_object(
        'payment_proof_id', NEW.id,
        'rent_request_id', NEW.rent_request_id,
        'supporter_id', NEW.supporter_id,
        'amount', NEW.amount
      )
    );
  END LOOP;
  
  -- Also notify the agent if there is one
  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  SELECT rr.agent_id, '💳 Payment Proof Submitted',
    COALESCE(supporter_name, 'A supporter') || ' paid rent for your tenant to ' || COALESCE(landlord_name, 'landlord') || '.',
    'info',
    jsonb_build_object(
      'payment_proof_id', NEW.id,
      'rent_request_id', NEW.rent_request_id
    )
  FROM public.rent_requests rr
  WHERE rr.id = NEW.rent_request_id AND rr.agent_id IS NOT NULL;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_payment_proof_submitted
AFTER INSERT ON public.landlord_payment_proofs
FOR EACH ROW
EXECUTE FUNCTION public.notify_payment_proof_submitted();

-- Create storage bucket for payment proofs
INSERT INTO storage.buckets (id, name, public)
VALUES ('payment-proofs', 'payment-proofs', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for payment proofs
CREATE POLICY "Anyone can view payment proofs"
ON storage.objects FOR SELECT
USING (bucket_id = 'payment-proofs');

CREATE POLICY "Authenticated users can upload payment proofs"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'payment-proofs' AND auth.role() = 'authenticated');