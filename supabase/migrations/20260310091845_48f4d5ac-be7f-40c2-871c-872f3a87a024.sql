-- Backfill investor_id where it's NULL but agent_id is set (self-invested)
UPDATE investor_portfolios 
SET investor_id = agent_id 
WHERE investor_id IS NULL;