import React, { useState, useMemo } from 'react';
import {
  Building2,
  Landmark,
  XCircle,
  RotateCcw,
  Plus,
  AlertTriangle,
  ShieldAlert,
  Calendar,
  RefreshCw,
  Check,
  ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  IMMACULATE_PRESET,
  TRACKER_MIN_DATE,
  useMerchantDesksList,
  useMerchantDeskFundingTracker,
  useMerchantDeskExternalFunding,
  useDecideMerchantDeskExternalFunding,
  useRecordMerchantDeskExternalFunding,
  type MerchantDeskDailyTrackerRow,
  type MerchantExternalFundingTransfer,
} from '@/hooks/useMerchantDeskFundingTracker';

const ALLOWED_ROLES = ['cfo', 'financial_ops', 'super_admin', 'ceo', 'coo', 'manager'] as const;

function formatEATDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Kampala',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
    return `${formatted} EAT`;
  } catch {
    return dateStr;
  }
}

function channelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case 'bank_transfer':
      return 'Bank → bank';
    case 'mtn_to_bank':
      return 'MTN line → Equity';
    case 'airtel_to_bank':
      return 'Airtel line → Equity';
    case 'cash':
      return 'Cash';
    case 'other':
      return 'Other';
    default:
      return channel || '—';
  }
}

function renderTableBalanceCell(amount: number) {
  const isNegative = amount < 0;
  const absFormatted = formatUGX(Math.abs(amount));
  const amountWithUGX = absFormatted.includes('UGX') ? absFormatted : `UGX ${absFormatted}`;
  const label = isNegative
    ? `Merchant's own money in use: ${amountWithUGX}`
    : `Company money with desk: ${amountWithUGX}`;

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium whitespace-nowrap border ${
        isNegative
          ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900'
          : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900'
      }`}
    >
      {label}
    </span>
  );
}

export function MerchantDeskFundingTracker() {
  const { roles, isLoading: authLoading } = useAuth();
  const hasRoleAccess = useMemo(() => {
    return Array.isArray(roles) && roles.some((r) => (ALLOWED_ROLES as readonly string[]).includes(r));
  }, [roles]);

  // Today in YYYY-MM-DD
  const todayStr = useMemo(() => {
    return new Date().toISOString().split('T')[0];
  }, []);

  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>(IMMACULATE_PRESET.agentIds);
  const [fromDate, setFromDate] = useState<string>(TRACKER_MIN_DATE);
  const [toDate, setToDate] = useState<string>(todayStr);

  const { data: desks = [], isLoading: loadingDesks } = useMerchantDesksList();

  const deskNameMap = useMemo(() => {
    const map = new Map<string, string>();
    desks.forEach((d) => {
      map.set(d.agentId, `${d.label} — ${d.fullName}`);
    });
    return map;
  }, [desks]);

  const {
    data: trackerRows = [],
    isLoading: loadingTracker,
    error: trackerError,
    refetch: refetchTracker,
  } = useMerchantDeskFundingTracker({
    agentIds: selectedAgentIds,
    fromDate,
    toDate,
    enabled: hasRoleAccess && selectedAgentIds.length > 0,
  });

  const {
    data: transfers = [],
    isLoading: loadingTransfers,
    refetch: refetchTransfers,
  } = useMerchantDeskExternalFunding(selectedAgentIds, hasRoleAccess && selectedAgentIds.length > 0);

  const decideMutation = useDecideMerchantDeskExternalFunding();
  const recordMutation = useRecordMerchantDeskExternalFunding();

  // Dialog states
  const [addFundingOpen, setAddFundingOpen] = useState(false);
  const [rejectingTransfer, setRejectingTransfer] = useState<MerchantExternalFundingTransfer | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  // Add funding form state
  const [addAgentId, setAddAgentId] = useState<string>('');
  const [addAmount, setAddAmount] = useState<string>('');
  const [addFundedAt, setAddFundedAt] = useState<string>(new Date().toISOString().slice(0, 16));
  const [addChannel, setAddChannel] = useState<string>('bank_transfer');
  const [addReference, setAddReference] = useState<string>('');
  const [addNote, setAddNote] = useState<string>('');

  // Check backend 42501 unauthorized error
  const isUnauthorized = useMemo(() => {
    if (!hasRoleAccess) return true;
    if (trackerError) {
      const err = trackerError as { code?: string; message?: string } | null;
      if (
        err?.code === '42501' ||
        (typeof err?.message === 'string' &&
          (err.message.includes('42501') || err.message.toLowerCase().includes('not authorised')))
      ) {
        return true;
      }
    }
    return false;
  }, [hasRoleAccess, trackerError]);

  // Tab grouping for Daily Statement Table
  // If > 1 desk selected, "ALL DESKS" comes first.
  const deskTabs = useMemo(() => {
    const tabs: string[] = [];
    const uniqueLabels = new Set<string>();

    trackerRows.forEach((r) => {
      if (r.desk_label && r.desk_label !== 'ALL DESKS') {
        uniqueLabels.add(r.desk_label);
      }
    });

    const hasAllDesks = trackerRows.some((r) => r.desk_label === 'ALL DESKS' || r.agent_id === null);
    if (hasAllDesks || selectedAgentIds.length > 1) {
      tabs.push('ALL DESKS');
    }

    uniqueLabels.forEach((label) => tabs.push(label));

    // Fallback if no rows yet
    if (tabs.length === 0) {
      tabs.push('ALL DESKS');
    }
    return tabs;
  }, [trackerRows, selectedAgentIds]);

  const [activeDeskTab, setActiveDeskTab] = useState<string>('ALL DESKS');

  // Keep activeDeskTab valid
  React.useEffect(() => {
    if (!deskTabs.includes(activeDeskTab)) {
      setActiveDeskTab(deskTabs[0] || 'ALL DESKS');
    }
  }, [deskTabs, activeDeskTab]);

  // Filter rows for current desk tab
  const currentTabRows = useMemo(() => {
    if (activeDeskTab === 'ALL DESKS') {
      const allRows = trackerRows.filter((r) => r.desk_label === 'ALL DESKS' || r.agent_id === null);
      return allRows.length > 0 ? allRows : trackerRows;
    }
    return trackerRows.filter((r) => r.desk_label === activeDeskTab);
  }, [trackerRows, activeDeskTab]);

  // Summary figures: computed from the current view or the ALL DESKS row on the last day
  const summaryFigures = useMemo(() => {
    const sorted = [...currentTabRows].sort((a, b) => (a.day > b.day ? 1 : -1));
    const lastRow = sorted[sorted.length - 1];

    const totalGivenLedger = currentTabRows.reduce((s, r) => s + (Number(r.given_ledger) || 0), 0);
    const totalGivenBankConfirmed = currentTabRows.reduce(
      (s, r) => s + (Number(r.given_external_confirmed) || 0),
      0
    );
    const totalGivenBankSuggested = currentTabRows.reduce(
      (s, r) => s + (Number(r.given_external_suggested) || 0),
      0
    );
    const totalPaidOut = currentTabRows.reduce((s, r) => s + (Number(r.used) || 0), 0);

    const confirmedBalance = lastRow ? Number(lastRow.running_confirmed ?? 0) : 0;
    const suggestedBalance = lastRow ? Number(lastRow.running_with_suggested ?? 0) : 0;

    return {
      totalGivenLedger,
      totalGivenBankConfirmed,
      totalGivenBankSuggested,
      totalPaidOut,
      confirmedBalance,
      suggestedBalance,
      lastDay: lastRow?.day,
    };
  }, [currentTabRows]);

  // Bank transfers categorized by status
  const unconfirmedTransfers = useMemo(
    () => transfers.filter((t) => t.status === 'suggested'),
    [transfers]
  );
  const confirmedTransfers = useMemo(
    () => transfers.filter((t) => t.status === 'confirmed'),
    [transfers]
  );
  const rejectedTransfers = useMemo(
    () => transfers.filter((t) => t.status === 'rejected'),
    [transfers]
  );

  const isImmaculatePresetActive = useMemo(() => {
    if (selectedAgentIds.length !== IMMACULATE_PRESET.agentIds.length) return false;
    return IMMACULATE_PRESET.agentIds.every((id) => selectedAgentIds.includes(id));
  }, [selectedAgentIds]);

  const handleApplyPreset = () => {
    setSelectedAgentIds(IMMACULATE_PRESET.agentIds);
    setFromDate(TRACKER_MIN_DATE);
    setToDate(todayStr);
    toast.success('Selected Immaculate (both desks)');
  };

  const handleToggleAgent = (agentId: string) => {
    setSelectedAgentIds((prev) => {
      if (prev.includes(agentId)) {
        if (prev.length === 1) {
          toast.warning('At least one merchant desk must be selected');
          return prev;
        }
        return prev.filter((id) => id !== agentId);
      }
      return [...prev, agentId];
    });
  };

  const handleConfirmTransfer = async (transfer: MerchantExternalFundingTransfer) => {
    try {
      await decideMutation.mutateAsync({
        id: transfer.id,
        status: 'confirmed',
      });
      toast.success('Bank transfer confirmed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to confirm transfer';
      toast.error(msg);
    }
  };

  const handleOpenRejectDialog = (transfer: MerchantExternalFundingTransfer) => {
    setRejectingTransfer(transfer);
    setRejectNote('');
  };

  const handleConfirmReject = async () => {
    if (!rejectingTransfer) return;
    if (!rejectNote.trim()) {
      toast.error('A rejection note is required');
      return;
    }

    try {
      await decideMutation.mutateAsync({
        id: rejectingTransfer.id,
        status: 'rejected',
        note: rejectNote.trim(),
      });
      toast.success('Bank transfer rejected');
      setRejectingTransfer(null);
      setRejectNote('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to reject transfer';
      toast.error(msg);
    }
  };

  const handleUndoDecision = async (transfer: MerchantExternalFundingTransfer) => {
    try {
      await decideMutation.mutateAsync({
        id: transfer.id,
        status: 'suggested',
      });
      toast.success('Transfer reverted to unconfirmed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to undo transfer decision';
      toast.error(msg);
    }
  };

  const handleOpenAddFunding = () => {
    setAddAgentId(selectedAgentIds[0] || desks[0]?.agentId || '');
    setAddAmount('');
    setAddFundedAt(new Date().toISOString().slice(0, 16));
    setAddChannel('bank_transfer');
    setAddReference('');
    setAddNote('');
    setAddFundingOpen(true);
  };

  const handleSubmitAddFunding = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addAgentId) {
      toast.error('Select a merchant desk');
      return;
    }
    const numAmount = parseFloat(addAmount.replace(/,/g, ''));
    if (!numAmount || numAmount <= 0) {
      toast.error('Enter a valid amount');
      return;
    }

    try {
      await recordMutation.mutateAsync({
        agentId: addAgentId,
        amount: numAmount,
        fundedAt: new Date(addFundedAt).toISOString(),
        channel: addChannel,
        reference: addReference.trim() || null,
        note: addNote.trim() || null,
      });
      toast.success('Bank funding recorded successfully');
      setAddFundingOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to record bank funding';
      toast.error(msg);
    }
  };

  // Plain "You don't have access" message if not authorised
  if (!authLoading && isUnauthorized) {
    return (
      <Card className="border-dashed bg-muted/20 w-full">
        <CardContent className="p-8">
          <div className="flex items-center gap-3 text-muted-foreground">
            <ShieldAlert className="h-6 w-6 text-amber-600 dark:text-amber-500 shrink-0" />
            <div>
              <p className="text-base font-semibold text-foreground">You don't have access</p>
              <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
                Only CFO, Financial Ops, Super Admin, CEO, COO, and Manager roles can view the Merchant Desk Funding Tracker.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="w-full space-y-6">
      {/* HEADER ROW: Title & description on left, all controls on one line on right */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Landmark className="h-6 w-6 text-primary shrink-0" />
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground truncate">
              Merchant Desk Funding Tracker
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Day-by-day company float provided, payouts disbursed, and balance tracking across merchant desks.
          </p>
        </div>

        {/* Top Controls on one line */}
        <div className="flex flex-wrap lg:flex-nowrap items-center gap-2 shrink-0">
          {/* Multi-select desk popover */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 text-xs font-normal border-border bg-card">
                <Building2 className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                <span className="truncate max-w-[160px] sm:max-w-xs">
                  {selectedAgentIds.length === 1
                    ? deskNameMap.get(selectedAgentIds[0]) || '1 desk selected'
                    : `${selectedAgentIds.length} desks selected`}
                </span>
                <ChevronDown className="h-3.5 w-3.5 ml-1.5 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-3" align="end">
              <div className="space-y-2">
                <div className="flex items-center justify-between pb-1.5 border-b">
                  <span className="text-xs font-semibold">Select Merchant Desks</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    onClick={() => setSelectedAgentIds(desks.map((d) => d.agentId))}
                  >
                    Select all
                  </Button>
                </div>
                <div className="max-h-56 overflow-y-auto space-y-1.5 py-1">
                  {loadingDesks ? (
                    <p className="text-xs text-muted-foreground p-2">Loading desks...</p>
                  ) : desks.length === 0 ? (
                    <p className="text-xs text-muted-foreground p-2">No merchant desks found</p>
                  ) : (
                    desks.map((desk) => {
                      const isSelected = selectedAgentIds.includes(desk.agentId);
                      return (
                        <div
                          key={desk.agentId}
                          className="flex items-center space-x-2 p-1.5 rounded hover:bg-muted/50 cursor-pointer"
                          onClick={() => handleToggleAgent(desk.agentId)}
                        >
                          <Checkbox checked={isSelected} onCheckedChange={() => handleToggleAgent(desk.agentId)} />
                          <label className="text-xs cursor-pointer select-none leading-tight font-medium text-foreground">
                            {desk.label} <span className="text-muted-foreground font-normal">— {desk.fullName}</span>
                          </label>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {/* Date range picker */}
          <div className="flex items-center gap-1.5 bg-card border rounded-md px-2 py-1 h-9">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">From:</span>
              <Input
                type="date"
                min={TRACKER_MIN_DATE}
                max={toDate}
                value={fromDate}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val && val >= TRACKER_MIN_DATE) {
                    setFromDate(val);
                  }
                }}
                className="h-7 text-xs w-28 px-1.5 border-0 focus-visible:ring-1"
              />
            </div>
            <div className="flex items-center gap-1 text-xs pl-1 border-l">
              <span className="text-muted-foreground">To:</span>
              <Input
                type="date"
                min={fromDate || TRACKER_MIN_DATE}
                value={toDate}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val) setToDate(val);
                }}
                className="h-7 text-xs w-28 px-1.5 border-0 focus-visible:ring-1"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Refresh tracker"
              onClick={() => {
                refetchTracker();
                refetchTransfers();
              }}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingTracker || loadingTransfers ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {/* Preset button */}
          <Button
            variant={isImmaculatePresetActive ? 'default' : 'outline'}
            size="sm"
            className="text-xs h-9 font-medium"
            onClick={handleApplyPreset}
          >
            <Building2 className="h-3.5 w-3.5 mr-1.5" />
            Immaculate (both desks)
          </Button>

          {/* Add bank funding button */}
          <Button
            variant="default"
            size="sm"
            className="text-xs h-9 bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
            onClick={handleOpenAddFunding}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add bank funding
          </Button>
        </div>
      </div>

      {/* SUMMARY CARDS: 5-column grid on desktop, 2 on tablet, 1 on mobile */}
      <div className="space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3.5">
          {/* Card 1: Total given in system */}
          <Card className="border border-border/80 shadow-xs bg-card">
            <CardContent className="p-4 flex flex-col justify-between h-full">
              <p className="text-xs text-muted-foreground font-medium">Total given (in system)</p>
              <p className="text-xl sm:text-2xl font-bold font-mono text-foreground mt-2 whitespace-nowrap overflow-visible">
                {formatUGX(summaryFigures.totalGivenLedger)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">Recorded on system ledger</p>
            </CardContent>
          </Card>

          {/* Card 2: Total given via bank (confirmed) */}
          <Card className="border border-border/80 shadow-xs bg-card">
            <CardContent className="p-4 flex flex-col justify-between h-full">
              <p className="text-xs text-muted-foreground font-medium">Total given via bank (confirmed)</p>
              <p className="text-xl sm:text-2xl font-bold font-mono text-foreground mt-2 whitespace-nowrap overflow-visible">
                {formatUGX(summaryFigures.totalGivenBankConfirmed)}
              </p>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mt-1">
                +{formatUGX(summaryFigures.totalGivenBankSuggested)} unconfirmed
              </p>
            </CardContent>
          </Card>

          {/* Card 3: Total paid out */}
          <Card className="border border-border/80 shadow-xs bg-card">
            <CardContent className="p-4 flex flex-col justify-between h-full">
              <p className="text-xs text-muted-foreground font-medium">Total paid out</p>
              <p className="text-xl sm:text-2xl font-bold font-mono text-foreground mt-2 whitespace-nowrap overflow-visible">
                {formatUGX(summaryFigures.totalPaidOut)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">Disbursed by desk</p>
            </CardContent>
          </Card>

          {/* Card 4: Balance (confirmed only) */}
          <Card
            className={`border shadow-xs ${
              summaryFigures.confirmedBalance < 0
                ? 'border-rose-200 bg-rose-50/40 dark:bg-rose-950/20 dark:border-rose-900/60'
                : 'border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/20 dark:border-emerald-900/60'
            }`}
          >
            <CardContent className="p-4 flex flex-col justify-between h-full">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {summaryFigures.confirmedBalance < 0
                    ? "Merchant's own money in use"
                    : 'Company money with desk'}
                </span>
                <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0">
                  Confirmed only
                </Badge>
              </div>
              <p
                className={`text-xl sm:text-2xl font-bold font-mono mt-2 whitespace-nowrap overflow-visible ${
                  summaryFigures.confirmedBalance < 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {formatUGX(Math.abs(summaryFigures.confirmedBalance))}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">Confirmed transactions only</p>
            </CardContent>
          </Card>

          {/* Card 5: Balance (incl. unconfirmed) */}
          <Card
            className={`border shadow-xs ${
              summaryFigures.suggestedBalance < 0
                ? 'border-rose-200 bg-rose-50/40 dark:bg-rose-950/20 dark:border-rose-900/60'
                : 'border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/20 dark:border-emerald-900/60'
            }`}
          >
            <CardContent className="p-4 flex flex-col justify-between h-full">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {summaryFigures.suggestedBalance < 0
                    ? "Merchant's own money in use"
                    : 'Company money with desk'}
                </span>
                <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0">
                  Incl. unconfirmed
                </Badge>
              </div>
              <p
                className={`text-xl sm:text-2xl font-bold font-mono mt-2 whitespace-nowrap overflow-visible ${
                  summaryFigures.suggestedBalance < 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {formatUGX(Math.abs(summaryFigures.suggestedBalance))}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">Includes unconfirmed bank SMS/transfers</p>
            </CardContent>
          </Card>
        </div>

        <p className="text-xs sm:text-sm text-muted-foreground italic px-1 pt-1">
          The truth lies between these two until Finance confirms or rejects every unconfirmed bank transfer below.
        </p>
      </div>

      {/* DAILY STATEMENT TABLE SECTION */}
      <Card className="border border-border/80 shadow-xs bg-card">
        <CardHeader className="p-4 pb-3 border-b flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-muted/10">
          <div>
            <CardTitle className="text-base font-semibold text-foreground">Daily Statement</CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-0.5">
              Showing daily funding movement and running balance per active day.
            </CardDescription>
          </div>

          {/* Desk Tabs */}
          {deskTabs.length > 1 && (
            <Tabs value={activeDeskTab} onValueChange={setActiveDeskTab} className="w-auto">
              <TabsList className="h-8 bg-muted/60 p-0.5">
                {deskTabs.map((tab) => (
                  <TabsTrigger key={tab} value={tab} className="text-xs h-7 px-3 font-medium">
                    {tab}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
        </CardHeader>

        <CardContent className="p-0">
          <div className="overflow-x-auto w-full max-h-[650px] relative">
            <TooltipProvider>
              <Table className="min-w-[1100px] text-xs">
                <TableHeader className="sticky top-0 z-20 bg-muted/95 backdrop-blur shadow-xs">
                  <TableRow className="border-b">
                    <TableHead className="sticky left-0 z-30 bg-muted/95 backdrop-blur font-semibold w-28 px-3.5 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]">
                      Date
                    </TableHead>
                    <TableHead className="font-semibold whitespace-nowrap px-3">Desk</TableHead>
                    <TableHead className="text-right font-semibold whitespace-nowrap px-3">Given (in system)</TableHead>
                    <TableHead className="text-right font-semibold whitespace-nowrap px-3">Given via bank (confirmed)</TableHead>
                    <TableHead className="text-right font-semibold whitespace-nowrap px-3">Given via bank (unconfirmed)</TableHead>
                    <TableHead className="text-right font-semibold whitespace-nowrap px-3">Taken back</TableHead>
                    <TableHead className="text-right font-semibold whitespace-nowrap px-3">Paid out</TableHead>
                    <TableHead className="text-right font-semibold whitespace-nowrap px-3">Balance (confirmed only)</TableHead>
                    <TableHead className="text-right font-semibold whitespace-nowrap px-3">Balance (incl. unconfirmed)</TableHead>
                    <TableHead className="text-right font-semibold whitespace-nowrap px-3.5">Own money used</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingTracker ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                        <RefreshCw className="h-5 w-5 animate-spin inline mr-2" />
                        Loading daily statement…
                      </TableCell>
                    </TableRow>
                  ) : currentTabRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                        No statement activity found for the selected desks and date range.
                      </TableCell>
                    </TableRow>
                  ) : (
                    currentTabRows.map((row: MerchantDeskDailyTrackerRow, idx: number) => {
                      const hasOop =
                        (row.oop_outstanding_confirmed != null && row.oop_outstanding_confirmed > 0) ||
                        (row.oop_outstanding_with_suggested != null && row.oop_outstanding_with_suggested > 0);

                      return (
                        <TableRow key={`${row.desk_label}-${row.day}-${idx}`} className="hover:bg-muted/30 border-b">
                          <TableCell className="sticky left-0 z-10 bg-card font-mono text-xs font-semibold text-foreground px-3.5 whitespace-nowrap shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]">
                            {row.day}
                          </TableCell>
                          <TableCell className="font-medium whitespace-nowrap px-3">
                            <span className={row.desk_label === 'ALL DESKS' ? 'font-bold text-primary' : ''}>
                              {row.desk_label}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums whitespace-nowrap px-3">
                            {formatUGX(row.given_ledger ?? 0)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums whitespace-nowrap text-emerald-700 dark:text-emerald-400 font-medium px-3">
                            {formatUGX(row.given_external_confirmed ?? 0)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums whitespace-nowrap px-3">
                            {row.given_external_suggested > 0 ? (
                              <span className="italic text-amber-700 dark:text-amber-400 font-medium inline-flex items-center justify-end gap-1.5">
                                {formatUGX(row.given_external_suggested)}
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1 py-0 h-4 border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400"
                                >
                                  unconfirmed
                                </Badge>
                              </span>
                            ) : (
                              <span className="text-muted-foreground italic">0</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums whitespace-nowrap text-muted-foreground px-3">
                            {formatUGX(row.taken_back ?? 0)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums whitespace-nowrap px-3">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help underline decoration-dotted underline-offset-2">
                                  {formatUGX(row.used ?? 0)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">
                                <p>
                                  {row.payouts ?? 0} payouts, of which UGX {formatUGX(row.bank_payouts_amount ?? 0)} by
                                  bank
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap px-3">
                            {renderTableBalanceCell(row.running_confirmed ?? 0)}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap px-3">
                            {renderTableBalanceCell(row.running_with_suggested ?? 0)}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap px-3.5">
                            {hasOop ? (
                              <span className="text-rose-600 dark:text-rose-400 font-semibold font-mono tabular-nums whitespace-nowrap">
                                {formatUGX(row.oop_outstanding_confirmed ?? 0)}
                                {row.oop_outstanding_with_suggested !== row.oop_outstanding_confirmed && (
                                  <span className="text-xs font-normal text-muted-foreground ml-1">
                                    / {formatUGX(row.oop_outstanding_with_suggested ?? 0)}
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="text-muted-foreground font-mono">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </TooltipProvider>
          </div>
        </CardContent>
      </Card>

      {/* SECTION 3: BANK TRANSFERS AWAITING CONFIRMATION */}
      <Card className="border border-border/80 shadow-xs bg-card">
        <CardHeader className="p-4 pb-3 border-b bg-muted/10">
          <div className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-primary" />
            <CardTitle className="text-base font-semibold text-foreground">
              Bank Transfers Awaiting Confirmation
            </CardTitle>
          </div>
          <CardDescription className="text-xs text-muted-foreground mt-0.5">
            Review suggested bank fundings and decide whether to confirm or reject.
          </CardDescription>
        </CardHeader>

        <CardContent className="p-4 space-y-4">
          {/* Warning banner */}
          <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-xs flex gap-2.5 items-start">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-amber-950 dark:text-amber-100">Reconciliation Caution</p>
              <p className="leading-relaxed">
                Reject a transfer if the same money was already entered as float in the system (e.g. 11 Sep, UGX
                20,189,508 float reconciliation), otherwise it is counted twice. MTN → Equity SMS do not show the
                destination account — confirm only if you know it funded this desk.
              </p>
            </div>
          </div>

          {/* Transfers Tabs */}
          <Tabs defaultValue="suggested" className="w-full">
            <TabsList className="h-8 bg-muted/60 p-0.5">
              <TabsTrigger value="suggested" className="text-xs h-7 px-3.5 font-medium">
                Unconfirmed ({unconfirmedTransfers.length})
              </TabsTrigger>
              <TabsTrigger value="confirmed" className="text-xs h-7 px-3.5 font-medium">
                Confirmed ({confirmedTransfers.length})
              </TabsTrigger>
              <TabsTrigger value="rejected" className="text-xs h-7 px-3.5 font-medium">
                Rejected ({rejectedTransfers.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="suggested" className="mt-3.5">
              <TransferTable
                items={unconfirmedTransfers}
                deskNameMap={deskNameMap}
                isLoading={loadingTransfers}
                onConfirm={handleConfirmTransfer}
                onReject={handleOpenRejectDialog}
                onUndo={handleUndoDecision}
                status="suggested"
              />
            </TabsContent>

            <TabsContent value="confirmed" className="mt-3.5">
              <TransferTable
                items={confirmedTransfers}
                deskNameMap={deskNameMap}
                isLoading={loadingTransfers}
                onConfirm={handleConfirmTransfer}
                onReject={handleOpenRejectDialog}
                onUndo={handleUndoDecision}
                status="confirmed"
              />
            </TabsContent>

            <TabsContent value="rejected" className="mt-3.5">
              <TransferTable
                items={rejectedTransfers}
                deskNameMap={deskNameMap}
                isLoading={loadingTransfers}
                onConfirm={handleConfirmTransfer}
                onReject={handleOpenRejectDialog}
                onUndo={handleUndoDecision}
                status="rejected"
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* REJECT CONFIRMATION DIALOG */}
      <Dialog open={!!rejectingTransfer} onOpenChange={(open) => !open && setRejectingTransfer(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base text-rose-600 flex items-center gap-2">
              <XCircle className="h-5 w-5" />
              Reject bank funding transfer
            </DialogTitle>
            <DialogDescription className="text-xs">
              A rejection note is required to explain why this transfer is not valid (e.g. duplicate float, wrong desk,
              internal test).
            </DialogDescription>
          </DialogHeader>

          {rejectingTransfer && (
            <div className="space-y-3 py-2 text-xs">
              <div className="bg-muted/40 p-2.5 rounded border space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Amount:</span>
                  <span className="font-semibold text-foreground font-mono">{formatUGX(rejectingTransfer.amount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Date:</span>
                  <span>{formatEATDateTime(rejectingTransfer.funded_at)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Channel:</span>
                  <span>{channelLabel(rejectingTransfer.channel)}</span>
                </div>
                {rejectingTransfer.reference && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Reference:</span>
                    <span className="font-mono">{rejectingTransfer.reference}</span>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="reject-note" className="text-xs font-medium">
                  Rejection Reason / Note <span className="text-rose-500">*</span>
                </Label>
                <Textarea
                  id="reject-note"
                  placeholder="e.g. Already reconciled in system on 11 Sep"
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value)}
                  className="text-xs min-h-[70px]"
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setRejectingTransfer(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="text-xs"
              disabled={!rejectNote.trim() || decideMutation.isPending}
              onClick={handleConfirmReject}
            >
              {decideMutation.isPending ? 'Rejecting...' : 'Reject Transfer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ADD BANK FUNDING DIALOG */}
      <Dialog open={addFundingOpen} onOpenChange={setAddFundingOpen}>
        <DialogContent className="max-w-lg">
          <form onSubmit={handleSubmitAddFunding}>
            <DialogHeader>
              <DialogTitle className="text-base flex items-center gap-2">
                <Plus className="h-5 w-5 text-emerald-600" />
                Add bank funding (manual entry)
              </DialogTitle>
              <DialogDescription className="text-xs">
                Manually record external funding provided to a merchant desk. Rows added this way are created already
                confirmed.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3.5 py-3 text-xs">
              <div className="space-y-1">
                <Label htmlFor="add-desk" className="text-xs font-medium">
                  Merchant Desk <span className="text-rose-500">*</span>
                </Label>
                <Select value={addAgentId} onValueChange={setAddAgentId}>
                  <SelectTrigger id="add-desk" className="text-xs h-9">
                    <SelectValue placeholder="Select desk" />
                  </SelectTrigger>
                  <SelectContent>
                    {desks.map((d) => (
                      <SelectItem key={d.agentId} value={d.agentId} className="text-xs">
                        {d.label} — {d.fullName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="add-amount" className="text-xs font-medium">
                    Amount (UGX) <span className="text-rose-500">*</span>
                  </Label>
                  <Input
                    id="add-amount"
                    type="number"
                    min="1"
                    step="1"
                    placeholder="e.g. 50000000"
                    value={addAmount}
                    onChange={(e) => setAddAmount(e.target.value)}
                    className="text-xs h-9 font-mono"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="add-date" className="text-xs font-medium">
                    Date & Time (EAT) <span className="text-rose-500">*</span>
                  </Label>
                  <Input
                    id="add-date"
                    type="datetime-local"
                    value={addFundedAt}
                    onChange={(e) => setAddFundedAt(e.target.value)}
                    className="text-xs h-9"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="add-channel" className="text-xs font-medium">
                    Channel <span className="text-rose-500">*</span>
                  </Label>
                  <Select value={addChannel} onValueChange={setAddChannel}>
                    <SelectTrigger id="add-channel" className="text-xs h-9">
                      <SelectValue placeholder="Select channel" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bank_transfer" className="text-xs">
                        Bank → bank
                      </SelectItem>
                      <SelectItem value="mtn_to_bank" className="text-xs">
                        MTN line → Equity
                      </SelectItem>
                      <SelectItem value="airtel_to_bank" className="text-xs">
                        Airtel line → Equity
                      </SelectItem>
                      <SelectItem value="cash" className="text-xs">
                        Cash
                      </SelectItem>
                      <SelectItem value="other" className="text-xs">
                        Other
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="add-ref" className="text-xs font-medium">
                    Reference
                  </Label>
                  <Input
                    id="add-ref"
                    placeholder="e.g. EFT / Cheque / Bank ref"
                    value={addReference}
                    onChange={(e) => setAddReference(e.target.value)}
                    className="text-xs h-9 font-mono"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="add-note" className="text-xs font-medium">
                  Note
                </Label>
                <Textarea
                  id="add-note"
                  placeholder="Optional context regarding this funding..."
                  value={addNote}
                  onChange={(e) => setAddNote(e.target.value)}
                  className="text-xs min-h-[60px]"
                />
              </div>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setAddFundingOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                disabled={recordMutation.isPending}
              >
                {recordMutation.isPending ? 'Saving...' : 'Record bank funding'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface TransferTableProps {
  items: MerchantExternalFundingTransfer[];
  deskNameMap: Map<string, string>;
  isLoading: boolean;
  onConfirm: (t: MerchantExternalFundingTransfer) => void;
  onReject: (t: MerchantExternalFundingTransfer) => void;
  onUndo: (t: MerchantExternalFundingTransfer) => void;
  status: 'suggested' | 'confirmed' | 'rejected';
}

function TransferTable({
  items,
  deskNameMap,
  isLoading,
  onConfirm,
  onReject,
  onUndo,
  status,
}: TransferTableProps) {
  if (isLoading) {
    return (
      <div className="py-10 text-center text-xs text-muted-foreground border rounded-lg">
        <RefreshCw className="h-4 w-4 animate-spin inline mr-2" />
        Loading bank transfers...
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-muted-foreground border rounded-lg bg-card">
        No {status} bank transfers found for the selected desks.
      </div>
    );
  }

  return (
    <div className="border rounded-lg overflow-x-auto bg-card">
      <Table className="min-w-[950px] text-xs">
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40 border-b">
            <TableHead className="w-36 font-semibold">Date/time (EAT)</TableHead>
            <TableHead className="font-semibold">Desk</TableHead>
            <TableHead className="text-right font-semibold">Amount</TableHead>
            <TableHead className="font-semibold">Channel</TableHead>
            <TableHead className="font-semibold">Reference</TableHead>
            <TableHead className="font-semibold">From</TableHead>
            <TableHead className="font-semibold">To</TableHead>
            <TableHead className="font-semibold">Note</TableHead>
            <TableHead className="text-right font-semibold">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((transfer) => (
            <TableRow key={transfer.id} className="hover:bg-muted/30 border-b">
              <TableCell className="whitespace-nowrap text-muted-foreground font-mono text-[11px]">
                {formatEATDateTime(transfer.funded_at)}
              </TableCell>
              <TableCell className="font-medium whitespace-nowrap">
                {deskNameMap.get(transfer.agent_id) || transfer.agent_id.slice(0, 8)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-semibold font-mono text-foreground">
                {formatUGX(transfer.amount)}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Badge variant="outline" className="text-[11px] font-normal">
                  {channelLabel(transfer.channel)}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-[11px] max-w-[140px] truncate" title={transfer.reference || ''}>
                {transfer.reference || '—'}
              </TableCell>
              <TableCell className="text-muted-foreground max-w-[120px] truncate font-mono text-[11px]" title={transfer.source_account || ''}>
                {transfer.source_account || '—'}
              </TableCell>
              <TableCell className="text-muted-foreground max-w-[120px] truncate font-mono text-[11px]" title={transfer.destination_account || ''}>
                {transfer.destination_account || '—'}
              </TableCell>
              <TableCell className="max-w-[180px] truncate text-muted-foreground" title={transfer.note || ''}>
                {transfer.note || '—'}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {status === 'suggested' ? (
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                      onClick={() => onConfirm(transfer)}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" />
                      Confirm
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/40"
                      onClick={() => onReject(transfer)}
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1" />
                      Reject
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-2">
                    {transfer.decided_at && (
                      <span className="text-[10px] text-muted-foreground font-mono" title={transfer.decided_at}>
                        {formatEATDateTime(transfer.decided_at)}
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      title="Revert back to unconfirmed"
                      onClick={() => onUndo(transfer)}
                    >
                      <RotateCcw className="h-3.5 w-3.5 mr-1" />
                      Undo
                    </Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
