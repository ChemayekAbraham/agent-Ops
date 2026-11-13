-- Bank balance anchors (CFO decision 10 Nov 2026).
--
-- The Equity bank balance on the CFO dashboard is derived from bank emails: credits in less debits out since a
-- start date (get_money_at_bank_reconciliation, start 7 Oct 2026 00:00 EAT). That is only a balance if the
-- account's balance on the start date is known. This table records confirmed balances (CFO confirmation or bank
-- statement) so the screens can say whether the derived balance is anchored, and so future statement balances can
-- be compared with it.
--
-- Seed: the CFO confirmed on 10 Nov 2026 that the Equity account balance was ZERO on 7 Oct 2026.
-- Reporting only: no ledger posting, no wallet or money movement.
-- Rollback: supabase/rollbacks/20261110120000_fin_bank_anchors.rollback.sql

CREATE TABLE IF NOT EXISTS public.fin_bank_anchors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_key   text NOT NULL,                  -- 'equity' = Equity Bank account fed by bank emails
  account_label text NOT NULL,
  anchor_at     timestamptz NOT NULL,           -- the moment the balance applies to
  balance       numeric NOT NULL,
  source        text NOT NULL CHECK (source IN ('cfo_confirmation', 'bank_statement')),
  evidence      text,
  confirmed_by  uuid,
  confirmed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_key, anchor_at)
);

ALTER TABLE public.fin_bank_anchors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_bank_anchors_read ON public.fin_bank_anchors;
CREATE POLICY fin_bank_anchors_read ON public.fin_bank_anchors FOR SELECT TO authenticated
  USING ((SELECT public._fin_can_view()));
DROP POLICY IF EXISTS mfa_required_for_staff ON public.fin_bank_anchors;
CREATE POLICY mfa_required_for_staff ON public.fin_bank_anchors AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

REVOKE ALL ON public.fin_bank_anchors FROM anon, authenticated;
GRANT SELECT ON public.fin_bank_anchors TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_bank_anchors TO service_role;

INSERT INTO public.fin_bank_anchors (account_key, account_label, anchor_at, balance, source, evidence, confirmed_by, confirmed_at)
VALUES ('equity', 'Equity Bank account (managed by Bayo Mercy)', timestamptz '2026-10-07 00:00:00+03', 0,
        'cfo_confirmation', 'CFO confirmed the balance was zero on 7 Oct 2026 (financial reporting repair, 10 Nov 2026)',
        '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', timestamptz '2026-11-10 12:00:00+03')
ON CONFLICT (account_key, anchor_at) DO NOTHING;

-- Latest anchor for an account (read-only).
CREATE OR REPLACE FUNCTION public.fin_bank_anchor(p_account_key text DEFAULT 'equity')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view bank anchors';
  END IF;
  SELECT jsonb_build_object('account_key', account_key, 'account_label', account_label, 'anchor_at', anchor_at,
                            'balance', balance, 'source', source, 'evidence', evidence, 'confirmed_at', confirmed_at)
    INTO v
  FROM public.fin_bank_anchors
  WHERE account_key = COALESCE(p_account_key, 'equity')
  ORDER BY anchor_at DESC
  LIMIT 1;
  RETURN v;  -- NULL when no anchor is recorded
END;
$function$;

REVOKE ALL ON FUNCTION public.fin_bank_anchor(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_bank_anchor(text) TO authenticated, service_role;
