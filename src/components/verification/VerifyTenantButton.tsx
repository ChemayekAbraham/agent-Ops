import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Shield, CheckCircle2, Loader2, XCircle, KeyRound, Zap, Droplets, FileText, HandHeart } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { hapticTap, hapticSuccess, hapticError } from '@/lib/haptics';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface VerifyTenantButtonProps {
  requestId: string;
  landlordId?: string;
  agentVerified?: boolean;
  managerVerified?: boolean;
  onVerified: () => void;
  variant?: 'agent' | 'manager';
}

export function VerifyTenantButton({ 
  requestId, 
  landlordId,
  agentVerified, 
  managerVerified, 
  onVerified,
  variant = 'agent'
}: VerifyTenantButtonProps) {
  const { user, role } = useAuth();
  const [loading, setLoading] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [showGuaranteeConfirm, setShowGuaranteeConfirm] = useState(false);
  const [guaranteeLoading, setGuaranteeLoading] = useState(false);
  
  // Agent verification form fields
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  const [tin, setTin] = useState('');
  const [landlordWaterMeter, setLandlordWaterMeter] = useState('');
  const [landlordElectricityMeter, setLandlordElectricityMeter] = useState('');
  const [tenantWaterMeter, setTenantWaterMeter] = useState('');
  const [tenantElectricityMeter, setTenantElectricityMeter] = useState('');
  const [verificationResult, setVerificationResult] = useState<null | { match: boolean; details: Record<string, boolean> }>(null);

  const isAgent = variant === 'agent';
  const isAlreadyVerified = isAgent ? agentVerified : managerVerified;
  const canVerify = isAgent ? role === 'agent' : role === 'manager';

  const handleGuarantee = async () => {
    if (!user) return;
    hapticTap();
    setGuaranteeLoading(true);
    try {
      const { error } = await supabase
        .from('rent_requests')
        .update({
          agent_verified: true,
          agent_verified_at: new Date().toISOString(),
          agent_verified_by: user.id,
          agent_id: user.id,
        })
        .eq('id', requestId);

      if (error) throw error;

      // No UGX 5,000 verification bonus for guarantee — agent skipped full verification

      hapticSuccess();
      toast.success('Tenant guaranteed! No verification bonus — you skipped full verification.');
      setShowGuaranteeConfirm(false);
      onVerified();
    } catch (error: any) {
      hapticError();
      toast.error(error.message || 'Failed to guarantee tenant');
    } finally {
      setGuaranteeLoading(false);
    }
  };



  const handleManagerVerify = async () => {
    if (!user || role !== 'manager') return;
    hapticTap();
    setLoading(true);
    try {
      const { error } = await supabase
        .from('rent_requests')
        .update({
          manager_verified: true,
          manager_verified_at: new Date().toISOString(),
          manager_verified_by: user.id
        })
        .eq('id', requestId);
      if (error) throw error;
      toast.success('Manager verification complete!');
      onVerified();
    } catch (error: any) {
      toast.error(error.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleAgentVerify = async () => {
    if (!user || !landlordId) return;
    if (pin1.trim() && pin1.length !== 4) {
      toast.error('PIN 1 must be exactly 4 digits');
      return;
    }
    if (pin2.trim() && pin2.length !== 4) {
      toast.error('PIN 2 must be exactly 4 digits');
      return;
    }
    hapticTap();
    setLoading(true);
    setVerificationResult(null);

    try {
      const { data: landlord } = await supabase
        .from('landlords')
        .select('verification_pin_1, verification_pin_2, tin, water_meter_number, electricity_meter_number')
        .eq('id', landlordId)
        .single();

      const { data: request } = await supabase
        .from('rent_requests')
        .select('tenant_water_meter, tenant_electricity_meter')
        .eq('id', requestId)
        .single();

      if (!landlord) {
        toast.error('Landlord data not found');
        setLoading(false);
        return;
      }

      const normalize = (v: string | null | undefined) => (v || '').trim().toUpperCase();

      const pin1Match = (pin1.trim() && landlord.verification_pin_1) ? normalize(pin1) === normalize(landlord.verification_pin_1) : null;
      const pin2Match = (pin2.trim() && landlord.verification_pin_2) ? normalize(pin2) === normalize(landlord.verification_pin_2) : null;
      const tinMatch = (tin.trim() && landlord.tin) ? normalize(tin) === normalize(landlord.tin) : null;
      const landlordWaterMatch = landlord.water_meter_number ? normalize(landlordWaterMeter) === normalize(landlord.water_meter_number) : null;
      const landlordElecMatch = landlord.electricity_meter_number ? normalize(landlordElectricityMeter) === normalize(landlord.electricity_meter_number) : null;
      const tenantWaterMatch = request?.tenant_water_meter ? normalize(tenantWaterMeter) === normalize(request.tenant_water_meter) : null;
      const tenantElecMatch = request?.tenant_electricity_meter ? normalize(tenantElectricityMeter) === normalize(request.tenant_electricity_meter) : null;

      const allChecks = [pin1Match, pin2Match, tinMatch, landlordWaterMatch, landlordElecMatch, tenantWaterMatch, tenantElecMatch].filter(v => v !== null);
      const overallMatch = allChecks.length === 0 || allChecks.every(v => v === true);

      const details: Record<string, boolean> = {};
      if (pin1Match !== null) details['Landlord PIN 1'] = pin1Match;
      if (pin2Match !== null) details['Landlord PIN 2'] = pin2Match;
      if (tinMatch !== null) details['Landlord TIN'] = tinMatch;
      if (landlordWaterMatch !== null) details['Landlord NWSC Meter'] = landlordWaterMatch;
      if (landlordElecMatch !== null) details['Landlord UEDCL Meter'] = landlordElecMatch;
      if (tenantWaterMatch !== null) details['Tenant NWSC Meter'] = tenantWaterMatch;
      if (tenantElecMatch !== null) details['Tenant UEDCL Meter'] = tenantElecMatch;

      setVerificationResult({ match: overallMatch, details });

      if (overallMatch) {
        hapticSuccess();
        await supabase
          .from('rent_requests')
          .update({
            agent_verified: true,
            agent_verified_at: new Date().toISOString(),
            agent_verified_by: user.id,
            agent_id: user.id,
          })
          .eq('id', requestId);

        toast.success('Verification successful! Tenant is verified.');
        setTimeout(() => {
          setShowDialog(false);
          onVerified();
        }, 1500);
      } else {
        hapticError();
        toast.error('Verification failed - details do not match.');
      }
    } catch (error: any) {
      toast.error(error.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  if (isAlreadyVerified) {
    return (
      <Badge 
        variant="outline" 
        className={`gap-1 ${isAgent ? 'bg-success/10 text-success border-success/30' : 'bg-primary/10 text-primary border-primary/30'}`}
      >
        <CheckCircle2 className="h-3 w-3" />
        {isAgent ? 'Agent Verified' : 'Manager Verified'}
      </Badge>
    );
  }

  if (!canVerify) return null;

  // Manager: simple verify button
  if (!isAgent) {
    return (
      <Button
        size="sm"
        variant="default"
        onClick={handleManagerVerify}
        disabled={loading}
        className="gap-1.5"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
        Verify Tenant
      </Button>
    );
  }

  // Agent: two options — quick guarantee OR detailed verification
  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            hapticTap();
            setShowGuaranteeConfirm(true);
          }}
          className="gap-1.5 border-primary/30 text-primary hover:bg-primary/10"
        >
          <HandHeart className="h-4 w-4" />
          I Guarantee
        </Button>
        <Button
          size="sm"
          variant="success"
          onClick={() => {
            hapticTap();
            setShowDialog(true);
            setVerificationResult(null);
            setPin1(''); setPin2(''); setTin('');
            setLandlordWaterMeter(''); setLandlordElectricityMeter('');
            setTenantWaterMeter(''); setTenantElectricityMeter('');
          }}
          className="gap-1.5"
        >
          <Shield className="h-4 w-4" />
          Full Verify
        </Button>
      </div>

      {/* Quick Guarantee Confirmation */}
      <AlertDialog open={showGuaranteeConfirm} onOpenChange={setShowGuaranteeConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <HandHeart className="h-5 w-5 text-primary" />
              Guarantee This Tenant?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  By tapping <strong>"I Guarantee"</strong>, you are personally vouching for this tenant. 
                  This means you trust them to repay on time.
                </p>
                <p className="font-medium text-amber-600">
                  ⚠️ You will NOT earn the UGX 5,000 verification bonus. Use "Full Verify" to earn it.
                </p>
                <p className="text-destructive font-medium">
                  If the tenant defaults, this will affect your agent reputation and future earnings.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleGuarantee}
              disabled={guaranteeLoading}
              className="gap-1.5"
            >
              {guaranteeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandHeart className="h-4 w-4" />}
              Yes, I Guarantee
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Full Verification Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Tenant & Landlord Verification
            </DialogTitle>
            <DialogDescription>
              Enter the details collected in person. They must match what was submitted.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            {/* Landlord PINs */}
            <div className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <p className="text-xs font-semibold flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-primary" />
                Landlord Verification PINs (optional)
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">PIN 1 (4 digits)</Label>
                  <Input 
                    value={pin1}
                    onChange={(e) => setPin1(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="****"
                    maxLength={4}
                    inputMode="numeric"
                    className="text-center text-lg tracking-widest font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">PIN 2 (4 digits)</Label>
                  <Input 
                    value={pin2}
                    onChange={(e) => setPin2(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="****"
                    maxLength={4}
                    inputMode="numeric"
                    className="text-center text-lg tracking-widest font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Landlord TIN */}
            <div className="space-y-1">
              <Label className="text-xs flex items-center gap-1">
                <FileText className="h-3 w-3 text-muted-foreground" />
                Landlord TIN (optional)
              </Label>
              <Input 
                value={tin}
                onChange={(e) => setTin(e.target.value)}
                placeholder="Tax Identification Number"
              />
            </div>

            {/* Landlord Meters */}
            <div className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <p className="text-xs font-semibold">Landlord Utility Meters</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">
                    <Droplets className="h-3 w-3 text-blue-500" /> NWSC Meter
                  </Label>
                  <Input 
                    value={landlordWaterMeter}
                    onChange={(e) => setLandlordWaterMeter(e.target.value)}
                    placeholder="Water meter"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">
                    <Zap className="h-3 w-3 text-amber-500" /> UEDCL Meter
                  </Label>
                  <Input 
                    value={landlordElectricityMeter}
                    onChange={(e) => setLandlordElectricityMeter(e.target.value)}
                    placeholder="Electricity meter"
                  />
                </div>
              </div>
            </div>

            {/* Tenant Meters */}
            <div className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <p className="text-xs font-semibold">Tenant Utility Meters</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">
                    <Droplets className="h-3 w-3 text-blue-500" /> NWSC Meter
                  </Label>
                  <Input 
                    value={tenantWaterMeter}
                    onChange={(e) => setTenantWaterMeter(e.target.value)}
                    placeholder="Water meter"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">
                    <Zap className="h-3 w-3 text-amber-500" /> UEDCL Meter
                  </Label>
                  <Input 
                    value={tenantElectricityMeter}
                    onChange={(e) => setTenantElectricityMeter(e.target.value)}
                    placeholder="Electricity meter"
                  />
                </div>
              </div>
            </div>

            {/* Verification Result */}
            {verificationResult && (
              <div className={`p-3 rounded-lg border ${verificationResult.match ? 'bg-success/10 border-success/30' : 'bg-destructive/10 border-destructive/30'}`}>
                <p className={`text-sm font-semibold mb-2 flex items-center gap-1.5 ${verificationResult.match ? 'text-success' : 'text-destructive'}`}>
                  {verificationResult.match ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                  {verificationResult.match ? 'Verification Passed!' : 'Verification Failed'}
                </p>
                <div className="space-y-1">
                  {Object.entries(verificationResult.details).map(([key, matched]) => (
                    <div key={key} className="flex items-center justify-between text-xs">
                      <span>{key}</span>
                      {matched ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-destructive" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Submit */}
            <Button
              onClick={handleAgentVerify}
              disabled={loading}
              className="w-full gap-2"
              variant={verificationResult?.match === false ? 'destructive' : 'default'}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
              {verificationResult?.match === false ? 'Retry Verification' : 'Submit Verification'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
