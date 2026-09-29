-- Clamp amount_repaid AFTER the plan total is recalculated; fix the two plans it missed.
--
-- BEFORE triggers fire in name order. trg_clamp_rent_request_amount_repaid sorted
-- ahead of trg_enforce_outstanding_total_repayment / trg_enforce_rent_request_formula,
-- so on a downward plan resize it compared amount_repaid against the OLD, larger
-- total and let it through. On 2026-09-24 both of Kalule Brian's plans were resized
-- to UGX 600,000 and read "overpaid" by 135,000 and 130,731 ever since — the
-- monitor's "Tenant repaid more than the plan total" check.
--
-- No cash sits behind the excess (77,223 and 0 of live collections), so this is
-- not a refund: the balance is capped at the plan total, which is exactly what the
-- clamp would have done had it run last. No ledger posting. docs/HANDOVER/164.
--
-- Renamed zz_clamp_… so it sorts after every trigger that sets total_repayment or
-- amount_repaid; only zz_gate_repaying_… (status only) sorts later. Function body
-- unchanged.

BEGIN;

DROP TRIGGER IF EXISTS trg_clamp_rent_request_amount_repaid ON public.rent_requests;
DROP TRIGGER IF EXISTS zz_clamp_rent_request_amount_repaid ON public.rent_requests;
CREATE TRIGGER zz_clamp_rent_request_amount_repaid
  BEFORE INSERT OR UPDATE ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.clamp_rent_request_amount_repaid();

INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
SELECT 'cb798acb-68bc-4b4e-a414-a3d374e030b6', 'plan_overpaid_capped', 'rent_requests', rr.id::text,
       'amount_repaid capped at total_repayment after a downward resize slipped past the clamp (doc 164)',
       jsonb_build_object('before', rr.amount_repaid, 'after', rr.total_repayment,
                          'excess_removed', rr.amount_repaid - rr.total_repayment)
  FROM public.rent_requests rr
 WHERE COALESCE(rr.total_repayment,0) > 0 AND rr.amount_repaid > rr.total_repayment;

UPDATE public.rent_requests
   SET amount_repaid = total_repayment
 WHERE COALESCE(total_repayment,0) > 0 AND amount_repaid > total_repayment;

COMMIT;
