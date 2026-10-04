import { useState, useEffect } from 'react';
import StepperModal, { Step } from './StepperModal';
import ReceiptCard from './ReceiptCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { formatCurrency } from '@/lib/paymentMethods';
import { Search, MapPin, CheckCircle2, Lock, TrendingUp, Loader2, AlertCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface FundTenantsFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walletBalance?: number;
}

interface RentRequest {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_location: string;
  rent_amount: number;
  landlord_name: string;
  house_category: string | null;
  status: string;
}

const STEPS: Step[] = [
  { id: 'mode', title: 'Funding Mode' },
  { id: 'select', title: 'Select Tenants' },
  { id: 'amount', title: 'Funding Amount' },
  { id: 'confirm', title: 'Confirm' },
  { id: 'process', title: 'Processing' },
];

export default function FundTenantsFlow({
  open,
  onOpenChange,
  walletBalance = 0,
}: FundTenantsFlowProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [fundingMode, setFundingMode] = useState<'specific' | 'location' | 'auto'>('specific');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [coverageType, setCoverageType] = useState<'full' | 'partial' | 'daily'>('full');
  const [fundingDays, setFundingDays] = useState(30);
  const [transactionId, setTransactionId] = useState('');
  const [transactionTime, setTransactionTime] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<'success' | 'failed'>('success');
  const [rentRequests, setRentRequests] = useState<RentRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [fundResult, setFundResult] = useState<any>(null);

  // Fetch eligible rent requests when step 1 opens
  useEffect(() => {
    if (open && currentStep === 1) {
      fetchRentRequests();
    }
  }, [open, currentStep]);

  const fetchRentRequests = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('rent_requests')
        .select(`
          id, tenant_id, rent_amount, status, house_category,
          profiles!rent_requests_agent_verified_by_fkey(full_name, city),
          landlords!rent_requests_landlord_id_fkey(name)
        `)
        .in('status', ['approved', 'pending'])
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        console.error('Fetch error:', error);
        // Fallback: fetch without joins
        const { data: fallbackData } = await supabase
          .from('rent_requests')
          .select('id, tenant_id, rent_amount, status, house_category, landlord_id')
          .in('status', ['approved', 'pending'])
          .order('created_at', { ascending: false })
          .limit(50);

        if (fallbackData) {
          // Get tenant profiles separately
          const tenantIds = [...new Set(fallbackData.map(r => r.tenant_id))];
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name, city')
            .in('id', tenantIds);

          const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);

          setRentRequests(fallbackData.map(rr => ({
            id: rr.id,
            tenant_id: rr.tenant_id,
            tenant_name: profileMap.get(rr.tenant_id)?.full_name || 'Unknown Tenant',
            tenant_location: profileMap.get(rr.tenant_id)?.city || 'Unknown',
            rent_amount: rr.rent_amount,
            landlord_name: 'Landlord',
            house_category: rr.house_category,
            status: rr.status || 'pending',
          })));
        }
      } else if (data) {
        setRentRequests(data.map((rr: any) => ({
          id: rr.id,
          tenant_id: rr.tenant_id,
          tenant_name: rr.profiles?.full_name || 'Unknown Tenant',
          tenant_location: rr.profiles?.city || 'Unknown',
          rent_amount: rr.rent_amount,
          landlord_name: rr.landlords?.name || 'Unknown Landlord',
          house_category: rr.house_category,
          status: rr.status || 'pending',
        })));
      }
    } catch (err) {
      console.error('Error fetching rent requests:', err);
    } finally {
      setLoading(false);
    }
  };

  const selectedRequests = rentRequests.filter(r => selectedIds.includes(r.id));
  const totalRentDue = selectedRequests.reduce((sum, t) => sum + t.rent_amount, 0);
  const fundingAmount = coverageType === 'full' ? totalRentDue :
    coverageType === 'partial' ? Math.round(totalRentDue * 0.5) :
    Math.round(totalRentDue * (fundingDays / 30));
  const expectedROI = Math.round(fundingAmount * 0.15);

  const handleReset = () => {
    setCurrentStep(0);
    setFundingMode('specific');
    setSelectedIds([]);
    setCoverageType('full');
    setFundingDays(30);
    setTransactionId('');
    setTransactionTime('');
    setConfirmed(false);
    setIsProcessing(false);
    setIsComplete(false);
    setFundResult(null);
  };

  const handleClose = () => {
    onOpenChange(false);
    setTimeout(handleReset, 300);
  };

  const canProceed = () => {
    switch (currentStep) {
      case 0: return fundingMode !== 'auto';
      case 1: return selectedIds.length > 0;
      case 2: return fundingAmount > 0 && fundingAmount <= walletBalance;
      case 3: return confirmed && transactionId.replace(/\D/g, '').length >= 5 && transactionTime.trim().length > 0;
      default: return false;
    }
  };

  const handleNext = async () => {
    if (currentStep === 3) {
      setCurrentStep(4);
      setIsProcessing(true);

      try {
        const { data, error } = await supabase.functions.invoke('fund-tenants', {
          body: {
            rent_request_ids: selectedIds,
            coverage_type: coverageType,
            funding_days: coverageType === 'daily' ? fundingDays : 30,
            transaction_id: `TID${transactionId.replace(/\D/g, '')}`,
            transaction_time: transactionTime.trim(),
          },
        });

        if (error) {
          const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
          const msg = await extractFromErrorObject(error, 'Funding failed');
          throw new Error(msg);
        }
        if (data?.error) throw new Error(data.error);

        setFundResult(data.details);
        setPaymentStatus('success');
        toast.success(`Successfully funded ${data.details?.tenants_funded} tenant(s)!`);
      } catch (err: any) {
        console.error('Fund error:', err);
        setPaymentStatus('failed');
        toast.error(err.message || 'Funding failed');
      } finally {
        setIsProcessing(false);
        setIsComplete(true);
      }
    }
  };

  const toggleRequest = (id: string) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const filteredRequests = rentRequests.filter(r =>
    r.tenant_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    r.tenant_location.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (r.house_category || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return (
          <div className="space-y-4">
            <Label>Choose Funding Mode</Label>
            <div className="space-y-3">
              <Card
                className={`p-4 cursor-pointer transition-all ${fundingMode === 'specific' ? 'ring-2 ring-primary border-primary' : 'hover:border-primary/50'}`}
                onClick={() => setFundingMode('specific')}
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Search className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h4 className="font-semibold">Fund Specific Tenants</h4>
                    <p className="text-sm text-muted-foreground">Select approved rent requests to fund</p>
                  </div>
                </div>
              </Card>

              <Card
                className={`p-4 cursor-pointer transition-all ${fundingMode === 'location' ? 'ring-2 ring-primary border-primary' : 'hover:border-primary/50'}`}
                onClick={() => setFundingMode('location')}
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <MapPin className="w-5 h-5 text-blue-500" />
                  </div>
                  <div>
                    <h4 className="font-semibold">Fund by Location</h4>
                    <p className="text-sm text-muted-foreground">Select tenants from a specific area</p>
                  </div>
                </div>
              </Card>

              <Card className="p-4 opacity-60 cursor-not-allowed relative overflow-hidden">
                <Badge className="absolute top-2 right-2" variant="secondary">Coming Soon</Badge>
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center">
                    <Lock className="w-5 h-5 text-purple-500" />
                  </div>
                  <div>
                    <h4 className="font-semibold">Auto-Fund Program</h4>
                    <p className="text-sm text-muted-foreground">Automated recurring funding</p>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        );

      case 1:
        return (
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search tenant, location, or category..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            {selectedIds.length > 0 && (
              <div className="flex items-center justify-between p-3 bg-primary/5 rounded-lg">
                <span className="text-sm font-medium">{selectedIds.length} selected</span>
                <span className="text-sm text-primary font-semibold">
                  Total: {formatCurrency(totalRentDue, 'UGX')}
                </span>
              </div>
            )}

            {loading ? (
              <div className="py-8 text-center">
                <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
                <p className="text-sm text-muted-foreground mt-2">Loading rent requests...</p>
              </div>
            ) : filteredRequests.length === 0 ? (
              <div className="py-8 text-center">
                <AlertCircle className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No eligible rent requests found</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {filteredRequests.map((rr) => {
                  const isSelected = selectedIds.includes(rr.id);
                  return (
                    <Card
                      key={rr.id}
                      className={`p-3 cursor-pointer transition-all ${isSelected ? 'ring-2 ring-primary border-primary bg-primary/5' : 'hover:border-primary/50'}`}
                      onClick={() => toggleRequest(rr.id)}
                    >
                      <div className="flex items-center gap-3">
                        <Checkbox checked={isSelected} className="pointer-events-none" />
                        <Avatar className="h-10 w-10">
                          <AvatarFallback>{rr.tenant_name.charAt(0)}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{rr.tenant_name}</span>
                            <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            {rr.tenant_location} · {rr.landlord_name}
                          </p>
                          {rr.house_category && (
                            <Badge variant="outline" className="text-[10px] mt-1">{rr.house_category}</Badge>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="font-semibold text-sm">{formatCurrency(rr.rent_amount, 'UGX')}</p>
                          <p className="text-xs text-muted-foreground">Rent</p>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        );

      case 2:
        return (
          <div className="space-y-4">
            <Label>Coverage Type</Label>
            <div className="grid grid-cols-3 gap-2">
              {(['full', 'partial', 'daily'] as const).map(type => (
                <Button
                  key={type}
                  variant={coverageType === type ? 'default' : 'outline'}
                  onClick={() => setCoverageType(type)}
                  className="h-auto py-3 flex-col"
                >
                  <span className="font-semibold capitalize">{type}</span>
                  <span className="text-xs opacity-80">
                    {type === 'full' ? '100%' : type === 'partial' ? '50%' : 'Custom'}
                  </span>
                </Button>
              ))}
            </div>

            {coverageType === 'daily' && (
              <div className="space-y-2">
                <Label>Funding Days</Label>
                <Select value={String(fundingDays)} onValueChange={(v) => setFundingDays(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[7, 14, 21, 30].map((d) => (
                      <SelectItem key={d} value={String(d)}>{d} days</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Card className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
              <CardContent className="p-4 space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Funding Amount</span>
                  <span className="font-bold text-lg">{formatCurrency(fundingAmount, 'UGX')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Beneficiaries</span>
                  <span className="font-medium">{selectedIds.length} tenant(s)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Wallet Balance</span>
                  <span className={`font-medium ${walletBalance < fundingAmount ? 'text-destructive' : ''}`}>
                    {formatCurrency(walletBalance, 'UGX')}
                  </span>
                </div>
                {walletBalance < fundingAmount && (
                  <p className="text-xs text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    Insufficient balance. Please deposit more funds.
                  </p>
                )}
                <div className="pt-2 border-t flex justify-between items-center">
                  <div className="flex items-center gap-1 text-emerald-600">
                    <TrendingUp className="w-4 h-4" />
                    <span className="text-sm">Expected 15% Return</span>
                  </div>
                  <span className="font-bold text-emerald-600">+{formatCurrency(expectedROI, 'UGX')}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        );

      case 3:
        return (
          <div className="space-y-4">
            <Card className="border-primary/20">
              <CardContent className="p-4 space-y-3">
                <h4 className="font-semibold">Funding Summary</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total Amount</span>
                    <span className="font-bold">{formatCurrency(fundingAmount, 'UGX')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tenants</span>
                    <span>{selectedIds.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Coverage</span>
                    <span className="capitalize">{coverageType}{coverageType === 'daily' ? ` (${fundingDays}d)` : ''}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Payment Source</span>
                    <span>Welile Wallet</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t text-emerald-600">
                    <span>Expected Monthly Return (15%)</span>
                    <span className="font-bold">+{formatCurrency(expectedROI, 'UGX')}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Transaction ID — required */}
            <div className="space-y-2">
              <Label htmlFor="fund-tid" className="text-sm font-semibold flex items-center gap-1">
                Transaction ID <span className="text-destructive">*</span>
              </Label>
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 flex items-start gap-2 mb-1">
                <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Enter the mobile money Transaction ID from your payment SMS. This is required for verification.
                </p>
              </div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-muted-foreground">TID</span>
                <Input
                  id="fund-tid"
                  placeholder="e.g. 1234567890"
                  value={transactionId}
                  onChange={(e) => setTransactionId(e.target.value.replace(/\D/g, ''))}
                  className="pl-12 font-mono"
                  inputMode="numeric"
                  maxLength={15}
                />
              </div>
              {transactionId.length > 0 && transactionId.length < 5 && (
                <p className="text-xs text-destructive">Transaction ID must be at least 5 digits</p>
              )}
            </div>

            {/* Transaction Time — required */}
            <div className="space-y-2">
              <Label htmlFor="fund-time" className="text-sm font-semibold flex items-center gap-1">
                Transaction Time <span className="text-destructive">*</span>
              </Label>
              <Input
                id="fund-time"
                type="datetime-local"
                value={transactionTime}
                onChange={(e) => setTransactionTime(e.target.value)}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Enter the exact time shown on the MoMo payment SMS
              </p>
            </div>

            <div className="space-y-3">
              <h4 className="text-sm font-medium">Selected Tenants:</h4>
              {selectedRequests.map(rr => (
                <div key={rr.id} className="flex justify-between text-sm p-2 bg-muted/50 rounded">
                  <span>{rr.tenant_name}</span>
                  <span className="font-mono">{formatCurrency(rr.rent_amount, 'UGX')}</span>
                </div>
              ))}
            </div>

            <label className="flex items-start gap-3 p-3 bg-muted/30 rounded-lg cursor-pointer">
              <Checkbox
                checked={confirmed}
                onCheckedChange={(v) => setConfirmed(!!v)}
                className="mt-0.5"
              />
              <span className="text-sm text-muted-foreground">
                I confirm this funding and agree that the amount will be deducted from my wallet and transferred to the landlords. I understand the 15% monthly reward terms.
              </span>
            </label>
          </div>
        );

      case 4:
        if (isProcessing) {
          return (
            <div className="py-12 text-center space-y-4">
              <Loader2 className="h-10 w-10 animate-spin mx-auto text-primary" />
              <p className="text-muted-foreground">Processing your funding...</p>
              <p className="text-xs text-muted-foreground">Transferring to landlord wallets</p>
            </div>
          );
        }
        return (
          <ReceiptCard
            status={paymentStatus}
            amount={fundResult?.total_funded || fundingAmount}
            currency="UGX"
            fees={0}
            recipient={`${fundResult?.tenants_funded || selectedIds.length} Tenant(s)`}
            reference={transactionId ? `TID${transactionId}` : 'PENDING'}
            method="Welile Wallet"
            date={new Date()}
            onDownload={() => {}}
            onShare={() => {}}
            onTryAgain={() => setCurrentStep(2)}
            onChangeMethod={() => setCurrentStep(2)}
            onContactSupport={() => {}}
            onClose={handleClose}
          />
        );

      default:
        return null;
    }
  };

  return (
    <StepperModal
      open={open}
      onOpenChange={handleClose}
      title="Fund Tenants"
      steps={STEPS}
      currentStep={currentStep}
      onStepChange={setCurrentStep}
      canGoNext={canProceed()}
      onNext={handleNext}
      showNavigation={currentStep < 4 && !isProcessing && !isComplete}
      nextLabel={currentStep === 3 ? 'Confirm Funding' : 'Continue'}
      isProcessing={isProcessing}
      isComplete={isComplete}
    >
      {renderStep()}
    </StepperModal>
  );
}
