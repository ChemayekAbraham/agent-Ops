-- Add sub_category to withdrawal_requests for categorizing payouts (repair, rent, commission, etc.)
ALTER TABLE withdrawal_requests
ADD COLUMN IF NOT EXISTS sub_category TEXT NOT NULL DEFAULT 'general'
CHECK (sub_category IN ('general', 'repair', 'rent', 'commission', 'investment', 'roi'));

-- Add sub_category to investment_withdrawal_requests for partner payout categorization
ALTER TABLE investment_withdrawal_requests
ADD COLUMN IF NOT EXISTS sub_category TEXT NOT NULL DEFAULT 'investment'
CHECK (sub_category IN ('general', 'repair', 'rent', 'commission', 'investment', 'roi'));

-- Index for fast CFO filtering by sub_category
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_sub_category_status
ON withdrawal_requests(sub_category, status);

CREATE INDEX IF NOT EXISTS idx_investment_withdrawal_requests_sub_category_status
ON investment_withdrawal_requests(sub_category, status);

-- Also add index on just sub_category for broader queries
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_sub_category
ON withdrawal_requests(sub_category);

CREATE INDEX IF NOT EXISTS idx_investment_withdrawal_requests_sub_category
ON investment_withdrawal_requests(sub_category);

-- Update planner stats
ANALYZE withdrawal_requests;
ANALYZE investment_withdrawal_requests;
