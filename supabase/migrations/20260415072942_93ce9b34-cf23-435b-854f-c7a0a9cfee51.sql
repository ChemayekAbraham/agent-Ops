
CREATE TABLE public.internship_applications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  motivation TEXT,
  skills TEXT,
  ready_to_learn BOOLEAN DEFAULT true,
  referral_code TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.internship_applications ENABLE ROW LEVEL SECURITY;

-- Anyone can insert (public form, no auth required)
CREATE POLICY "Anyone can submit internship application"
ON public.internship_applications
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

-- Only authenticated users with manager/super_admin roles can read
CREATE POLICY "Managers can view internship applications"
ON public.internship_applications
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR
  public.has_role(auth.uid(), 'super_admin') OR
  public.has_role(auth.uid(), 'coo') OR
  public.has_role(auth.uid(), 'hr')
);
