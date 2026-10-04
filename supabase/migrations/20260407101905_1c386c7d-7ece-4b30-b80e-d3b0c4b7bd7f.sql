ALTER TABLE agent_float_funding
  ADD COLUMN IF NOT EXISTS bank_reference TEXT,
  ADD COLUMN IF NOT EXISTS bank_name TEXT DEFAULT 'Equity Bank Uganda',
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' NOT NULL;