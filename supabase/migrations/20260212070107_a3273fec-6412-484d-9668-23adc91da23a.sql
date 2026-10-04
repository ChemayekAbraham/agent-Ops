
-- Drop empty, unreferenced tables (no code usage, no FK dependencies, 0 rows)

-- AI feature tables (never used)
DROP TABLE IF EXISTS public.ai_recommendations CASCADE;
DROP TABLE IF EXISTS public.ai_notification_patterns CASCADE;
DROP TABLE IF EXISTS public.ai_collection_strategies CASCADE;
DROP TABLE IF EXISTS public.ai_user_behavior_patterns CASCADE;
DROP TABLE IF EXISTS public.ai_analysis_sessions CASCADE;

-- Investment tables (never used)
DROP TABLE IF EXISTS public.investment_interest_payments CASCADE;
DROP TABLE IF EXISTS public.investment_transactions CASCADE;
DROP TABLE IF EXISTS public.manager_investment_requests CASCADE;
DROP TABLE IF EXISTS public.investment_accounts CASCADE;

-- Loan tables (never used)
DROP TABLE IF EXISTS public.late_fees CASCADE;
DROP TABLE IF EXISTS public.late_fee_configurations CASCADE;
DROP TABLE IF EXISTS public.loan_applications CASCADE;
DROP TABLE IF EXISTS public.loan_products CASCADE;
DROP TABLE IF EXISTS public.loan_limits CASCADE;

-- Unused operational tables (0 rows, no code refs)
DROP TABLE IF EXISTS public.whatsapp_requests CASCADE;
DROP TABLE IF EXISTS public.user_login_history CASCADE;
DROP TABLE IF EXISTS public.user_activity_reports CASCADE;
DROP TABLE IF EXISTS public.automation_actions CASCADE;
DROP TABLE IF EXISTS public.account_flags CASCADE;
DROP TABLE IF EXISTS public.user_achievements CASCADE;
DROP TABLE IF EXISTS public.message_templates CASCADE;
DROP TABLE IF EXISTS public.message_reactions CASCADE;
DROP TABLE IF EXISTS public.manager_recorded_transactions CASCADE;
DROP TABLE IF EXISTS public.subagent_team_goals CASCADE;
DROP TABLE IF EXISTS public.opportunity_summaries CASCADE;
DROP TABLE IF EXISTS public.landlord_payout_requests CASCADE;
DROP TABLE IF EXISTS public.agent_verifications CASCADE;
DROP TABLE IF EXISTS public.financial_alerts CASCADE;
DROP TABLE IF EXISTS public.financial_thresholds CASCADE;
DROP TABLE IF EXISTS public.watched_opportunities CASCADE;
DROP TABLE IF EXISTS public.supporter_roi_payments CASCADE;
DROP TABLE IF EXISTS public.landlord_payment_proofs CASCADE;
DROP TABLE IF EXISTS public.welile_homes_contributions CASCADE;
DROP TABLE IF EXISTS public.welile_homes_withdrawals CASCADE;
DROP TABLE IF EXISTS public.onboarding_targets CASCADE;
DROP TABLE IF EXISTS public.platform_transactions CASCADE;
DROP TABLE IF EXISTS public.wallet_withdrawals CASCADE;
DROP TABLE IF EXISTS public.repayments CASCADE;
DROP TABLE IF EXISTS public.repayment_schedules CASCADE;
DROP TABLE IF EXISTS public.force_refresh_signals CASCADE;
DROP TABLE IF EXISTS public.audit_logs CASCADE;
DROP TABLE IF EXISTS public.landlord_agreement_acceptance CASCADE;
DROP TABLE IF EXISTS public.agent_agreement_acceptance CASCADE;
DROP TABLE IF EXISTS public.payment_confirmations CASCADE;
