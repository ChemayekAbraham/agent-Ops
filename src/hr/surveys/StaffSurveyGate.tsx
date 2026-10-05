import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, ClipboardList } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

/**
 * Blocking staff survey — shown to everyone holding an enabled employee role,
 * one survey at a time, until they answer. Modelled on StaffLoanApprovalGate.
 * FAIL OPEN: renders only when staff_survey_pending() succeeds and returns a row.
 * Answers are recorded only; nothing on any payslip changes because of them.
 */

const POLL_MS = 5 * 60 * 1000;
const SNOOZE_MS = 60 * 60 * 1000;
const PERCENTAGES = Array.from({ length: 20 }, (_, i) => (i + 1) * 5);

interface Survey {
  survey_id: string;
  kind: 'statutory_consent' | 'reinvestment_pledge';
  title: string;
  body: string;
  snooze_count: number;
  cycle_start: string | null;
  last_response: string | null;
  last_percentage: number | null;
  last_payout_mode: string | null;
  needs_payout_mode: boolean;
}

type PayoutMode = 'monthly_payout' | 'monthly_compounding';

interface WsrPortfolio {
  id: string;
  portfolio_code: string;
  investment_amount: number | null;
}

const PAYOUT_LABEL: Record<PayoutMode, string> = {
  monthly_payout: 'Monthly withdrawable returns',
  monthly_compounding: 'Compounding',
};

export function StaffSurveyGate() {
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [mode, setMode] = useState<'ask' | 'accept' | 'decline'>('ask');
  const [tin, setTin] = useState('');
  const [nssf, setNssf] = useState('');
  const [noTin, setNoTin] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [payout, setPayout] = useState<PayoutMode | null>(null);
  const [working, setWorking] = useState(false);
  const suppressedUntilRef = useRef(0);
  const location = useLocation();
  const navigate = useNavigate();
  const [wsr, setWsr] = useState<WsrPortfolio | null>(null);
  const [wsrWorking, setWsrWorking] = useState(false);
  const wsrSuppressedUntilRef = useRef(0);

  const load = useCallback(async () => {
    if (Date.now() < suppressedUntilRef.current) return;
    try {
      const { data, error } = await supabase.rpc('staff_survey_pending' as never);
      if (error) { setSurvey(null); return; }
      const raw = data as unknown;
      const row = (Array.isArray(raw) ? raw[0] : raw) as Survey | undefined | null;
      setSurvey(row ?? null);
    } catch {
      setSurvey(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // Re-check on every navigation, exactly like the payroll prompt, so a survey
  // reappears promptly once its hour is up.
  useEffect(() => {
    void load();
  }, [location.pathname, load]);

  // Read-only check for a staff salary reinvestment portfolio awaiting signature.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (Date.now() < wsrSuppressedUntilRef.current) { setWsr(null); return; }
      try {
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) { if (!cancelled) setWsr(null); return; }
        const { data, error } = await supabase
          .from('investor_portfolios')
          .select('id, portfolio_code, investment_amount')
          .eq('investor_id', uid)
          .eq('status', 'awaiting_partner_details')
          .like('portfolio_code', 'WSR%')
          .order('created_at', { ascending: true })
          .limit(1);
        if (cancelled) return;
        setWsr(error ? null : ((data?.[0] as WsrPortfolio | undefined) ?? null));
      } catch {
        if (!cancelled) setWsr(null);
      }
    })();
    return () => { cancelled = true; };
  }, [location.pathname]);

  useEffect(() => {
    setMode('ask');
    setTin('');
    setNssf('');
    setNoTin(false);
    setPct(survey?.last_percentage ?? null);
    setPayout((survey?.last_payout_mode as PayoutMode | null) ?? null);
  }, [survey?.survey_id]);

  const respond = async (response: 'accept' | 'decline' | 'pledge') => {
    if (!survey) return;
    setWorking(true);
    const { error } = await supabase.rpc('staff_survey_respond' as never, {
      _survey_id: survey.survey_id,
      _response: response,
      _percentage: response === 'pledge' ? pct : null,
      _tin: response === 'accept' && !noTin ? tin.trim() : null,
      _nssf_number: response === 'accept' ? nssf.trim() || null : null,
      _no_tin: response === 'accept' ? noTin : false,
      _payout_mode: response === 'pledge' ? payout : null,
    } as never);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Thank you — your answer has been recorded.');
    setSurvey(null);
    void load();
  };

  const setPayoutOnly = async () => {
    if (!survey || !payout) return;
    setWorking(true);
    const { error } = await supabase.rpc('staff_survey_set_payout_mode' as never, {
      _survey_id: survey.survey_id,
      _payout_mode: payout,
    } as never);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Thank you — your return option has been recorded.');
    setSurvey(null);
    void load();
  };

  const later = async () => {
    if (!survey) return;
    setWorking(true);
    const { error } = await supabase.rpc('staff_survey_snooze' as never, {
      _survey_id: survey.survey_id,
    } as never);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    suppressedUntilRef.current = Date.now() + SNOOZE_MS;
    setSurvey(null);
  };

  const openSigning = async () => {
    setWsrWorking(true);
    const { data, error } = await supabase.rpc('hr_pay_my_reinvest_signing_link' as never);
    setWsrWorking(false);
    const res = data as { status?: string; url?: string } | null;
    if (error || res?.status !== 'ok' || !res?.url) {
      toast.error(error?.message ?? 'Could not open your signing link. Please try again.');
      return;
    }
    setWsr(null);
    navigate(res.url);
  };

  if (!survey) {
    if (!wsr || location.pathname.startsWith('/partners/')) return null;
    return (
      <Dialog open onOpenChange={() => { /* cannot be dismissed */ }}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-lg [&>button]:hidden"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-primary" /> Sign your salary reinvestment agreement
            </DialogTitle>
            <DialogDescription>From HR · please read and respond</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              UGX {Number(wsr.investment_amount ?? 0).toLocaleString('en-US')} from your salary is in portfolio {wsr.portfolio_code}, earning 20% a month. Confirm your details and sign so Welile can activate it and send you the contract.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button onClick={() => void openSigning()} disabled={wsrWorking}>
                {wsrWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Sign now
              </Button>
              <Button
                variant="outline"
                disabled={wsrWorking}
                onClick={() => { wsrSuppressedUntilRef.current = Date.now() + SNOOZE_MS; setWsr(null); }}
              >
                Later
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const isStatutory = survey.kind === 'statutory_consent';
  const tinValid = noTin || /^[0-9]{10}$/.test(tin.trim());

  if (survey.needs_payout_mode) {
    return (
      <Dialog open onOpenChange={() => { /* cannot be dismissed */ }}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-lg [&>button]:hidden"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-primary" /> One more choice about your reinvestment
            </DialogTitle>
            <DialogDescription>From HR · please read and respond</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              You chose to reinvest <strong>{survey.last_percentage ?? 0}%</strong> of your salary.
              Your investment earns 20% per month. Choose how you receive that return:
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(PAYOUT_LABEL) as PayoutMode[]).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={payout === m ? 'default' : 'outline'}
                  disabled={working}
                  onClick={() => setPayout(m)}
                >
                  {PAYOUT_LABEL[m]}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Monthly withdrawable returns: your 20% is paid to your wallet every month.
              Compounding: your 20% is added to your principal every month.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button onClick={() => void setPayoutOnly()} disabled={working || payout === null}>
                {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {payout === null ? 'Choose an option' : `Confirm ${PAYOUT_LABEL[payout]}`}
              </Button>
              <Button variant="outline" onClick={() => void later()} disabled={working}>Later</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={() => { /* cannot be dismissed */ }}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg [&>button]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-primary" /> {survey.title}
          </DialogTitle>
          <DialogDescription>From HR · please read and respond</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {survey.snooze_count > 0 && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700">
              Deferred {survey.snooze_count} {survey.snooze_count === 1 ? 'time' : 'times'} already
            </Badge>
          )}

          <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {survey.body}
          </p>

          {isStatutory && mode === 'accept' && (
            <div className="space-y-3 rounded-xl border p-3">
              <div className="space-y-1.5">
                <Label htmlFor="survey-tin">Your TIN (10 digits)</Label>
                <Input
                  id="survey-tin"
                  inputMode="numeric"
                  maxLength={10}
                  value={tin}
                  disabled={noTin}
                  onChange={(e) => setTin(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="e.g. 1000123456"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={noTin}
                  onChange={(e) => setNoTin(e.target.checked)}
                />
                I do not have a TIN yet
              </label>
              <div className="space-y-1.5">
                <Label htmlFor="survey-nssf">Your NSSF number (optional)</Label>
                <Input
                  id="survey-nssf"
                  value={nssf}
                  onChange={(e) => setNssf(e.target.value)}
                />
              </div>
            </div>
          )}

          {isStatutory && mode === 'decline' && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-800">
              Your current salary will stay your take-home pay. Your answer will be recorded
              and HR will contact you.
            </p>
          )}

          {!isStatutory && survey.last_response && (
            <p className="rounded-md border p-2 text-xs text-muted-foreground">
              Last month you chose{' '}
              <strong>
                {survey.last_response === 'pledge'
                  ? `${survey.last_percentage ?? 0}%${survey.last_payout_mode ? ` · ${PAYOUT_LABEL[survey.last_payout_mode as PayoutMode] ?? ''}` : ''}`
                  : 'not to reinvest'}
              </strong>
              . Confirm it again or change it below.
            </p>
          )}

          {!isStatutory && (
            <div className="grid grid-cols-5 gap-2">
              {PERCENTAGES.map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={pct === p ? 'default' : 'outline'}
                  disabled={working}
                  onClick={() => setPct(p)}
                >
                  {p}%
                </Button>
              ))}
            </div>
          )}

          {!isStatutory && (
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(PAYOUT_LABEL) as PayoutMode[]).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={payout === m ? 'default' : 'outline'}
                  disabled={working}
                  onClick={() => setPayout(m)}
                >
                  {PAYOUT_LABEL[m]}
                </Button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {isStatutory && mode === 'ask' && (
              <>
                <Button onClick={() => setMode('accept')} disabled={working}>Accept</Button>
                <Button variant="destructive" onClick={() => setMode('decline')} disabled={working}>
                  Decline
                </Button>
                <Button variant="outline" onClick={() => void later()} disabled={working}>Later</Button>
              </>
            )}
            {isStatutory && mode === 'accept' && (
              <>
                <Button variant="outline" onClick={() => setMode('ask')} disabled={working}>Back</Button>
                <Button onClick={() => void respond('accept')} disabled={working || !tinValid}>
                  {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm and accept
                </Button>
              </>
            )}
            {isStatutory && mode === 'decline' && (
              <>
                <Button variant="outline" onClick={() => setMode('ask')} disabled={working}>Back</Button>
                <Button variant="destructive" onClick={() => void respond('decline')} disabled={working}>
                  {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm decline
                </Button>
              </>
            )}
            {!isStatutory && (
              <>
                <Button onClick={() => void respond('pledge')} disabled={working || pct === null || payout === null}>
                  {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {pct === null
                    ? 'Choose a percentage'
                    : payout === null
                      ? 'Choose how you receive returns'
                      : `Confirm ${pct}% · ${payout === 'monthly_payout' ? 'monthly returns' : 'compounding'}`}
                </Button>
                <Button variant="destructive" onClick={() => void respond('decline')} disabled={working}>
                  Decline
                </Button>
                <Button variant="outline" onClick={() => void later()} disabled={working}>Later</Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default StaffSurveyGate;
