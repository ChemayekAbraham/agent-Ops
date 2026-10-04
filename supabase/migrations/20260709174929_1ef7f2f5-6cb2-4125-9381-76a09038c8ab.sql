CREATE TABLE public.change_of_address_monitor (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  old_domain text NOT NULL,
  new_domain text NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_redirect',
  redirect_healthy boolean NOT NULL DEFAULT false,
  consecutive_healthy integer NOT NULL DEFAULT 0,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  gsc_snapshot jsonb,
  last_action text,
  last_action_at timestamptz,
  redirect_first_seen_at timestamptz,
  ready_at timestamptz,
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (old_domain, new_domain)
);

GRANT SELECT ON public.change_of_address_monitor TO authenticated;
GRANT ALL ON public.change_of_address_monitor TO service_role;

ALTER TABLE public.change_of_address_monitor ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users can view change of address monitor"
ON public.change_of_address_monitor
FOR SELECT
TO authenticated
USING (true);

CREATE TRIGGER update_change_of_address_monitor_updated_at
BEFORE UPDATE ON public.change_of_address_monitor
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.change_of_address_monitor (old_domain, new_domain)
VALUES ('welilereceipts.com', 'welileapp.com')
ON CONFLICT (old_domain, new_domain) DO NOTHING;