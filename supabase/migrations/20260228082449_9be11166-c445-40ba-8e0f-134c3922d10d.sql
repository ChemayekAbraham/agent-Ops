-- Disable only user triggers on rent_requests
ALTER TABLE rent_requests DISABLE TRIGGER USER;

UPDATE rent_requests 
SET status = 'funded', updated_at = now()
WHERE funded_at IS NOT NULL 
AND status = 'approved';

ALTER TABLE rent_requests ENABLE TRIGGER USER;