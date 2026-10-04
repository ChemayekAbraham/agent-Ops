
CREATE TABLE public.landlord_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  phone text NOT NULL,
  property_location text NOT NULL,
  number_of_units integer NOT NULL DEFAULT 1,
  rent_per_unit numeric NOT NULL DEFAULT 0,
  guaranteed_12m_income numeric GENERATED ALWAYS AS (rent_per_unit * number_of_units * 12) STORED,
  referrer_agent_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'new_lead',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.landlord_leads ENABLE ROW LEVEL SECURITY;

-- Anyone can insert (public signup form)
CREATE POLICY "Anyone can submit landlord lead"
  ON public.landlord_leads FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Authenticated users can read their own referrals
CREATE POLICY "Agents can read own referrals"
  ON public.landlord_leads FOR SELECT
  TO authenticated
  USING (referrer_agent_id = auth.uid());

-- Staff can read all
CREATE POLICY "Staff can read all leads"
  ON public.landlord_leads FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'super_admin')
  );
