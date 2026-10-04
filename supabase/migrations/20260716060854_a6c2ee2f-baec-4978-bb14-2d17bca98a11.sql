
ALTER TABLE public.kyc_risk_events DROP CONSTRAINT kyc_risk_events_event_type_check;
ALTER TABLE public.kyc_risk_events ADD CONSTRAINT kyc_risk_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'otp_excess','pin_fail_burst','rapid_withdraw','device_multi_account',
    'velocity_burst','suspicious_pattern','login_anomaly','signup_device_reuse',
    'new_user_over_cap_attempt'
  ]));
