UPDATE public.agent_advances
SET recovery_source = 'roi',
    roi_recovery_percent = 20,
    daily_installment = 0,
    arrears_balance = 0,
    prepaid_installments_remaining = 0,
    outstanding_balance = outstanding_balance + 15333,
    updated_at = now()
WHERE id = '86d1048e-f182-42bc-a3ff-d54efb97a739';

UPDATE public.agent_advance_ledger
SET amount_deducted = 0,
    closing_balance = opening_balance,
    deduction_status = 'not_due',
    recovery_source = 'roi'
WHERE advance_id = '86d1048e-f182-42bc-a3ff-d54efb97a739';