-- Bug found via a real agent complaint (Okwakol Micheal / "Mike", 2026-09-23):
-- he deposited UGX 80,000 via MoMo, Financial Ops routed the matching Email
-- Transaction to his agent float through the "Email Transactions" panel
-- (RouteEmailDepositDialog.tsx -> cfo-direct-credit edge function), and the
-- gate from migration 20260921100000 still refused to let him allocate a
-- tenant payment with it: "TID-backed balance: 0, Requested: 80000."
--
-- Root cause: tg_credit_tid_backed_float() only recognized a credit as
-- TID-backed when category='agent_float_deposit' AND
-- source_table='deposit_requests' (joined to gmail_transactions via
-- deposit_requests.transaction_id). The cfo-direct-credit edge function --
-- Financial Ops' path for routing an inbound deposit email/SMS that FAILED
-- AUTO-MATCHING -- posts the exact same category but source_table=
-- 'cfo_direct_credit', with the real gmail TID stamped into sub_category
-- instead. Money credited this way was structurally invisible to the
-- TID-backed tracker from day one, even though it originates from the same
-- gmail_transactions row a deposit_requests match would have used.
--
-- Verified live: Mike's two routed credits (sub_category = 'TID157147029064'
-- / 'TID157053803819', UGX 80,000 + 25,000) both match a real
-- gmail_transactions.transaction_id with an equal amount.
--
-- IMPORTANT -- scope, per Josh (2026-09-23): a full platform-wide recompute
-- was tried first and reverted. Recomputing every agent's balance from the
-- full reflected-random-walk history (as the original 20260921100000 seed
-- does) is NOT purely additive -- because it also newly recognizes
-- cfo_direct_credit CASH_OUT events (debits/reversals on this same path)
-- for the first time, the recompute moved 41 agents' balances in BOTH
-- directions (19 up, 22 down, by amounts up to several million UGX each),
-- none of it visible on any agent's actual wallet balance
-- (get_user_wallet_view() reads wallet_balances_projection, never this
-- table) but still far more than the one verified complaint warranted.
-- Decision: keep the trigger fix (forward-looking, safe -- it only affects
-- events posted from now on) but do NOT retroactively recompute anyone
-- else's balance. Only Mike's row -- the one case actually investigated and
-- verified end-to-end -- is corrected here, by exact amount, not by re-
-- deriving his whole history. If another agent reports the same symptom,
-- verify their specific cfo_direct_credit rows against gmail_transactions
-- the same way before crediting anything -- do not re-run a platform-wide
-- recompute.

CREATE OR REPLACE FUNCTION public.tg_credit_tid_backed_float()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.ledger_scope <> 'wallet' OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.category = 'agent_float_deposit' AND NEW.source_table = 'deposit_requests' THEN
    IF NEW.direction = 'cash_in' AND EXISTS (
      SELECT 1 FROM public.deposit_requests dr
        JOIN public.gmail_transactions gt ON gt.transaction_id = dr.transaction_id
       WHERE dr.id = NEW.source_id
    ) THEN
      PERFORM public.credit_agent_tid_backed_float(NEW.user_id, NEW.amount);
    ELSIF NEW.direction = 'cash_out' THEN
      PERFORM public.credit_agent_tid_backed_float(NEW.user_id, -NEW.amount);
    END IF;
  ELSIF NEW.category = 'agent_float_deposit' AND NEW.source_table = 'cfo_direct_credit' THEN
    -- Financial Ops manually routing an unmatched inbound deposit email/SMS
    -- to an agent's float. Verify against gmail_transactions the same way
    -- the deposit_requests branch does -- do not trust the source_table
    -- label alone, since most cfo_direct_credit rows carry no TID at all.
    IF NEW.direction = 'cash_in' AND NEW.sub_category IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.gmail_transactions gt WHERE gt.transaction_id = NEW.sub_category
    ) THEN
      PERFORM public.credit_agent_tid_backed_float(NEW.user_id, NEW.amount);
    ELSIF NEW.direction = 'cash_out' THEN
      PERFORM public.credit_agent_tid_backed_float(NEW.user_id, -NEW.amount);
    END IF;
  ELSIF NEW.category = 'bucket_reclass_in' AND NEW.direction = 'cash_in'
        AND NEW.source_table = 'agent_withdrawable_to_float' THEN
    PERFORM public.credit_agent_tid_backed_float(NEW.user_id, NEW.amount);
  END IF;

  RETURN NEW;
END;
$function$;

-- Scoped, single-agent correction -- NOT a platform-wide recompute (see
-- comment above). Mike's two verified cfo_direct_credit deposits
-- (80,000 + 25,000 = 105,000) were never credited to his TID-backed pool;
-- his pre-existing historical component (deposit_requests + bucket_reclass
-- events only, matching the ORIGINAL 20260921100000 seed formula) was
-- separately confirmed to already be 0, so his corrected total is exactly
-- 105,000 -- not re-derived from a fresh full-history walk.
UPDATE public.agent_tid_backed_float
SET balance = 105000, updated_at = now()
WHERE agent_id = '75891dff-d684-49e9-83ea-fab6e4cb4ded';
