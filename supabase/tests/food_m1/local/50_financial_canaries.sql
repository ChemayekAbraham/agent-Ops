-- Financial canaries: stand-ins for live money objects, planted BEFORE the Food
-- migrations. Synthetic; names mirror production objects so any accidental
-- reference would bind to them. Every INSERT/UPDATE/DELETE/TRUNCATE on them is
-- counted in canary.hits by a statement-level trigger.
CREATE SCHEMA canary;
CREATE TABLE canary.hits (tbl text, op text, at timestamptz DEFAULT now());

CREATE TABLE public.general_ledger (id bigserial PRIMARY KEY, amount numeric NOT NULL, direction text, category text);
CREATE TABLE public.wallet_transactions (id bigserial PRIMARY KEY, user_id uuid, amount numeric NOT NULL);
CREATE TABLE public.requisitions (id bigserial PRIMARY KEY, amount numeric NOT NULL, status text);
CREATE VIEW public.wallets AS
  SELECT user_id, sum(amount) AS balance FROM public.wallet_transactions GROUP BY user_id;
CREATE FUNCTION public.create_ledger_transaction(p_amount numeric, p_category text)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.general_ledger (amount, category) VALUES (p_amount, p_category) RETURNING id
$$;

CREATE FUNCTION canary.count_hit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO canary.hits(tbl, op) VALUES (TG_TABLE_NAME, TG_OP); RETURN NULL; END $$;
CREATE TRIGGER canary_gl AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.general_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION canary.count_hit();
CREATE TRIGGER canary_wt AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.wallet_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION canary.count_hit();
CREATE TRIGGER canary_rq AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.requisitions
  FOR EACH STATEMENT EXECUTE FUNCTION canary.count_hit();

ALTER TABLE public.general_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY gl_read ON public.general_ledger FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.general_ledger, public.wallet_transactions, public.requisitions FROM anon, authenticated;
GRANT SELECT ON public.general_ledger TO authenticated;
REVOKE ALL ON FUNCTION public.create_ledger_transaction(numeric, text) FROM PUBLIC, anon, authenticated;

-- a known financial starting position
INSERT INTO public.general_ledger (amount, direction, category) VALUES (1000, 'credit', 'seed'), (250, 'debit', 'seed');
INSERT INTO public.wallet_transactions (user_id, amount) VALUES ('f0000000-0000-4000-8000-0000000000a1', 500);
INSERT INTO public.requisitions (amount, status) VALUES (75, 'approved');
TRUNCATE canary.hits;
