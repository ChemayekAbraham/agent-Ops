CREATE TABLE public.sms_message_exceptions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  phone text NOT NULL,
  message_type text NOT NULL,
  reason text,
  created_by uuid REFERENCES auth.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phone, message_type)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sms_message_exceptions TO authenticated;
GRANT ALL ON public.sms_message_exceptions TO service_role;

ALTER TABLE public.sms_message_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tech leadership can view sms exceptions"
ON public.sms_message_exceptions FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
);

CREATE POLICY "Tech leadership can add sms exceptions"
ON public.sms_message_exceptions FOR INSERT TO authenticated
WITH CHECK (
  has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
);

CREATE POLICY "Tech leadership can update sms exceptions"
ON public.sms_message_exceptions FOR UPDATE TO authenticated
USING (
  has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
);

CREATE POLICY "Tech leadership can delete sms exceptions"
ON public.sms_message_exceptions FOR DELETE TO authenticated
USING (
  has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
);