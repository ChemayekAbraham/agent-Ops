-- The bucket router trigger already credited the float from the ledger entries.
-- Our manual UPDATE in the previous migration double-counted. Remove the duplicate.
UPDATE agent_landlord_float
SET balance = balance - 142400,
    total_funded = total_funded - 142400,
    updated_at = now()
WHERE agent_id = '04ef6aad-ade8-4dbc-ae3f-09669a836952';