import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { fetchOpsWalletBuckets } from '@/hooks/ops/useOpsDataLayer';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { 
  FileText, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Loader2, 
  User,
  Building,
  Calendar,
  Banknote,
  AlertTriangle,
  Filter,
  MessageCircle,
  Send,
  History,
  Share2,
  CheckCircle2,
  Phone,
  Shield,
  ShieldCheck,
  Wallet,
  MapPin,
  CreditCard,
  IdCard,
  Trash2,
  Pencil,
  HandCoins
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { format, addDays, isBefore, startOfDay } from 'date-fns';
import { parsePhoneNumber } from '@/lib/phoneUtils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
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
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { VerifyTenantButton, VerifyLandlordButton } from '@/components/verification';
import RentProcessTracker from '@/components/rent/RentProcessTracker';

interface RentRequest {
  id: string;
  rent_amount: number;
  total_repayment: number;
  access_fee: number;
  request_fee: number;
  duration_days: number;
  daily_repayment: number;
  amount_repaid: number;
  status: string | null;
  created_at: string;
  disbursed_at: string | null;
  funded_at: string | null;
  tenant_id: string;
  landlord_id: string;
  approval_comment: string | null;
  rejected_reason: string | null;
  approved_by: string | null;
  agent_verified?: boolean;
  manager_verified?: boolean;
  fund_recipient_type?: string | null;
  fund_recipient_name?: string | null;
  fund_routed_at?: string | null;
  tenant?: {
    full_name: string;
    phone: string;
    email?: string;
    avatar_url?: string | null;
    verified?: boolean;
    national_id?: string | null;
    city?: string | null;
    country?: string | null;
    created_at?: string;
    monthly_rent?: number | null;
    mobile_money_number?: string | null;
    mobile_money_provider?: string | null;
  };
  tenantWalletBalance?: number;
  landlord?: { id: string; name: string; property_address: string; verified?: boolean; ready_to_receive?: boolean };
  missedDays?: number;
  paidAmount?: number;
}

interface SentReminder {
  tenantId: string;
  tenantName: string;
  phone: string;
  missedDays: number;
  sentAt: Date;
}

export function RentRequestsManager() {
  const { toast } = useToast();
  const [, setSearchParams] = useSearchParams();

  const navigateToUser = (userName: string) => {
    setSearchParams({ tab: 'users', search: userName });
  };
  const [requests, setRequests] = useState<RentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectDialog, setRejectDialog] = useState<{ open: boolean; requestId: string | null }>({ open: false, requestId: null });
  const [approveDialog, setApproveDialog] = useState<{ open: boolean; requestId: string | null }>({ open: false, requestId: null });
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; requestId: string | null; tenantName: string }>({ open: false, requestId: null, tenantName: '' });
  const [deletingRequest, setDeletingRequest] = useState(false);
  const [editDialog, setEditDialog] = useState<{ open: boolean; request: RentRequest | null }>({ open: false, request: null });
  const [editFormData, setEditFormData] = useState({ rent_amount: '', total_repayment: '', amount_repaid: '', daily_repayment: '', duration_days: '' });
  const [savingEdit, setSavingEdit] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [approvalComment, setApprovalComment] = useState('');
  const [showDelinquentOnly, setShowDelinquentOnly] = useState(false);
  const [whatsappDialog, setWhatsappDialog] = useState<{ 
    open: boolean; 
    request: RentRequest | null;
    message: string;
  }>({ open: false, request: null, message: '' });
  const [bulkWhatsappDialog, setBulkWhatsappDialog] = useState(false);
  const [bulkSendingIndex, setBulkSendingIndex] = useState<number | null>(null);
  const [sentReminders, setSentReminders] = useState<SentReminder[]>([]);
  const [reminderHistoryDialog, setReminderHistoryDialog] = useState(false);
  const [bulkCompleteDialog, setBulkCompleteDialog] = useState<{ open: boolean; count: number; reminders: SentReminder[] }>({ open: false, count: 0, reminders: [] });
  const [collectDialog, setCollectDialog] = useState<{ open: boolean; request: RentRequest | null }>({ open: false, request: null });
  const [collecting, setCollecting] = useState(false);

  useEffect(() => {
    fetchRequests();

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fetchRequests(), 5000);
    };

    const channel = supabase
      .channel('rent-requests-manager-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rent_requests' },
        () => { debouncedFetch(); }
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchRequests = async () => {
    setLoading(true);
    
    // Limit to latest 200 requests instead of ALL rows
    const { data: requestsData, error } = await supabase
      .from('rent_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      setLoading(false);
      return;
    }

    // Chunk profile lookups to avoid URL length limits at scale
    const chunkArray = <T,>(arr: T[], size: number): T[][] => {
      const chunks: T[][] = [];
      for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
      return chunks;
    };

    const tenantIds = [...new Set((requestsData || []).map(r => r.tenant_id))];
    const landlordIds = [...new Set((requestsData || []).map(r => r.landlord_id))];

    // Fetch profiles in chunks of 50
    const profileChunks = chunkArray(tenantIds, 50);
    const landlordChunks = chunkArray(landlordIds, 50);

    const [profileResults, landlordResults, repaymentsRes, walletsRes] = await Promise.all([
      Promise.all(profileChunks.map(chunk =>
        supabase.from('profiles').select('id, full_name, phone, email, avatar_url, verified, national_id, city, country, created_at, monthly_rent, mobile_money_number, mobile_money_provider').in('id', chunk)
      )),
      Promise.all(landlordChunks.map(chunk =>
        supabase.from('landlords').select('id, name, property_address, verified, ready_to_receive').in('id', chunk)
      )),
      // repayments table removed - stub
      (() => Promise.resolve({ data: [] }))(),
      tenantIds.length > 0
        ? fetchOpsWalletBuckets(tenantIds).then(rows =>
            ({ data: rows.map(r => ({ user_id: r.user_id, balance: r.balance })) }))
        : Promise.resolve({ data: [] as { user_id: string; balance: number }[] }),
    ]);

    const profiles = profileResults.flatMap(r => r.data || []);
    const landlords = landlordResults.flatMap(r => r.data || []);

    const repayments = repaymentsRes.data;
    const walletsByUser = new Map((walletsRes.data || []).map(w => [w.user_id, w.balance]));

    // Calculate missed days for each request
    const today = startOfDay(new Date());
    
    const requestsWithDetails = (requestsData || []).map(r => {
      const requestRepayments = (repayments || []).filter(p => p.rent_request_id === r.id);
      const paidAmount = requestRepayments.reduce((sum, p) => sum + p.amount, 0);
      
      let missedDays = 0;
      
      // Only calculate missed days for active requests (funded or disbursed)
      if (r.status === 'funded' || r.status === 'disbursed') {
        const startDate = startOfDay(new Date(r.disbursed_at || r.funded_at || r.created_at));
        
        // Group payments by date
        const paymentsByDate: Record<string, number> = {};
        requestRepayments.forEach(p => {
          const dateKey = format(new Date(p.payment_date), 'yyyy-MM-dd');
          paymentsByDate[dateKey] = (paymentsByDate[dateKey] || 0) + p.amount;
        });
        
        // Count missed days
        for (let day = 1; day <= r.duration_days; day++) {
          const date = addDays(startDate, day - 1);
          if (isBefore(date, today)) {
            const dateKey = format(date, 'yyyy-MM-dd');
            const paidForDay = paymentsByDate[dateKey] || 0;
            if (paidForDay < r.daily_repayment) {
              missedDays++;
            }
          }
        }
      }
      
      return {
        ...r,
        tenant: profiles?.find(p => p.id === r.tenant_id),
        tenantWalletBalance: walletsByUser.get(r.tenant_id) ?? 0,
        landlord: landlords?.find(l => l.id === r.landlord_id),
        missedDays,
        paidAmount
      };
    });

    setRequests(requestsWithDetails);
    setLoading(false);
  };

  const handleApprove = async () => {
    if (!approveDialog.requestId) return;
    setProcessing(approveDialog.requestId);
    
    const { error } = await supabase.functions.invoke('approve-rent-request', {
      body: { 
        rent_request_id: approveDialog.requestId,
        approval_comment: approvalComment || null
      }
    });

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Request Approved', description: 'Rent request has been approved for funding' });
      setApproveDialog({ open: false, requestId: null });
      setApprovalComment('');
      fetchRequests();
    }
    setProcessing(null);
  };

  const openApproveDialog = (requestId: string) => {
    setApproveDialog({ open: true, requestId });
    setApprovalComment('');
  };

  const handleDeleteRequest = async () => {
    if (!deleteDialog.requestId) return;
    setDeletingRequest(true);
    const { error } = await supabase
      .from('rent_requests')
      .delete()
      .eq('id', deleteDialog.requestId);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Request Deleted', description: 'Rent request has been permanently deleted' });
      setDeleteDialog({ open: false, requestId: null, tenantName: '' });
      fetchRequests();
    }
    setDeletingRequest(false);
  };

  const openEditDialog = (request: RentRequest) => {
    setEditFormData({
      rent_amount: String(request.rent_amount),
      total_repayment: String(request.total_repayment),
      amount_repaid: String(request.amount_repaid || 0),
      daily_repayment: String(request.daily_repayment),
      duration_days: String(request.duration_days),
    });
    setEditDialog({ open: true, request });
  };

  const handleSaveEdit = async () => {
    if (!editDialog.request) return;
    setSavingEdit(true);
    const { error } = await supabase
      .from('rent_requests')
      .update({
        rent_amount: Number(editFormData.rent_amount) || 0,
        total_repayment: Number(editFormData.total_repayment) || 0,
        amount_repaid: Number(editFormData.amount_repaid) || 0,
        daily_repayment: Number(editFormData.daily_repayment) || 0,
        duration_days: Number(editFormData.duration_days) || 0,
      })
      .eq('id', editDialog.request.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Request Updated', description: 'Rent request has been updated successfully' });
      setEditDialog({ open: false, request: null });
      fetchRequests();
    }
    setSavingEdit(false);
  };

  const handleReject = async () => {
    if (!rejectDialog.requestId) return;
    if (!rejectReason.trim()) {
      toast({ title: 'Error', description: 'Please provide a reason for rejection', variant: 'destructive' });
      return;
    }
    setProcessing(rejectDialog.requestId);

    const { error } = await supabase
      .from('rent_requests')
      .update({ 
        status: 'rejected',
        rejected_reason: rejectReason
      })
      .eq('id', rejectDialog.requestId);

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Request Rejected', description: 'Rent request has been rejected' });
      setRejectDialog({ open: false, requestId: null });
      setRejectReason('');
      fetchRequests();
    }
    setProcessing(null);
  };

  const getStatusBadge = (status: string | null) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30 gap-1"><Clock className="h-3 w-3" />Pending</Badge>;
      case 'approved':
        return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 gap-1"><CheckCircle className="h-3 w-3" />Approved</Badge>;
      case 'funded':
        return <Badge variant="outline" className="bg-success/10 text-success border-success/30 gap-1"><Banknote className="h-3 w-3" />Funded</Badge>;
      case 'disbursed':
        return <Badge variant="outline" className="bg-chart-5/10 text-chart-5 border-chart-5/30 gap-1"><CheckCircle className="h-3 w-3" />Disbursed</Badge>;
      case 'completed':
        return <Badge className="bg-success text-success-foreground gap-1"><CheckCircle className="h-3 w-3" />Completed</Badge>;
      case 'rejected':
        return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Rejected</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  // Defensive: only show "Completed" when the rent has actually been fully repaid.
  const getStatusBadgeForRequest = (req: { status: string | null; amount_repaid?: number | null; paidAmount?: number | null; total_repayment?: number | null }) => {
    if (req.status === 'completed') {
      const repaid = Number(req.amount_repaid ?? req.paidAmount ?? 0);
      const total = Number(req.total_repayment ?? 0);
      if (total > 0 && repaid < total) {
        return <Badge variant="outline" className="bg-chart-5/10 text-chart-5 border-chart-5/30 gap-1"><Banknote className="h-3 w-3" />Active</Badge>;
      }
    }
    return getStatusBadge(req.status);
  };

  const generateReminderMessage = (request: RentRequest) => {
    const tenantName = request.tenant?.full_name?.split(' ')[0] || 'there';
    const missedDays = request.missedDays || 0;
    const outstandingAmount = request.total_repayment - (request.paidAmount || 0);
    const dailyAmount = request.daily_repayment;
    
    return `Hi ${tenantName}! 👋

This is a friendly reminder from Welile about your rent repayment.

📊 *Your Payment Status:*
• Missed Days: ${missedDays}
• Outstanding: ${formatUGX(outstandingAmount)}
• Daily Payment: ${formatUGX(dailyAmount)}

💡 *Why Pay on Time?*
✅ Your rent access limit *increases* with every payment you make!
✅ Consistent payments unlock *higher rent amounts* for future requests
✅ Build a strong payment history for better terms

🎯 The more you pay, the more we can help you access! Start small - even ${formatUGX(dailyAmount)} today helps build your limit.

Need help or have questions? Reply to this message and we'll assist you.

Thank you for being part of Welile! 🏠`;
  };

  const openWhatsappDialog = (request: RentRequest) => {
    const message = generateReminderMessage(request);
    setWhatsappDialog({ open: true, request, message });
  };

  const sendWhatsappReminder = () => {
    if (!whatsappDialog.request?.tenant?.phone) {
      toast({ 
        title: 'Error', 
        description: 'No phone number available for this tenant', 
        variant: 'destructive' 
      });
      return;
    }
    
    const phoneInfo = parsePhoneNumber(whatsappDialog.request.tenant.phone);
    const encodedMessage = encodeURIComponent(whatsappDialog.message);
    const whatsappUrl = `${phoneInfo.whatsappLink}?text=${encodedMessage}`;
    
    window.open(whatsappUrl, '_blank');
    
    // Track sent reminder
    const newReminder: SentReminder = {
      tenantId: whatsappDialog.request.tenant_id,
      tenantName: whatsappDialog.request.tenant.full_name,
      phone: whatsappDialog.request.tenant.phone,
      missedDays: whatsappDialog.request.missedDays || 0,
      sentAt: new Date()
    };
    setSentReminders(prev => [newReminder, ...prev]);
    
    toast({
      title: 'WhatsApp Opened',
      description: `Reminder prepared for ${whatsappDialog.request.tenant.full_name}`,
    });
    
    setWhatsappDialog({ open: false, request: null, message: '' });
  };

  // Get delinquent tenants with phone numbers for bulk messaging
  const getDelinquentTenantsWithPhone = () => {
    return requests.filter(r => 
      (r.missedDays || 0) > 0 && 
      r.tenant?.phone &&
      (r.status === 'funded' || r.status === 'disbursed')
    );
  };

  const sendBulkWhatsappReminder = async (index: number, bulkReminders: SentReminder[]) => {
    const delinquentTenants = getDelinquentTenantsWithPhone();
    
    if (index >= delinquentTenants.length) {
      setBulkSendingIndex(null);
      // Add all bulk reminders to history
      setSentReminders(prev => [...bulkReminders, ...prev]);
      // Show completion dialog
      setBulkCompleteDialog({ 
        open: true, 
        count: delinquentTenants.length,
        reminders: bulkReminders
      });
      return;
    }
    
    const request = delinquentTenants[index];
    if (!request.tenant?.phone) {
      sendBulkWhatsappReminder(index + 1, bulkReminders);
      return;
    }
    
    setBulkSendingIndex(index);
    
    const message = generateReminderMessage(request);
    const phoneInfo = parsePhoneNumber(request.tenant.phone);
    const encodedMessage = encodeURIComponent(message);
    const whatsappUrl = `${phoneInfo.whatsappLink}?text=${encodedMessage}`;
    
    window.open(whatsappUrl, '_blank');
    
    // Track this reminder
    const newReminder: SentReminder = {
      tenantId: request.tenant_id,
      tenantName: request.tenant.full_name,
      phone: request.tenant.phone,
      missedDays: request.missedDays || 0,
      sentAt: new Date()
    };
    
    // Wait a bit before opening next to avoid popup blocker
    setTimeout(() => {
      sendBulkWhatsappReminder(index + 1, [...bulkReminders, newReminder]);
    }, 1500);
  };

  const startBulkReminders = () => {
    const delinquentTenants = getDelinquentTenantsWithPhone();
    if (delinquentTenants.length === 0) {
      toast({
        title: 'No Delinquent Tenants',
        description: 'There are no delinquent tenants with phone numbers to message.',
        variant: 'destructive',
      });
      return;
    }
    
    setBulkWhatsappDialog(false);
    sendBulkWhatsappReminder(0, []);
  };

  const handleManualCollect = async () => {
    if (!collectDialog.request) return;
    setCollecting(true);
    try {
      const { data, error } = await supabase.functions.invoke('manual-collect-rent', {
        body: { rent_request_id: collectDialog.request.id },
      });
      if (error) {
        const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
        const msg = await extractFromErrorObject(error, 'Collection failed');
        throw new Error(msg);
      }
      if (data?.error) {
        toast({ title: 'Collection Failed', description: data.error, variant: 'destructive' });
      } else {
        const parts: string[] = [];
        if (data.tenant_deducted > 0) parts.push(`Tenant: ${formatUGX(data.tenant_deducted)}`);
        if (data.agent_deducted > 0) parts.push(`Agent: ${formatUGX(data.agent_deducted)}`);
        toast({ title: '✅ Rent Collected', description: `${formatUGX(data.total_collected)} collected. ${parts.join(' · ')}` });
        setCollectDialog({ open: false, request: null });
        fetchRequests();
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Failed to collect rent', variant: 'destructive' });
    }
    setCollecting(false);
  };

  const pendingRequests = requests.filter(r => r.status === 'pending');
  const delinquentRequests = requests.filter(r => (r.missedDays || 0) > 0);
  const delinquentWithPhone = getDelinquentTenantsWithPhone();
  const activeRequests = requests.filter(r => r.status === 'funded' || r.status === 'disbursed');
  
  // Apply delinquent filter
  const filteredOtherRequests = showDelinquentOnly 
    ? requests.filter(r => r.status !== 'pending' && (r.missedDays || 0) > 0)
    : requests.filter(r => r.status !== 'pending');

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-warning/5 border-warning/20">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-warning" />
              <div>
                <p className="text-sm text-muted-foreground">Pending</p>
                <p className="text-xl font-bold text-warning">{pendingRequests.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-success/5 border-success/20">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-5 w-5 text-success" />
              <div>
                <p className="text-sm text-muted-foreground">Funded</p>
                <p className="text-xl font-bold text-success">{requests.filter(r => ['funded', 'disbursed', 'completed'].includes(r.status || '')).length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Banknote className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm text-muted-foreground">Total Facilitated</p>
                <p className="text-lg font-bold text-primary">{formatUGX(requests.filter(r => ['funded', 'disbursed', 'completed'].includes(r.status || '')).reduce((sum, r) => sum + r.rent_amount, 0))}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className={`cursor-pointer transition-all ${showDelinquentOnly ? 'ring-2 ring-destructive' : ''}`} onClick={() => setShowDelinquentOnly(!showDelinquentOnly)}>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <div>
                <p className="text-sm text-muted-foreground">Delinquent</p>
                <p className="text-xl font-bold text-destructive">{delinquentRequests.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Total Requests</p>
                <p className="text-xl font-bold">{requests.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Delinquent Filter Toggle & Bulk Actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3 rounded-lg border bg-muted/30">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <Label htmlFor="delinquent-filter" className="text-sm font-medium cursor-pointer">
            Show only delinquent accounts (missed payments)
          </Label>
          <Switch
            id="delinquent-filter"
            checked={showDelinquentOnly}
            onCheckedChange={setShowDelinquentOnly}
          />
        </div>
        
        <div className="flex items-center gap-2">
          {/* Reminder History Button */}
          {sentReminders.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setReminderHistoryDialog(true)}
            >
              <History className="h-4 w-4" />
              History ({sentReminders.length})
            </Button>
          )}
          
          {/* Bulk WhatsApp Button */}
          {delinquentWithPhone.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-green-600 border-green-200 hover:bg-green-50 hover:text-green-700"
              onClick={() => setBulkWhatsappDialog(true)}
              disabled={bulkSendingIndex !== null}
            >
              {bulkSendingIndex !== null ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending {bulkSendingIndex + 1}/{delinquentWithPhone.length}...
                </>
              ) : (
                <>
                  <MessageCircle className="h-4 w-4" />
                  Remind All ({delinquentWithPhone.length})
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Pending Requests */}
      {pendingRequests.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold flex items-center gap-2">
            <Clock className="h-4 w-4 text-warning" />
            Pending Requests ({pendingRequests.length})
          </h3>
          <div className="space-y-3">
            {pendingRequests.map((request) => (
              <Card key={request.id} className="border-warning/30">
                <CardContent className="p-4">
                   <div className="flex flex-col gap-3">
                    {/* Tenant Details Section */}
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <Avatar className="h-11 w-11 border-2 border-border">
                          <AvatarImage src={request.tenant?.avatar_url || undefined} />
                          <AvatarFallback className="bg-muted text-muted-foreground font-medium text-sm">
                            {(request.tenant?.full_name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <button onClick={(e) => { e.stopPropagation(); navigateToUser(request.tenant?.full_name || ''); }} className="font-semibold text-primary hover:underline cursor-pointer">{request.tenant?.full_name || 'Unknown Tenant'}</button>
                            {request.tenant?.verified && (
                              <CheckCircle2 className="h-4 w-4 text-primary" />
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Phone className="h-3 w-3" />
                            <span>{request.tenant?.phone || 'N/A'}</span>
                          </div>
                          {request.tenant?.email && (
                            <p className="text-xs text-muted-foreground truncate max-w-[200px]">{request.tenant.email}</p>
                          )}
                        </div>
                      </div>
                      {getStatusBadgeForRequest(request)}
                    </div>

                    {/* Process Step Tracker */}
                    <RentProcessTracker
                      requestStatus={request.status || 'pending'}
                      agentVerified={request.agent_verified}
                      managerApproved={['approved', 'funded', 'disbursed', 'completed'].includes(request.status || '')}
                      supporterFunded={['funded', 'disbursed', 'completed'].includes(request.status || '')}
                      fundRecipientType={request.fund_recipient_type}
                      fundRecipientName={request.fund_recipient_name}
                      fundRoutedAt={request.fund_routed_at}
                      compact
                    />

                    {/* Tenant Quick Info Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                      <div className="flex items-center gap-1.5 p-2 rounded-lg bg-muted/50">
                        <Wallet className="h-3.5 w-3.5 text-success" />
                        <div>
                          <p className="text-muted-foreground text-[10px]">Wallet</p>
                          <p className="font-bold text-success">{formatUGX(request.tenantWalletBalance || 0)}</p>
                        </div>
                      </div>
                      {request.tenant?.national_id && (
                        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-muted/50">
                          <IdCard className="h-3.5 w-3.5 text-muted-foreground" />
                          <div>
                            <p className="text-muted-foreground text-[10px]">NIN</p>
                            <p className="font-bold truncate">{request.tenant.national_id}</p>
                          </div>
                        </div>
                      )}
                      {(request.tenant?.city || request.tenant?.country) && (
                        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-muted/50">
                          <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                          <div>
                            <p className="text-muted-foreground text-[10px]">Location</p>
                            <p className="font-bold truncate">{[request.tenant.city, request.tenant.country].filter(Boolean).join(', ')}</p>
                          </div>
                        </div>
                      )}
                      {request.tenant?.mobile_money_number && (
                        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-muted/50">
                          <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                          <div>
                            <p className="text-muted-foreground text-[10px]">{request.tenant.mobile_money_provider || 'MoMo'}</p>
                            <p className="font-bold truncate">{request.tenant.mobile_money_number}</p>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Landlord Info */}
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Building className="h-3.5 w-3.5" />
                      <span>{request.landlord?.name || 'Unknown'} — {request.landlord?.property_address || 'N/A'}</span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                      <div className="p-2 rounded-lg bg-secondary/50">
                        <p className="text-muted-foreground text-xs">Rent Amount</p>
                        <p className="font-bold">{formatUGX(request.rent_amount)}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-secondary/50">
                        <p className="text-muted-foreground text-xs">Access Fee</p>
                        <p className="font-bold">{formatUGX(request.access_fee)}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-secondary/50">
                        <p className="text-muted-foreground text-xs">Registration Fee</p>
                        <p className="font-bold">{formatUGX(request.request_fee)}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-secondary/50">
                        <p className="text-muted-foreground text-xs">Duration</p>
                        <p className="font-bold">{request.duration_days} days</p>
                      </div>
                      <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
                        <p className="text-muted-foreground text-xs">Total Repayment</p>
                        <p className="font-bold text-primary">{formatUGX(request.total_repayment)}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-success/10 border border-success/20">
                        <p className="text-muted-foreground text-xs">Daily Payment</p>
                        <p className="font-bold text-success">{formatUGX(request.daily_repayment)}</p>
                      </div>
                    </div>

                    {/* Verification Section */}
                    <div className="p-3 rounded-lg bg-muted/50 border space-y-3">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Shield className="h-4 w-4 text-primary" />
                        Verification Status
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Tenant:</span>
                          <VerifyTenantButton
                            requestId={request.id}
                            landlordId={request.landlord_id}
                            agentVerified={request.agent_verified}
                            managerVerified={request.manager_verified}
                            onVerified={fetchRequests}
                            variant="manager"
                          />
                          {request.agent_verified && (
                            <Badge variant="outline" className="bg-success/10 text-success border-success/30 gap-1 text-xs">
                              <CheckCircle2 className="h-3 w-3" />
                              Agent
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Landlord:</span>
                          {request.landlord && (
                            <VerifyLandlordButton
                              landlordId={request.landlord.id}
                              landlordName={request.landlord.name}
                              verified={request.landlord.verified}
                              readyToReceive={request.landlord.ready_to_receive}
                              onVerified={fetchRequests}
                            />
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        {format(new Date(request.created_at), 'MMM d, yyyy h:mm a')}
                      </div>
                      <div className="flex gap-2">
                        {/* Share with Agent via WhatsApp */}
                        {!request.agent_verified && (
                          <Button
                            size="default"
                            variant="outline"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const tenant = request.tenant;
                              const landlord = request.landlord;
                              const appUrl = 'https://welileapp.com';
                              const msg = `🏠 *VERIFICATION REQUEST*

Hi Agent! A tenant needs verification. Please verify them on the Welile app.

👤 *Tenant:* ${tenant?.full_name || 'Unknown'}
📍 *Location:* ${[tenant?.city, tenant?.country].filter(Boolean).join(', ') || 'N/A'}
💰 *Rent:* ${formatUGX(request.rent_amount)}

🏢 *Landlord:* ${landlord?.name || 'Unknown'}
📫 *Property:* ${landlord?.property_address || 'N/A'}

📋 *What to do:*
1. Visit the tenant & landlord in person
2. Collect the landlord's 2 verification PINs
3. Verify meter numbers (NWSC & UEDCL) and TIN
4. Submit verification on the app

💵 You earn *UGX 10,000* when the tenant's landlord receives rent!

👉 Open app: ${appUrl}`;
                              const encoded = encodeURIComponent(msg);
                              window.open(`https://wa.me/?text=${encoded}`, '_blank');
                              toast({ title: 'WhatsApp Opened', description: 'Share the message with an agent to verify this tenant' });
                            }}
                            className="text-[#25D366] border-[#25D366]/30 hover:bg-[#25D366]/10 min-h-[44px] touch-manipulation"
                            type="button"
                          >
                            <Share2 className="h-4 w-4 mr-1" />
                            Share
                          </Button>
                        )}
                        <Button
                          size="default"
                          variant="outline"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setRejectDialog({ open: true, requestId: request.id });
                          }}
                          disabled={processing === request.id}
                          className="text-destructive border-destructive/30 hover:bg-destructive/10 min-h-[44px] touch-manipulation"
                          type="button"
                        >
                          <XCircle className="h-4 w-4 mr-1" />
                          Reject
                        </Button>
                        <Button
                          size="default"
                          variant="success"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openApproveDialog(request.id);
                          }}
                          disabled={processing === request.id}
                          className="min-h-[44px] touch-manipulation"
                          type="button"
                        >
                          {processing === request.id ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-1" />
                          ) : (
                            <CheckCircle className="h-4 w-4 mr-1" />
                          )}
                          Approve
                        </Button>
                      </div>
                      {/* Delete Request */}
                      <div className="flex justify-end mt-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDeleteDialog({ open: true, requestId: request.id, tenantName: request.tenant?.full_name || 'Unknown' });
                          }}
                          className="text-destructive hover:bg-destructive/10 text-xs h-7 px-2 touch-manipulation"
                          type="button"
                        >
                          <Trash2 className="h-3 w-3 mr-1" />
                          Delete Request
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Other Requests */}
      <div className="space-y-3">
        <h3 className="font-semibold flex items-center gap-2">
          {showDelinquentOnly ? (
            <>
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Delinquent Accounts ({filteredOtherRequests.length})
            </>
          ) : (
            <>All Requests ({filteredOtherRequests.length})</>
          )}
        </h3>
        <div className="space-y-3">
          {filteredOtherRequests.map((request) => (
            <Card key={request.id} className={request.missedDays && request.missedDays > 0 ? 'border-destructive/30' : ''}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <button onClick={(e) => { e.stopPropagation(); navigateToUser(request.tenant?.full_name || ''); }} className="font-semibold text-primary hover:underline cursor-pointer">{request.tenant?.full_name || 'Unknown'}</button>
                      {getStatusBadgeForRequest(request)}
                      {request.missedDays && request.missedDays > 0 && (
                        <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30 gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {request.missedDays} missed
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span>{formatUGX(request.rent_amount)}</span>
                      <span>{request.duration_days} days</span>
                      <span>{format(new Date(request.created_at), 'MMM d, yyyy')}</span>
                    </div>
                    {request.paidAmount !== undefined && request.paidAmount > 0 && (
                      <div className="text-xs text-success">
                        Paid: {formatUGX(request.paidAmount)} / {formatUGX(request.total_repayment)}
                      </div>
                    )}
                  </div>
                  
                  {/* Action Buttons */}
                  <div className="flex items-center gap-2 shrink-0">
                    {/* WhatsApp Reminder Button for Delinquent */}
                    {request.missedDays && request.missedDays > 0 && request.tenant?.phone && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-green-600 border-green-200 hover:bg-green-50 hover:text-green-700"
                        onClick={() => openWhatsappDialog(request)}
                      >
                        <MessageCircle className="h-4 w-4" />
                        <span className="hidden sm:inline">Remind</span>
                      </Button>
                    )}
                    
                    {/* Collect Rent Button - only for funded/disbursed with outstanding balance */}
                    {(['funded', 'disbursed', 'approved'].includes(request.status || '')) && (request.total_repayment - (request.amount_repaid || 0)) > 0 && (
                      <Button
                        variant="success"
                        size="sm"
                        onClick={() => setCollectDialog({ open: true, request })}
                        className="gap-1.5 min-h-[40px] touch-manipulation font-bold shadow-md animate-pulse hover:animate-none px-4"
                      >
                        <HandCoins className="h-4 w-4" />
                        Collect
                      </Button>
                    )}

                    {/* Edit Button */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEditDialog(request)}
                      className="gap-1 text-primary border-primary/30 hover:bg-primary/10 min-h-[36px] touch-manipulation"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Edit</span>
                    </Button>
                    
                    {/* Delete Button */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleteDialog({ open: true, requestId: request.id, tenantName: request.tenant?.full_name || 'Unknown' })}
                      className="gap-1 text-destructive border-destructive/30 hover:bg-destructive/10 min-h-[36px] touch-manipulation"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Delete</span>
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {filteredOtherRequests.length === 0 && (
            <p className="text-center text-muted-foreground py-8">
              {showDelinquentOnly ? 'No delinquent accounts found' : 'No processed requests yet'}
            </p>
          )}
        </div>
      </div>

      {/* Approve Dialog */}
      <Dialog open={approveDialog.open} onOpenChange={(open) => setApproveDialog({ open, requestId: open ? approveDialog.requestId : null })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Request</DialogTitle>
            <DialogDescription>
              Add an optional comment for this approval.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Comment (optional)"
            value={approvalComment}
            onChange={(e) => setApprovalComment(e.target.value)}
          />
          <DialogFooter className="gap-2">
            <Button 
              variant="outline" 
              onClick={() => setApproveDialog({ open: false, requestId: null })}
              className="min-h-[44px]"
              type="button"
            >
              Cancel
            </Button>
            <Button 
              variant="success"
              onClick={(e) => {
                e.preventDefault();
                handleApprove();
              }} 
              disabled={processing !== null}
              className="min-h-[44px]"
              type="button"
            >
              {processing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle className="h-4 w-4 mr-1" />}
              Approve Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectDialog.open} onOpenChange={(open) => setRejectDialog({ open, requestId: open ? rejectDialog.requestId : null })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Request</DialogTitle>
            <DialogDescription>
              Please provide a reason for rejection.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Reason for rejection (required)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
          <DialogFooter className="gap-2">
            <Button 
              variant="outline" 
              onClick={() => setRejectDialog({ open: false, requestId: null })}
              className="min-h-[44px]"
              type="button"
            >
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={(e) => {
                e.preventDefault();
                handleReject();
              }} 
              disabled={processing !== null || !rejectReason.trim()}
              className="min-h-[44px]"
              type="button"
            >
              {processing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <XCircle className="h-4 w-4 mr-1" />}
              Reject Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* WhatsApp Reminder Dialog */}
      <Dialog open={whatsappDialog.open} onOpenChange={(open) => setWhatsappDialog({ open, request: open ? whatsappDialog.request : null, message: open ? whatsappDialog.message : '' })}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-green-600" />
              Send WhatsApp Reminder
            </DialogTitle>
            <DialogDescription>
              Send a payment reminder to {whatsappDialog.request?.tenant?.full_name || 'tenant'} encouraging them to pay and increase their rent limit.
            </DialogDescription>
          </DialogHeader>
          
          {whatsappDialog.request && (
            <div className="space-y-4">
              {/* Tenant Info */}
              <div className="p-3 rounded-lg bg-muted/50 space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{whatsappDialog.request.tenant?.full_name}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Phone: {whatsappDialog.request.tenant?.phone}
                </div>
                <div className="flex gap-3 text-xs">
                  <span className="text-destructive font-medium">
                    {whatsappDialog.request.missedDays} days missed
                  </span>
                  <span className="text-muted-foreground">
                    Outstanding: {formatUGX(whatsappDialog.request.total_repayment - (whatsappDialog.request.paidAmount || 0))}
                  </span>
                </div>
              </div>
              
              {/* Message Preview/Edit */}
              <div className="space-y-2">
                <Label htmlFor="whatsapp-message" className="text-sm font-medium">
                  Message Preview
                </Label>
                <Textarea
                  id="whatsapp-message"
                  value={whatsappDialog.message}
                  onChange={(e) => setWhatsappDialog(prev => ({ ...prev, message: e.target.value }))}
                  className="min-h-[200px] text-sm font-mono"
                  placeholder="Enter your message..."
                />
                <p className="text-xs text-muted-foreground">
                  You can edit the message before sending. The message will open in WhatsApp for you to review and send.
                </p>
              </div>
            </div>
          )}
          
          <DialogFooter className="gap-2">
            <Button 
              variant="outline" 
              onClick={() => setWhatsappDialog({ open: false, request: null, message: '' })}
              className="min-h-[44px]"
              type="button"
            >
              Cancel
            </Button>
            <Button 
              onClick={sendWhatsappReminder}
              className="min-h-[44px] bg-green-600 hover:bg-green-700 text-white gap-2"
              type="button"
            >
              <Send className="h-4 w-4" />
              Open in WhatsApp
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk WhatsApp Reminder Dialog */}
      <Dialog open={bulkWhatsappDialog} onOpenChange={setBulkWhatsappDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-green-600" />
              Bulk WhatsApp Reminders
            </DialogTitle>
            <DialogDescription>
              Send payment reminders to all {delinquentWithPhone.length} delinquent tenants with missed payments.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            {/* Summary */}
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
              <div className="flex items-center gap-2 text-destructive font-medium text-sm mb-2">
                <AlertTriangle className="h-4 w-4" />
                {delinquentWithPhone.length} Delinquent Tenants
              </div>
              <p className="text-xs text-muted-foreground">
                Total missed payments: {delinquentWithPhone.reduce((sum, r) => sum + (r.missedDays || 0), 0)} days
              </p>
            </div>
            
            {/* Tenant List Preview */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Tenants to be messaged:</Label>
              <div className="max-h-48 overflow-y-auto space-y-2 border rounded-md p-2">
                {delinquentWithPhone.map((request, index) => (
                  <div key={request.id} className="flex items-center justify-between text-sm p-2 rounded bg-muted/50">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">{index + 1}.</span>
                      <User className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium">{request.tenant?.full_name}</span>
                    </div>
                    <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30 text-xs">
                      {request.missedDays} missed
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
            
            {/* Warning */}
            <div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
              <p className="text-xs text-warning-foreground">
                <strong>Note:</strong> This will open {delinquentWithPhone.length} WhatsApp tabs sequentially. 
                Each message will be pre-filled and ready to send. Please allow pop-ups for this site.
              </p>
            </div>
          </div>
          
          <DialogFooter className="gap-2">
            <Button 
              variant="outline" 
              onClick={() => setBulkWhatsappDialog(false)}
              className="min-h-[44px]"
              type="button"
            >
              Cancel
            </Button>
            <Button 
              onClick={startBulkReminders}
              className="min-h-[44px] bg-green-600 hover:bg-green-700 text-white gap-2"
              type="button"
            >
              <Send className="h-4 w-4" />
              Send All Reminders
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Complete Dialog */}
      <Dialog open={bulkCompleteDialog.open} onOpenChange={(open) => setBulkCompleteDialog({ open, count: 0, reminders: [] })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-success">
              <CheckCircle2 className="h-5 w-5" />
              Bulk Reminders Complete!
            </DialogTitle>
            <DialogDescription>
              Successfully opened WhatsApp for {bulkCompleteDialog.count} delinquent tenants.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-success/10 border border-success/20 text-center">
              <div className="text-3xl font-bold text-success mb-1">{bulkCompleteDialog.count}</div>
              <div className="text-sm text-muted-foreground">Reminders Sent</div>
            </div>
            
            {bulkCompleteDialog.reminders.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Tenants Messaged:</Label>
                <div className="max-h-40 overflow-y-auto space-y-1 border rounded-md p-2">
                  {bulkCompleteDialog.reminders.map((reminder, index) => (
                    <div key={`${reminder.tenantId}-${index}`} className="flex items-center justify-between text-sm p-2 rounded bg-muted/50">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="h-3 w-3 text-success" />
                        <span className="font-medium">{reminder.tenantName}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{reminder.missedDays} missed</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            <p className="text-xs text-muted-foreground text-center">
              All reminders have been tracked and saved in your history.
            </p>
          </div>
          
          <DialogFooter>
            <Button 
              onClick={() => setBulkCompleteDialog({ open: false, count: 0, reminders: [] })}
              className="min-h-[44px] w-full"
              type="button"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reminder History Dialog */}
      <Dialog open={reminderHistoryDialog} onOpenChange={setReminderHistoryDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" />
              Reminder History
            </DialogTitle>
            <DialogDescription>
              Track of all payment reminders sent this session.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-primary/5 border border-primary/20">
              <div className="flex items-center gap-2">
                <MessageCircle className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">Total Reminders Sent</span>
              </div>
              <Badge className="bg-primary">{sentReminders.length}</Badge>
            </div>
            
            {sentReminders.length > 0 ? (
              <div className="max-h-80 overflow-y-auto space-y-2">
                {sentReminders.map((reminder, index) => (
                  <Card key={`${reminder.tenantId}-${index}`} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium text-sm">{reminder.tenantName}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Phone className="h-3 w-3" />
                          <span>{reminder.phone}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          <span>{format(reminder.sentAt, 'MMM d, yyyy h:mm a')}</span>
                        </div>
                      </div>
                      <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30 text-xs shrink-0">
                        {reminder.missedDays} missed
                      </Badge>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <MessageCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No reminders sent yet</p>
              </div>
            )}
            
            {sentReminders.length > 0 && (
              <div className="p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground">
                <strong>Note:</strong> This history is only stored for the current session. 
                Refreshing the page will clear this history.
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button 
              variant="outline"
              onClick={() => setReminderHistoryDialog(false)}
              className="min-h-[44px]"
              type="button"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Rent Request Confirm Dialog */}
      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => !open && setDeleteDialog({ open: false, requestId: null, tenantName: '' })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rent Request?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the rent request for <strong>{deleteDialog.tenantName}</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteRequest}
              disabled={deletingRequest}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingRequest ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Deleting...</> : <><Trash2 className="h-4 w-4 mr-2" />Delete Request</>}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Rent Request Dialog */}
      <Dialog open={editDialog.open} onOpenChange={(open) => !open && setEditDialog({ open: false, request: null })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-primary" />
              Edit Rent Request
            </DialogTitle>
            <DialogDescription>
              Modify the receivable for <strong>{editDialog.request?.tenant?.full_name || 'Unknown'}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Rent Amount (UGX)</Label>
              <Input
                type="number"
                value={editFormData.rent_amount}
                onChange={(e) => setEditFormData(prev => ({ ...prev, rent_amount: e.target.value }))}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Total Repayment (UGX)</Label>
              <Input
                type="number"
                value={editFormData.total_repayment}
                onChange={(e) => setEditFormData(prev => ({ ...prev, total_repayment: e.target.value }))}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Amount Repaid (UGX)</Label>
              <Input
                type="number"
                value={editFormData.amount_repaid}
                onChange={(e) => setEditFormData(prev => ({ ...prev, amount_repaid: e.target.value }))}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Daily Repayment (UGX)</Label>
              <Input
                type="number"
                value={editFormData.daily_repayment}
                onChange={(e) => setEditFormData(prev => ({ ...prev, daily_repayment: e.target.value }))}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label className="text-xs font-medium">Duration (Days)</Label>
              <Input
                type="number"
                value={editFormData.duration_days}
                onChange={(e) => setEditFormData(prev => ({ ...prev, duration_days: e.target.value }))}
                className="h-11"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditDialog({ open: false, request: null })} className="min-h-[44px]" type="button">
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit} className="min-h-[44px] gap-2" type="button">
              {savingEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual Collect Rent Dialog */}
      <AlertDialog open={collectDialog.open} onOpenChange={(open) => !open && setCollectDialog({ open: false, request: null })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <HandCoins className="h-5 w-5 text-success" />
              Collect Rent Manually
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Collect one instalment ({formatUGX(collectDialog.request?.daily_repayment || 0)}) from <strong>{collectDialog.request?.tenant?.full_name || 'Unknown'}</strong>.
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2 rounded-lg bg-muted/50">
                    <p className="text-muted-foreground">Outstanding</p>
                    <p className="font-bold text-destructive">
                      {formatUGX((collectDialog.request?.total_repayment || 0) - (collectDialog.request?.amount_repaid || 0))}
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted/50">
                    <p className="text-muted-foreground">Tenant Wallet</p>
                    <p className="font-bold text-success">{formatUGX(collectDialog.request?.tenantWalletBalance || 0)}</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Will deduct from tenant's wallet first. If insufficient, the linked agent's wallet will be charged for the shortfall.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={collecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleManualCollect(); }}
              disabled={collecting}
              className="bg-success text-success-foreground hover:bg-success/90 gap-2"
            >
              {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />}
              {collecting ? 'Collecting...' : 'Collect Now'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
