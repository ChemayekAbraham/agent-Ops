
-- Function to generate random 6-char alphanumeric codes
CREATE OR REPLACE FUNCTION public.generate_short_code()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  result text := '';
  i int;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  END LOOP;
  RETURN result;
END;
$$;

-- Short links table
CREATE TABLE public.short_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL DEFAULT public.generate_short_code(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  target_path text NOT NULL,
  target_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dedup index: one code per user+path+params combo
CREATE UNIQUE INDEX idx_short_links_user_params
  ON public.short_links(user_id, target_path, md5(target_params::text));

-- RLS
ALTER TABLE public.short_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own short links" ON public.short_links
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Anyone can resolve short links" ON public.short_links
  FOR SELECT TO anon
  USING (true);
