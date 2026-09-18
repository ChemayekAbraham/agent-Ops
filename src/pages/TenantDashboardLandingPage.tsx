import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { supabase } from '@/integrations/supabase/client';
import { useOtpVerification } from '@/hooks/useOtpVerification';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { CountryCodeSelect } from '@/components/auth/CountryCodeSelect';
import WelileLogo from '@/components/WelileLogo';
import { setDeviceTrust } from '@/lib/deviceTrust';
import { extractEdgeFunctionError } from '@/lib/extractEdgeFunctionError';
import { toast } from 'sonner';
import { Loader2, AlertCircle, Phone, ArrowLeft, LogIn, MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TokenValidationResponse {
  valid: boolean;
  tenant_id?: string;
  first_access?: boolean;
  smartphone_confirmed?: boolean;
  device_class?: string;
  access_count?: number | null;
  phone_hint?: string | null;
  requires_verification?: boolean;
}

export default function TenantDashboardLandingPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [validating, setValidating] = useState(true);
  const [tokenData, setTokenData] = useState<TokenValidationResponse | null>(null);

  // OTP Login state
  const [phone, setPhone] = useState('');
  const [countryCode, setCountryCode] = useState('256');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [loginLoading, setLoginLoading] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  const loginOtp = useOtpVerification();

  // Validate the token on mount
  useEffect(() => {
    let cancelled = false;

    async function checkToken() {
      if (!token) {
        setTokenData({ valid: false });
        setValidating(false);
        return;
      }

      try {
        const { data, error } = await supabase.functions.invoke('tenant-dashboard-open', {
          body: { token: token.trim() },
        });

        if (cancelled) return;

        if (error || !data || !data.valid) {
          setTokenData({ valid: false });
        } else {
          setTokenData(data as TokenValidationResponse);
        }
      } catch {
        if (!cancelled) {
          setTokenData({ valid: false });
        }
      } finally {
        if (!cancelled) {
          setValidating(false);
        }
      }
    }

    checkToken();

    return () => {
      cancelled = true;
    };
  }, [token]);

  // Cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const interval = setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendCooldown]);

  const getFullPhoneNumber = useCallback((phoneVal: string, codeVal: string) => {
    const cleanDigits = phoneVal.replace(/\D/g, '');
    return cleanDigits.startsWith(codeVal)
      ? cleanDigits
      : codeVal + (cleanDigits.startsWith('0') ? cleanDigits.slice(1) : cleanDigits);
  }, []);

  const handleSendOtp = async () => {
    const fullNum = getFullPhoneNumber(phone, countryCode);
    if (fullNum.length < 10) {
      toast.error('Please enter a valid phone number');
      return;
    }

    setLoginLoading(true);
    try {
      const success = await loginOtp.sendOtp(fullNum, { category: 'login' });
      if (success) {
        setStep('code');
        setResendCooldown(60);
        toast.success('Verification code sent! Check your SMS');
      } else {
        toast.error(loginOtp.otpError || 'Could not send verification code');
      }
    } catch {
      toast.error('Network error. Please check your connection and try again.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleVerifyOtpAndLogin = async (codeToVerify?: string) => {
    const codeVal = codeToVerify || otpCode;
    const fullNum = getFullPhoneNumber(phone, countryCode);

    if (codeVal.length !== 6) {
      toast.error('Please enter the 6-digit code');
      return;
    }

    setLoginLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('otp-login', {
        body: { phone: fullNum, otp: codeVal },
      });

      if (error || !data) {
        toast.error(await extractEdgeFunctionError({ error, data }, 'Verification failed. Please try again.'));
        return;
      }

      if (data.token_hash) {
        if (data.user_name) localStorage.setItem('welile_last_user_name', data.user_name);
        localStorage.setItem('welile_last_login_method', 'otp');
        localStorage.setItem('welile_had_session', 'true');
        if (data.user_id) localStorage.setItem('welile_otp_expected_uid', data.user_id);
        setDeviceTrust(true);

        const { error: verifyErr } = await supabase.auth.verifyOtp({
          type: 'magiclink',
          token_hash: data.token_hash,
        });

        if (verifyErr) {
          toast.error(verifyErr.message || 'Could not complete login. Please try again.');
          return;
        }

        toast.success(`Welcome${data.user_name ? ', ' + data.user_name : ''}!`);
        navigate('/dashboard/tenant', { replace: true });
      } else if (data.verify_url) {
        window.location.href = data.verify_url;
      } else {
        toast.error('Login could not be verified.');
      }
    } catch {
      toast.error('Network error or request timed out. Please try again.');
    } finally {
      setLoginLoading(false);
    }
  };

  return (
    <>
      <Helmet>
        <title>Tenant Dashboard | Welile</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>

      <div className="min-h-screen bg-background flex flex-col justify-center items-center px-4 py-8">
        <div className="w-full max-w-md space-y-6">
          <div className="flex justify-center mb-2">
            <WelileLogo size="lg" />
          </div>

          {validating ? (
            <div className="bg-card border border-border/70 rounded-2xl p-8 text-center space-y-4 shadow-sm">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
              <p className="text-sm font-medium text-muted-foreground">
                Opening your tenant dashboard…
              </p>
            </div>
          ) : !tokenData?.valid ? (
            /* Plain invalid state - no reasons exposed for security */
            <div className="bg-card border border-border/70 rounded-2xl p-6 sm:p-8 text-center space-y-4 shadow-sm">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto text-muted-foreground">
                <AlertCircle className="h-6 w-6" />
              </div>
              <div className="space-y-1">
                <h1 className="text-lg font-bold text-foreground">This link is no longer valid</h1>
                <p className="text-xs text-muted-foreground">
                  If you received this link via SMS, it may have expired or already been replaced.
                </p>
              </div>

              <div className="pt-2">
                <Button
                  onClick={() => navigate('/auth')}
                  className="w-full h-12 rounded-xl font-semibold"
                >
                  Log in another way
                </Button>
              </div>
            </div>
          ) : (
            /* Valid token: Show phone hint and continue into OTP login flow */
            <div className="bg-card border border-border/70 rounded-2xl p-6 sm:p-8 space-y-5 shadow-sm">
              <div className="text-center space-y-1">
                <h1 className="text-xl font-bold text-foreground">Welcome to Your Dashboard</h1>
                {tokenData.phone_hint ? (
                  <p className="text-xs text-muted-foreground">
                    We'll text a verification code to{' '}
                    <span className="font-semibold text-foreground">{tokenData.phone_hint}</span> to
                    confirm your device.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Enter your phone number to receive a one-time verification code.
                  </p>
                )}
              </div>

              {step === 'phone' ? (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground">
                      Confirm your phone number
                    </label>
                    <div className="flex items-center gap-2">
                      <Phone className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="relative flex flex-1">
                        <CountryCodeSelect
                          value={countryCode}
                          onChange={setCountryCode}
                          triggerClassName="h-12 text-base"
                        />
                        <Input
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder={tokenData.phone_hint ? `Phone ending in ${tokenData.phone_hint.slice(-3)}` : '700 123 456'}
                          className="flex-1 h-12 text-base rounded-xl rounded-l-none"
                          style={{ fontSize: '16px' }}
                          autoFocus
                        />
                      </div>
                    </div>
                  </div>

                  <Button
                    type="button"
                    onClick={handleSendOtp}
                    disabled={loginLoading || phone.replace(/\D/g, '').length < 7}
                    className="w-full h-12 text-base rounded-xl font-bold shadow-sm touch-manipulation active:scale-[0.98]"
                  >
                    {loginLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Sending code…</span>
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        <MessageCircle className="h-4 w-4" />
                        <span>Send SMS Code</span>
                      </span>
                    )}
                  </Button>

                  <div className="text-center pt-1">
                    <Link to="/auth" className="text-xs text-muted-foreground hover:text-primary transition-colors">
                      Log in another way
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="text-center space-y-1">
                    <p className="text-sm font-semibold text-foreground">Enter the 6-digit code</p>
                    <p className="text-xs text-muted-foreground">
                      Sent to +{getFullPhoneNumber(phone, countryCode)}
                    </p>
                  </div>

                  <div className="flex justify-center py-2">
                    <InputOTP
                      maxLength={6}
                      value={otpCode}
                      onChange={(value) => {
                        setOtpCode(value);
                        if (value.length === 6) {
                          handleVerifyOtpAndLogin(value);
                        }
                      }}
                      autoFocus
                    >
                      <InputOTPGroup>
                        <InputOTPSlot index={0} className="h-12 w-11 text-lg" />
                        <InputOTPSlot index={1} className="h-12 w-11 text-lg" />
                        <InputOTPSlot index={2} className="h-12 w-11 text-lg" />
                        <InputOTPSlot index={3} className="h-12 w-11 text-lg" />
                        <InputOTPSlot index={4} className="h-12 w-11 text-lg" />
                        <InputOTPSlot index={5} className="h-12 w-11 text-lg" />
                      </InputOTPGroup>
                    </InputOTP>
                  </div>

                  <Button
                    type="button"
                    onClick={() => handleVerifyOtpAndLogin()}
                    disabled={loginLoading || otpCode.length !== 6}
                    className="w-full h-12 text-base rounded-xl font-bold shadow-sm touch-manipulation active:scale-[0.98]"
                  >
                    {loginLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Verifying…</span>
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        <LogIn className="h-4 w-4" />
                        <span>Verify & Open Dashboard</span>
                      </span>
                    )}
                  </Button>

                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setStep('phone');
                        setOtpCode('');
                      }}
                      className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" /> Change number
                    </button>

                    <button
                      type="button"
                      onClick={handleSendOtp}
                      disabled={loginLoading || resendCooldown > 0}
                      className={cn(
                        'text-xs font-medium transition-colors',
                        resendCooldown > 0
                          ? 'text-muted-foreground cursor-not-allowed'
                          : 'text-primary hover:underline',
                      )}
                    >
                      {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
