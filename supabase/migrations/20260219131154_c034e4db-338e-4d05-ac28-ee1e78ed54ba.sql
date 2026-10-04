
-- Corrected wallet balance recalculation
-- Formula: (referral bonuses as REFERRER only) + (agent_earnings EXCLUDING referral_bonus) - (agent_commission_payouts) - (withdrawal_requests approved)
-- NO "welcome bonus" — referred users do NOT get credited

WITH correct_balances AS (
  SELECT 
    w.user_id,
    -- Referral bonuses (500 each as referrer ONLY)
    COALESCE((
      SELECT COUNT(*) * 500 
      FROM referrals r 
      WHERE r.referrer_id = w.user_id AND r.credited = true
    ), 0) as referrer_bonus,
    -- First transaction bonuses (200 each)
    COALESCE((
      SELECT SUM(r.first_transaction_bonus_amount)
      FROM referrals r 
      WHERE r.referrer_id = w.user_id AND r.first_transaction_bonus_credited = true
    ), 0) as first_tx_bonus,
    -- Agent earnings EXCLUDING referral_bonus (already counted above)
    COALESCE((
      SELECT SUM(amount) 
      FROM agent_earnings ae 
      WHERE ae.agent_id = w.user_id AND ae.earning_type != 'referral_bonus'
    ), 0) as other_earnings,
    -- Approved deposits
    COALESCE((
      SELECT SUM(amount)
      FROM deposit_requests dr
      WHERE dr.user_id = w.user_id AND dr.status = 'approved'
    ), 0) as deposits,
    -- Referral rewards (monthly leaderboard)
    COALESCE((
      SELECT SUM(reward_amount)
      FROM referral_rewards rr
      WHERE rr.user_id = w.user_id AND rr.credited = true
    ), 0) as monthly_rewards,
    -- Subtract: agent commission payouts (approved)
    COALESCE((
      SELECT SUM(amount) 
      FROM agent_commission_payouts acp 
      WHERE acp.agent_id = w.user_id AND acp.status = 'approved'
    ), 0) as agent_payouts,
    -- Subtract: withdrawal requests (pending + approved, since balance is deducted on INSERT)
    COALESCE((
      SELECT SUM(amount) 
      FROM withdrawal_requests wr 
      WHERE wr.user_id = w.user_id AND wr.status IN ('pending', 'approved')
    ), 0) as withdrawals,
    w.balance as current_balance
  FROM wallets w
),
final_balances AS (
  SELECT 
    user_id,
    GREATEST(0, referrer_bonus + first_tx_bonus + other_earnings + deposits + monthly_rewards - agent_payouts - withdrawals) as correct_balance,
    current_balance
  FROM correct_balances
)
UPDATE wallets w
SET 
  balance = fb.correct_balance,
  updated_at = now()
FROM final_balances fb
WHERE w.user_id = fb.user_id
AND w.balance != fb.correct_balance;
