import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Save } from 'lucide-react';

export interface AgreementRatePortfolio {
  id: string;
  portfolio_code: string | null;
  roi_percentage: number;
}

export default function AgreementRateInput({ portfolios, initialId, initialRate, partnerId, onApprovalState, onRateSaved, onRatePreview }: {
  portfolios: AgreementRatePortfolio[];
  initialId?: string | null;
  initialRate?: number;
  partnerId?: string;
  onApprovalState?: (ready: boolean) => void;
  onRateSaved: (rate: number) => void;
  onRatePreview?: (rate: number, unsaved: boolean) => void;
}) {
  const { toast } = useToast();
  const [portfolioId, setPortfolioId] = useState(initialId || portfolios[0]?.id || '');
  const portfolio = portfolios.find((item) => item.id === portfolioId);
  const [rate, setRate] = useState(String(portfolio?.roi_percentage ?? initialRate ?? ''));
  const [activeRate, setActiveRate] = useState(portfolio?.roi_percentage ?? initialRate);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [checking, setChecking] = useState(false);
  const [approvalReady, setApprovalReady] = useState(true);
  useEffect(() => {
    setRate(String(portfolio?.roi_percentage ?? initialRate ?? ''));
    setActiveRate(portfolio?.roi_percentage ?? initialRate);
    setNotice('');
  }, [portfolioId, portfolio?.roi_percentage]);

  const applyAgreementResult = (data: unknown) => {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('rate_in_force' in data) || typeof data.rate_in_force !== 'number' || !('ready' in data) || typeof data.ready !== 'boolean') {
      throw new Error('The saved agreement rate could not be confirmed.');
    }
    const result = data as { rate_in_force: number; ready: boolean; requested_rate?: number; status?: string; decision_note?: string };
    setApprovalReady(result.ready);
    onApprovalState?.(result.ready);
    setActiveRate(result.rate_in_force);
    setRate(String(result.requested_rate ?? result.rate_in_force));
    onRateSaved(result.rate_in_force);
    setNotice(result.status === 'pending' ? `${result.requested_rate}% requested — awaiting CFO approval. Countersigning is unavailable until approved.`
      : result.status === 'rejected' ? `Rate rejected. ${result.decision_note || 'Save another rate for review.'}`
      : result.status === 'approved' ? `Agreement rate approved: ${result.rate_in_force}%.` : '');
  };
  const checkApproval = async () => {
    if (!partnerId || portfolio) return;
    setChecking(true);
    onApprovalState?.(false);
    try {
      const { data, error } = await supabase.rpc('get_partner_agreement_rate', { p_partner_id: partnerId });
      if (error) throw error;
      applyAgreementResult(data);
    } catch (error) {
      setApprovalReady(false);
      toast({ title: 'Could not check rate approval', description: String((error as { message?: string })?.message || 'Try again.'), variant: 'destructive' });
    } finally { setChecking(false); }
  };
  useEffect(() => {
    if (!partnerId || portfolio) return;
    let cancelled = false;
    onApprovalState?.(false);
    setChecking(true);
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('get_partner_agreement_rate', { p_partner_id: partnerId });
        if (cancelled) return;
        if (error) throw error;
        applyAgreementResult(data);
      } catch {
        if (!cancelled) { setApprovalReady(false); setNotice('Approval could not be checked. Try again.'); }
      } finally { if (!cancelled) setChecking(false); }
    })();
    return () => { cancelled = true; };
  }, [partnerId, portfolioId]);

  const save = async () => {
    const requestedRate = Number(rate);
    if ((!portfolio && !partnerId) || !rate.trim() || !Number.isFinite(requestedRate) || requestedRate <= 0 || requestedRate > 100) return;
    setBusy(true);
    try {
      if (!portfolio && partnerId) {
        const { data, error } = await supabase.rpc('set_partner_agreement_rate', { p_partner_id: partnerId, p_requested_rate: requestedRate });
        if (error) throw error;
        applyAgreementResult(data);
        return;
      }
      if (!portfolio) return;
      const { data, error } = await supabase.rpc('set_portfolio_renewal_rate', {
        p_portfolio_id: portfolio.id, p_requested_rate: requestedRate,
      });
      if (error) throw error;
      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.rate_in_force !== 'number') {
        throw new Error('The saved Returns rate could not be confirmed.');
      }
      onRateSaved(data.rate_in_force);
      setActiveRate(data.rate_in_force);
      setRate(String(data.rate_in_force));
      setNotice(data.awaits_cfo === true
        ? `${requestedRate}% requested — awaiting CFO approval. The agreement keeps ${data.rate_in_force}%.`
        : `Returns rate saved: ${data.rate_in_force}%.`);
    } catch (error) {
      toast({ title: 'Could not save the Returns rate', description: error instanceof Error ? error.message : String((error as { message?: string })?.message || 'Try again.'), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <Label htmlFor="agreement-returns-rate" className="text-[11px]">Monthly Returns rate (%)</Label>
      {portfolios.length > 1 && (
        <select aria-label="Returns rate portfolio" value={portfolioId} disabled={busy} className="w-full h-8 rounded-md border border-input bg-background text-xs" onChange={(event) => {
          setPortfolioId(event.target.value);
          const selected = portfolios.find((item) => item.id === event.target.value);
          if (selected) onRateSaved(selected.roi_percentage);
        }}>
          {portfolios.map((item) => <option key={item.id} value={item.id}>{item.portfolio_code || item.id}</option>)}
        </select>
      )}
      <div className="flex gap-2">
        <Input id="agreement-returns-rate" type="number" inputMode="decimal" min={0} max={100} step="any" value={rate} disabled={busy || checking} onChange={(event) => {
          const value = event.target.value;
          setRate(value);
          const numericRate = Number(value);
          if (!value.trim() || !Number.isFinite(numericRate) || numericRate <= 0 || numericRate > 100) onRatePreview?.(activeRate ?? initialRate ?? 0, true);
          if (value.trim() && Number.isFinite(numericRate) && numericRate > 0 && numericRate <= 100) {
            onRatePreview?.(numericRate, numericRate !== activeRate);
            setNotice(numericRate !== activeRate ? 'Draft rate — not yet saved or approved.' : '');
          }
        }} className="h-8 text-xs" />
        <Button type="button" size="sm" variant="outline" onClick={() => void save()} disabled={busy || checking || (!portfolio && !partnerId) || !rate.trim() || !Number.isFinite(Number(rate)) || Number(rate) <= 0 || Number(rate) > 100} className="h-8 gap-1 text-xs">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save rate
        </Button>
      </div>
      {!portfolio && !partnerId && <p className="text-[10px] text-muted-foreground">Draft only — saving actual Returns requires a portfolio.</p>}
      {!portfolio && partnerId && !approvalReady && <Button type="button" variant="outline" size="sm" disabled={checking || busy} onClick={() => void checkApproval()}>Check approval</Button>}
      {notice && <p role="status" className="text-[10px] text-muted-foreground">{notice}</p>}
    </div>
  );
}