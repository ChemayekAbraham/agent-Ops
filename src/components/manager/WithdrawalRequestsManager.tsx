import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { 
  ArrowDownToLine, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Loader2,
  AlertCircle,
  RefreshCw,
  Phone,
  Wallet,
  Smartphone,
  Copy,
  Check,
  Download,
  History,
  Filter,
  Calendar,
  ChevronDown,
  Square,
  CheckSquare,
  Minus,
  Printer,
  Share2,
  ExternalLink,
  Wrench
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { fetchOpsWalletBuckets, trackOpsQuery } from '@/hooks/ops/useOpsDataLayer';
import { UserAvatar } from '@/components/UserAvatar';
import { format, formatDistanceToNow } from 'date-fns';
import { exportToCSV } from '@/lib/exportUtils';
import UserDetailsDialog from '@/components/manager/UserDetailsDialog';
import WithdrawalRecordDetailDialog from '@/components/manager/WithdrawalRecordDetailDialog';
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

interface FundSource {
  category: string;
  total: number;
}

interface WithdrawalRequest {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  mobile_money_number: string | null;
  mobile_money_provider: string | null;
  mobile_money_name: string | null;
  created_at: string;
  rejection_reason: string | null;
  transaction_id: string | null;
  processed_at: string | null;
  processed_by: string | null;
  sub_category?: string | null;
  user?: {
    full_name: string;
    phone: string;
    avatar_url: string | null;
  };
  wallet_balance?: number;
  fund_sources?: FundSource[];
}

const SUB_CATEGORY_LABELS: Record<string, { label: string; color: string; icon: any }> = {
  general: { label: 'General', color: 'bg-muted text-muted-foreground border-border', icon: null },
  repair: { label: 'Repair', color: 'bg-amber-100 text-amber-700 border-amber-300', icon: Wrench },
  rent: { label: 'Rent', color: 'bg-blue-100 text-blue-700 border-blue-300', icon: null },
  commission: { label: 'Commission', color: 'bg-emerald-100 text-emerald-700 border-emerald-300', icon: null },
  investment: { label: 'Investment', color: 'bg-purple-100 text-purple-700 border-purple-300', icon: null },
  roi: { label: 'ROI', color: 'bg-rose-100 text-rose-700 border-rose-300', icon: null },
};

interface WithdrawalRequestsManagerProps {
  subCategoryFilter?: string;
}

export function WithdrawalRequestsManager({ subCategoryFilter: propSubCategoryFilter }: WithdrawalRequestsManagerProps = {}) {

  const { user } = useAuth();
  const [requests, setRequests] = useState<WithdrawalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<WithdrawalRequest | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [_allRequests, _setAllRequests] = useState<WithdrawalRequest[]>([]);
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [sharing, setSharing] = useState(false);

  // User details dialog state
  const [selectedUserForDetail, setSelectedUserForDetail] = useState<{
    id: string; full_name: string; email: string; phone: string; avatar_url: string | null;
    rent_discount_active: boolean; monthly_rent: number | null; roles: string[];
    average_rating: number | null; rating_count: number; verified?: boolean;
  } | null>(null);
  const [userDetailOpen, setUserDetailOpen] = useState(false);
  
  // History state
  const [activeTab, setActiveTab] = useState<'pending' | 'history'>('pending');
  const [historyRequests, setHistoryRequests] = useState<WithdrawalRequest[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({
    from: undefined,
    to: undefined
  });
  const [datePreset, setDatePreset] = useState<'all' | 'today' | '7days' | '30days' | 'custom'>('all');
  const [subCategoryFilter, setSubCategoryFilter] = useState<string>(propSubCategoryFilter || 'all');

  // Debounce the due-diligence search so each keystroke doesn't hit the DB.
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Batch selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchRejectDialogOpen, setBatchRejectDialogOpen] = useState(false);
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);

  // Selection helpers
  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === requests.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(requests.map(r => r.id)));
    }
  };

  const clearSelection = () => setSelectedIds(new Set());

  // Open user details dialog by fetching full user data
  const openUserDetail = useCallback(async (userId: string) => {
    try {
      const [profileRes, rolesRes] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', userId).single(),
        supabase.from('user_roles').select('role').eq('user_id', userId),
      ]);
      if (profileRes.data) {
        setSelectedUserForDetail({
          id: profileRes.data.id,
          full_name: profileRes.data.full_name,
          email: profileRes.data.email,
          phone: profileRes.data.phone,
          avatar_url: profileRes.data.avatar_url,
          rent_discount_active: profileRes.data.rent_discount_active,
          monthly_rent: profileRes.data.monthly_rent ?? null,
          roles: (rolesRes.data || []).map((r: any) => r.role),
          average_rating: null,
          rating_count: 0,
          verified: profileRes.data.verified,
        });
        setUserDetailOpen(true);
      }
    } catch (e) {
      console.error('Failed to load user details:', e);
    }
  }, []);

  // Polling removed — violates no-polling rule. Manager refreshes manually.

  const copyToClipboard = async (text: string, requestId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(requestId);
      toast.success('Number copied!');
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  const handleExportCSV = async () => {
    setExporting(true);
    try {
      // Fetch withdrawal requests for export — bounded to last 1000 for safety
      const { data: exportData, error } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;

      if (!exportData || exportData.length === 0) {
        toast.error('No withdrawal requests to export');
        return;
      }

      // Fetch user profiles for all requests
      const userIds = [...new Set(exportData.map(r => r.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', userIds);

      const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);

      // Format data for CSV
      const headers = [
        'Date',
        'User Name',
        'User Phone',
        'Amount (UGX)',
        'MoMo Provider',
        'MoMo Number',
        'Status',
        'Transaction ID',
        'Rejection Reason',
        'Processed At'
      ];

      const rows = exportData.map(req => {
        const profile = profileMap.get(req.user_id);
        return [
          format(new Date(req.created_at), 'yyyy-MM-dd HH:mm'),
          profile?.full_name || 'Unknown',
          profile?.phone || '',
          req.amount,
          req.mobile_money_provider?.toUpperCase() || '',
          req.mobile_money_number || '',
          req.status,
          req.transaction_id || '',
          req.rejection_reason || '',
          req.processed_at ? format(new Date(req.processed_at), 'yyyy-MM-dd HH:mm') : ''
        ];
      });

      exportToCSV({ headers, rows }, 'withdrawal_requests');
      toast.success(`Exported ${exportData.length} withdrawal requests`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export data');
    } finally {
      setExporting(false);
    }
  };

  const buildPendingPdfHtml = (data: WithdrawalRequest[]) => {
    const total = data.reduce((sum, r) => sum + r.amount, 0);
    const rows = data.map((req, i) => {
      const name = req.user?.full_name || 'Unknown';
      const phone = req.user?.phone || '-';
      const momoProvider = (req.mobile_money_provider || '-').toUpperCase();
      const momoNumber = req.mobile_money_number || '-';
      const momoName = req.mobile_money_name || '-';
      const amount = formatCurrency(req.amount);
      const date = format(new Date(req.created_at), 'MMM dd, yyyy HH:mm');
      const walletBal = req.wallet_balance !== undefined ? formatCurrency(req.wallet_balance) : '-';
      const timeAgo = formatDistanceToNow(new Date(req.created_at), { addSuffix: true });

      const sourcesHtml = (req.fund_sources || []).length > 0
        ? `<div style="margin-top:4px;font-size:10px;color:#555;">
            ${(req.fund_sources || []).map(s => 
              `<span style="display:inline-block;margin:1px 2px;padding:1px 6px;border-radius:3px;background:#f0f4ff;border:1px solid #c7d2fe;">
                ${s.category}: <strong>${formatCurrency(s.total)}</strong>
              </span>`
            ).join('')}
          </div>`
        : `<div style="margin-top:4px;font-size:10px;color:#999;">No ledger sources found</div>`;

      return `
        <tr style="border-bottom:1px solid #e5e7eb;">
          <td style="padding:8px 6px;text-align:center;font-weight:bold;font-size:12px;">${i + 1}</td>
          <td style="padding:8px 6px;">
            <strong>${name}</strong><br/>
            <span style="color:#666;font-size:11px;">${phone}</span>
          </td>
          <td style="padding:8px 6px;">
            <strong>${momoProvider}</strong> &bull; ${momoNumber}<br/>
            <span style="color:#666;font-size:11px;">Acc Name: ${momoName}</span>
          </td>
          <td style="padding:8px 6px;">
            <div style="font-size:14px;font-weight:bold;">${amount}</div>
            <div style="font-size:10px;color:#666;">Wallet: ${walletBal}</div>
            ${sourcesHtml}
          </td>
          <td style="padding:8px 6px;font-size:11px;color:#555;">${timeAgo}<br/><span style="color:#888;">${date}</span></td>
        </tr>`;
    }).join('');

    return `<!DOCTYPE html><html><head><title>Pending Withdrawals - Welile</title>
      <style>
        body{font-family:Arial,sans-serif;padding:20px;color:#111;font-size:13px;}
        h1{text-align:center;margin:0 0 4px;font-size:22px;}
        .sub{text-align:center;color:#666;margin-bottom:14px;font-size:11px;}
        .summary{display:flex;justify-content:space-around;margin-bottom:16px;padding:10px;background:#f3f4f6;border-radius:8px;}
        .s-item{text-align:center;}
        .s-label{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;}
        .s-value{font-size:20px;font-weight:bold;}
        table{width:100%;border-collapse:collapse;}
        th{background:#1e40af;color:#fff;padding:8px 6px;text-align:left;font-size:11px;}
        tr:nth-child(even){background:#f9fafb;}
        .footer{margin-top:14px;padding:10px 14px;background:#1e40af;color:#fff;border-radius:8px;text-align:right;font-weight:bold;font-size:15px;}
        @media print{body{padding:0;}.no-print{display:none;}}
      </style></head><body>
      <h1>🏦 WELILE — Pending Withdrawal Requests</h1>
      <p class="sub">Generated: ${format(new Date(), 'EEEE, MMM dd yyyy • HH:mm')} &bull; ${data.length} request(s)</p>
      <div class="summary">
        <div class="s-item"><div class="s-label">Total Requests</div><div class="s-value">${data.length}</div></div>
        <div class="s-item"><div class="s-label">Total Amount</div><div class="s-value">${formatCurrency(total)}</div></div>
      </div>
      <table>
        <thead><tr>
          <th style="width:30px;">#</th>
          <th>User</th>
          <th>Mobile Money</th>
          <th>Amount &amp; Source of Funds</th>
          <th>Requested</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="footer">Grand Total: ${formatCurrency(total)}</div>
    </body></html>`;
  };

  const handlePrintPDF = async () => {
    const dataToPrint = activeTab === 'pending' ? requests : historyRequests;
    if (dataToPrint.length === 0) {
      toast.error('No requests to print');
      return;
    }
    setPrinting(true);
    try {
      const printWindow = window.open('', '_blank');
      if (!printWindow) { toast.error('Please allow popups to print'); setPrinting(false); return; }

      if (activeTab === 'pending') {
        printWindow.document.write(buildPendingPdfHtml(dataToPrint));
      } else {
        const total = dataToPrint.reduce((sum, r) => sum + r.amount, 0);
        const rows = dataToPrint.map((req, i) => {
          const name = req.user?.full_name || 'Unknown';
          const phone = req.user?.phone || '-';
          const momoProvider = (req.mobile_money_provider || '-').toUpperCase();
          const momoNumber = req.mobile_money_number || '-';
          const momoName = req.mobile_money_name || '-';
          const amount = formatCurrency(req.amount);
          const status = req.status.charAt(0).toUpperCase() + req.status.slice(1);
          const date = format(new Date(req.created_at), 'MMM dd, yyyy HH:mm');
          const txId = req.transaction_id || '-';
          const rejReason = req.rejection_reason || '-';
          const processedAt = req.processed_at ? format(new Date(req.processed_at), 'MMM dd, yyyy HH:mm') : '-';

          return `
            <tr>
              <td style="text-align:center;font-weight:bold;">${i + 1}</td>
              <td><strong>${name}</strong><br/><span style="color:#666;font-size:11px;">${phone}</span></td>
              <td><strong>${momoProvider}</strong><br/><span style="font-size:12px;">${momoNumber}</span><br/><span style="color:#666;font-size:11px;">Name: ${momoName}</span></td>
              <td style="text-align:right;font-weight:bold;white-space:nowrap;">${amount}</td>
              <td><span style="padding:2px 8px;border-radius:4px;font-size:11px;background:${req.status === 'approved' ? '#dcfce7' : '#fee2e2'};color:${req.status === 'approved' ? '#166534' : '#991b1b'}">${status}</span></td>
              <td style="font-size:11px;">${date}</td>
              <td style="font-size:11px;font-family:monospace;">${txId}</td>
              <td style="font-size:11px;color:#991b1b;">${req.status === 'rejected' ? rejReason : '-'}</td>
              <td style="font-size:11px;">${processedAt}</td>
            </tr>`;
        }).join('');

        printWindow.document.write(`<!DOCTYPE html><html><head><title>Withdrawal History - Welile</title>
          <style>
            body{font-family:Arial,sans-serif;padding:20px;color:#333;font-size:13px;}
            h1{text-align:center;margin-bottom:4px;font-size:20px;}
            .subtitle{text-align:center;color:#666;margin-bottom:16px;font-size:12px;}
            .summary{display:flex;justify-content:space-around;margin-bottom:16px;padding:12px;background:#f3f4f6;border-radius:8px;}
            .summary-item{text-align:center;}
            .summary-label{font-size:11px;color:#666;}
            .summary-value{font-size:18px;font-weight:bold;}
            table{width:100%;border-collapse:collapse;font-size:12px;}
            th{background:#f3f4f6;padding:8px 6px;text-align:left;border-bottom:2px solid #d1d5db;font-weight:600;font-size:11px;}
            td{padding:6px;border-bottom:1px solid #e5e7eb;vertical-align:top;}
            .footer{margin-top:16px;padding:12px;background:#f9fafb;border-radius:8px;text-align:right;font-weight:bold;font-size:14px;}
            @media print{body{padding:0;} .no-print{display:none;}}
          </style></head><body>
          <h1>WELILE — Withdrawal History</h1>
          <p class="subtitle">Generated: ${format(new Date(), 'EEEE, MMM dd yyyy, HH:mm')} &bull; ${dataToPrint.length} request(s)</p>
          <div class="summary">
            <div class="summary-item"><div class="summary-label">Total Requests</div><div class="summary-value">${dataToPrint.length}</div></div>
            <div class="summary-item"><div class="summary-label">Total Amount</div><div class="summary-value">${formatCurrency(total)}</div></div>
          </div>
          <table><thead><tr>
            <th>#</th><th>User</th><th>Mobile Money Details</th>
            <th style="text-align:right">Amount</th><th>Status</th>
            <th>Requested</th><th>Transaction ID</th><th>Reason</th><th>Processed</th>
          </tr></thead>
          <tbody>${rows}</tbody></table>
          <div class="footer">Grand Total: ${formatCurrency(total)}</div>
          <script>window.onload=function(){window.print();}</script>
        </body></html>`);
      }
      printWindow.document.close();
      if (activeTab === 'pending') {
        printWindow.onload = () => { printWindow.print(); };
      }

      toast.success('Print window opened');
    } catch (err) {
      console.error('Print failed:', err);
      toast.error('Failed to generate print view');
    } finally {
      setPrinting(false);
    }
  };

  const handleSharePDF = async () => {
    if (requests.length === 0) {
      toast.error('No pending requests to share');
      return;
    }
    setSharing(true);
    try {
      const html = buildPendingPdfHtml(requests);
      const blob = new Blob([html], { type: 'text/html' });

      // Try Web Share API first (mobile)
      if (navigator.share && navigator.canShare) {
        const file = new File([blob], `pending_withdrawals_${format(new Date(), 'yyyy-MM-dd')}.html`, { type: 'text/html' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ title: 'Pending Withdrawal Requests', files: [file] });
          toast.success('Shared successfully');
          setSharing(false);
          return;
        }
      }

      // Fallback: open in new window and prompt print/save
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      if (win) {
        win.onload = () => { win.print(); };
        toast.success('PDF opened — use Print → Save as PDF to share');
      } else {
        // Last resort: download the file
        const link = document.createElement('a');
        link.href = url;
        link.download = `pending_withdrawals_${format(new Date(), 'yyyy-MM-dd')}.html`;
        link.click();
        toast.success('Report downloaded');
      }
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('Share failed:', err);
        toast.error('Failed to share');
      }
    } finally {
      setSharing(false);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      minimumFractionDigits: 0,
    }).format(value);
  };

  const fetchRequests = useCallback(async () => {
    try {
      // Fetch pending withdrawal requests with limit (bounded query for scale)
      const filters: any = { status: 'pending' };
      if (subCategoryFilter && subCategoryFilter !== 'all') {
        filters.sub_category = subCategoryFilter;
      }

      const { data: requestsData, error } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .match(filters)
        .gt('amount', 500)
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;

      if (requestsData && requestsData.length > 0) {
        const userIds = [...new Set(requestsData.map(r => r.user_id))];

        // Fetch user profiles, wallet balances (via shared ops layer → single
        // batched RPC, request-deduped across the app), and fund sources.
        const [profilesRes, walletBuckets, ledgerRes] = await Promise.all([
          supabase.from('profiles').select('id, full_name, phone, avatar_url').in('id', userIds),
          trackOpsQuery('withdrawal-requests', 'wallet-buckets', () => fetchOpsWalletBuckets(userIds)),
          supabase.from('general_ledger')
            .select('user_id, category, amount, direction')
            .in('user_id', userIds)
            .eq('direction', 'in'),
        ]);

        const profileMap = new Map(profilesRes.data?.map(p => [p.id, p]) || []);
        const walletMap = new Map(walletBuckets.map(w => [w.user_id, w.balance]));

        // Build fund sources per user from ledger
        const fundSourcesMap = new Map<string, FundSource[]>();
        for (const entry of (ledgerRes.data || [])) {
          const existing = fundSourcesMap.get(entry.user_id) || [];
          const cat = existing.find(c => c.category === entry.category);
          if (cat) {
            cat.total += Number(entry.amount);
          } else {
            existing.push({ category: entry.category, total: Number(entry.amount) });
          }
          fundSourcesMap.set(entry.user_id, existing);
        }

        const enrichedRequests = requestsData.map(r => ({
          ...r,
          user: profileMap.get(r.user_id) || { full_name: 'Unknown', phone: '', avatar_url: null },
          wallet_balance: walletMap.get(r.user_id) || 0,
          fund_sources: (fundSourcesMap.get(r.user_id) || []).sort((a, b) => b.total - a.total),
        }));

        setRequests(enrichedRequests as unknown as WithdrawalRequest[]);
      } else {
        setRequests([]);
      }
    } catch (error) {
      console.error('Error fetching withdrawal requests:', error);
      toast.error('Failed to load withdrawal requests');
    } finally {
      setLoading(false);
    }
  }, [subCategoryFilter]);

  // Fetch history with filters
  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const historyFilters: any = {};
      if (subCategoryFilter && subCategoryFilter !== 'all') {
        historyFilters.sub_category = subCategoryFilter;
      }

      // Scope ALL terminal/settled states — `completed` is the dominant status
      // in production and was previously invisible here.
      const HISTORY_STATUSES = [
        'completed', 'approved', 'rejected', 'expired', 'cancelled',
        'failed', 'processing', 're_approved_for_recovery',
      ];

      let query = supabase
        .from('withdrawal_requests')
        .select('*')
        .match(historyFilters)
        .order('created_at', { ascending: false })
        .limit(searchTerm ? 200 : 100);

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      } else {
        query = query.in('status', HISTORY_STATUSES);
      }

      // Due-diligence search: destination numbers/accounts, references and the
      // requester's name/phone. Matching users first so name searches work.
      if (searchTerm) {
        const escaped = searchTerm.replace(/[%,()]/g, ' ').trim();
        const digits = escaped.replace(/\D/g, '');
        const { data: matchedUsers } = await supabase
          .from('profiles')
          .select('id')
          .or(`full_name.ilike.%${escaped}%,phone.ilike.%${escaped}%`)
          .limit(50);
        const userIdList = (matchedUsers || []).map(u => u.id);

        const orParts = [
          `mobile_money_number.ilike.%${escaped}%`,
          `mobile_money_name.ilike.%${escaped}%`,
          `bank_account_number.ilike.%${escaped}%`,
          `bank_account_name.ilike.%${escaped}%`,
          `bank_name.ilike.%${escaped}%`,
          `transaction_id.ilike.%${escaped}%`,
          `payout_code.ilike.%${escaped}%`,
          `fin_ops_reference.ilike.%${escaped}%`,
        ];
        if (digits.length >= 6) orParts.push(`mobile_money_number.ilike.%${digits}%`);
        if (/^[0-9a-f-]{8,}$/i.test(escaped)) orParts.push(`id.eq.${escaped}`);
        if (userIdList.length) orParts.push(`user_id.in.(${userIdList.join(',')})`);

        query = query.or(orParts.join(','));
      }

      // Apply date filters
      if (dateRange.from) {
        query = query.gte('created_at', dateRange.from.toISOString());
      }
      if (dateRange.to) {
        const endOfDay = new Date(dateRange.to);
        endOfDay.setHours(23, 59, 59, 999);
        query = query.lte('created_at', endOfDay.toISOString());
      }

      const { data: historyData, error } = await query;

      if (error) throw error;

      if (historyData && historyData.length > 0) {
        const userIds = [...new Set(historyData.map(r => r.user_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone, avatar_url')
          .in('id', userIds);

        const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);

        const enrichedHistory = historyData.map(r => ({
          ...r,
          user: profileMap.get(r.user_id) || { full_name: 'Unknown', phone: '', avatar_url: null }
        }));

        setHistoryRequests(enrichedHistory);
      } else {
        setHistoryRequests([]);
      }
    } catch (error) {
      console.error('Error fetching history:', error);
      toast.error('Failed to load withdrawal history');
    } finally {
      setHistoryLoading(false);
    }
  }, [statusFilter, dateRange, subCategoryFilter, searchTerm]);

  // Apply date presets
  const applyDatePreset = (preset: typeof datePreset) => {
    setDatePreset(preset);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    switch (preset) {
      case 'today':
        setDateRange({ from: today, to: today });
        break;
      case '7days':
        const sevenDaysAgo = new Date(today);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        setDateRange({ from: sevenDaysAgo, to: today });
        break;
      case '30days':
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        setDateRange({ from: thirtyDaysAgo, to: today });
        break;
      case 'all':
        setDateRange({ from: undefined, to: undefined });
        break;
      case 'custom':
        // Keep current range for custom
        break;
    }
  };

  // Fetch history when tab changes or filters change
  useEffect(() => {
    if (activeTab === 'history') {
      fetchHistory();
    }
  }, [activeTab, fetchHistory]);

  useEffect(() => {
    fetchRequests();
    // Manual refresh only — no polling. Managers use the Refresh button.
  }, [fetchRequests]);

  const handleApproveClick = async (request: WithdrawalRequest) => {
    // Balance was already deducted when the request was created (via trigger),
    // so no need to check balance again — just proceed to approval
    setSelectedRequest(request);
    setTransactionId('');
    setApproveDialogOpen(true);
  };

  const handleApprove = async () => {
    if (!user || !selectedRequest) return;

    setProcessing(selectedRequest.id);
    try {
      // Manager approval — advance status so it leaves the pending queue permanently
      const { error: requestError, count } = await supabase
        .from('withdrawal_requests')
        .update({
          status: 'manager_approved',
          manager_approved_at: new Date().toISOString(),
          manager_approved_by: user.id,
          updated_at: new Date().toISOString(),
        } as any)
        .eq('id', selectedRequest.id)
        .eq('status', 'pending');

      if (requestError) throw requestError;

      toast.success('Withdrawal approved — forwarded to Financial Ops');
      setRequests(prev => prev.filter(r => r.id !== selectedRequest.id));
      setApproveDialogOpen(false);
      setTransactionId('');
      setSelectedRequest(null);
    } catch (error: any) {
      console.error('Error processing withdrawal:', error);
      toast.error(error.message || 'Failed to process withdrawal');
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async () => {
    if (!user || !selectedRequest) return;

    if (!rejectionReason.trim()) {
      toast.error('Please provide a rejection reason');
      return;
    }

    setProcessing(selectedRequest.id);
    try {
      // Update request status
      const { error } = await supabase
        .from('withdrawal_requests')
        .update({
          status: 'rejected',
          processed_by: user.id,
          processed_at: new Date().toISOString(),
          rejection_reason: rejectionReason
        })
        .eq('id', selectedRequest.id);

      if (error) throw error;

      // Notification removed - table dropped

      toast.success('Withdrawal rejected');
      setRequests(prev => prev.filter(r => r.id !== selectedRequest.id));
      setRejectDialogOpen(false);
      setRejectionReason('');
      setSelectedRequest(null);
    } catch (error: any) {
      console.error('Error rejecting withdrawal:', error);
      toast.error(error.message || 'Failed to reject withdrawal');
    } finally {
      setProcessing(null);
    }
  };

  // Batch reject handler
  const handleBatchReject = async () => {
    if (!user || selectedIds.size === 0 || !rejectionReason.trim()) {
      toast.error('Please select requests and provide a rejection reason');
      return;
    }

    setBatchProcessing(true);
    setBatchProgress(0);
    
    const selectedRequests = requests.filter(r => selectedIds.has(r.id));
    const total = selectedRequests.length;
    let processed = 0;
    let failed = 0;

    for (const request of selectedRequests) {
      try {
        // Update request status
        const { error } = await supabase
          .from('withdrawal_requests')
          .update({
            status: 'rejected',
            processed_by: user.id,
            processed_at: new Date().toISOString(),
            rejection_reason: rejectionReason
          })
          .eq('id', request.id);

        if (error) throw error;

        // Notification removed - table dropped

        processed++;
      } catch (error) {
        console.error('Error rejecting request:', request.id, error);
        failed++;
      }
      
      setBatchProgress(Math.round(((processed + failed) / total) * 100));
    }

    setBatchProcessing(false);
    setBatchRejectDialogOpen(false);
    setRejectionReason('');
    const rejectedIds = new Set(selectedRequests.map(r => r.id));
    setRequests(prev => prev.filter(r => !rejectedIds.has(r.id)));
    clearSelection();

    if (failed === 0) {
      toast.success(`Successfully rejected ${processed} request${processed > 1 ? 's' : ''}`);
    } else {
      toast.warning(`Rejected ${processed} request${processed > 1 ? 's' : ''}, ${failed} failed`);
    }
  };

  const pendingCount = requests.length;

  return (
    <>
      <Card className="overflow-hidden border-warning/30">
        <CardHeader className="bg-gradient-to-r from-warning/10 to-warning/5 pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <ArrowDownToLine className="h-5 w-5 text-warning" />
              Withdrawals
              {pendingCount > 0 && (
                <Badge variant="destructive" className="ml-2 animate-pulse">
                  {pendingCount} pending
                </Badge>
              )}
            </CardTitle>
            <div className="flex items-center gap-1">
              {activeTab === 'pending' && (
                <Button 
                  variant="ghost" 
                  size="icon"
                  onClick={handleSharePDF}
                  disabled={sharing || requests.length === 0}
                  title="Share PDF (includes fund sources)"
                >
                  {sharing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Share2 className="h-4 w-4" />
                  )}
                </Button>
              )}
              <Button 
                variant="ghost" 
                size="icon"
                onClick={handleExportCSV}
                disabled={exporting}
                title="Export to CSV"
              >
                {exporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
              </Button>
              <Button 
                variant="ghost" 
                size="icon"
                onClick={handlePrintPDF}
                disabled={printing}
                title="Print as PDF"
              >
                {printing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Printer className="h-4 w-4" />
                )}
              </Button>
              <Button 
                variant="ghost" 
                size="icon"
                onClick={() => activeTab === 'pending' ? fetchRequests() : fetchHistory()}
                disabled={loading || historyLoading}
              >
                <RefreshCw className={`h-4 w-4 ${(loading || historyLoading) ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'pending' | 'history')} className="w-full">
          <div className="px-4 pt-2">
            <TabsList className="grid w-full grid-cols-2 h-9">
              <TabsTrigger value="pending" className="gap-1.5 text-xs">
                <Clock className="h-3.5 w-3.5" />
                Pending
                {pendingCount > 0 && (
                  <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
                    {pendingCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="history" className="gap-1.5 text-xs">
                <History className="h-3.5 w-3.5" />
                History
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Pending Tab */}
          <TabsContent value="pending" className="mt-0">
            {/* Batch Actions Bar */}
            {requests.length > 0 && (
              <div className="px-4 py-2 border-b bg-muted/30 flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-3">
                  <button
                    onClick={selectAll}
                    className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {selectedIds.size === 0 ? (
                      <Square className="h-4 w-4" />
                    ) : selectedIds.size === requests.length ? (
                      <CheckSquare className="h-4 w-4 text-primary" />
                    ) : (
                      <div className="relative">
                        <Square className="h-4 w-4" />
                        <Minus className="h-2.5 w-2.5 absolute top-0.5 left-0.5 text-primary" />
                      </div>
                    )}
                    <span className="text-xs">
                      {selectedIds.size === 0 
                        ? 'Select all' 
                        : `${selectedIds.size} selected`}
                    </span>
                  </button>
                  {selectedIds.size > 0 && (
                    <button
                      onClick={clearSelection}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Clear
                    </button>
                  )}
                </div>
                
                {selectedIds.size > 0 && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="gap-1.5 h-8"
                    onClick={() => setBatchRejectDialogOpen(true)}
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Reject {selectedIds.size} Request{selectedIds.size > 1 ? 's' : ''}
                  </Button>
                )}
              </div>
            )}

            <CardContent className="p-0">
              {loading ? (
                <div className="p-8 text-center">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                </div>
              ) : requests.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <CheckCircle className="h-12 w-12 mx-auto mb-3 text-success/50" />
                  <p className="font-medium">No pending requests</p>
                  <p className="text-sm">All withdrawal requests have been processed</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  <AnimatePresence>
                    {requests.map((request) => (
                      <motion.div
                        key={request.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: -100 }}
                        className={`p-4 hover:bg-muted/30 transition-colors ${
                          selectedIds.has(request.id) ? 'bg-primary/5' : ''
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          {/* Checkbox */}
                          <div className="pt-1">
                            <Checkbox
                              checked={selectedIds.has(request.id)}
                              onCheckedChange={() => toggleSelection(request.id)}
                              className="h-5 w-5"
                            />
                          </div>
                          <UserAvatar 
                            avatarUrl={request.user?.avatar_url} 
                            fullName={request.user?.full_name} 
                            size="md" 
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <button
                                onClick={() => openUserDetail(request.user_id)}
                                className="font-semibold truncate hover:text-primary hover:underline flex items-center gap-1 transition-colors"
                              >
                                {request.user?.full_name}
                                <ExternalLink className="h-3 w-3 opacity-50" />
                              </button>
                              <Badge variant="outline" className="gap-1 text-xs">
                                <Clock className="h-3 w-3" />
                                {formatDistanceToNow(new Date(request.created_at), { addSuffix: true })}
                              </Badge>
                              {request.sub_category && request.sub_category !== 'general' && (
                                <Badge 
                                  variant="outline" 
                                  className={`gap-1 text-xs ${SUB_CATEGORY_LABELS[request.sub_category]?.color || 'bg-muted text-muted-foreground'}`}
                                >
                                  {SUB_CATEGORY_LABELS[request.sub_category]?.icon && (
                                    <span className="h-3 w-3 flex items-center justify-center">
                                      {(() => {
                                        const Icon = SUB_CATEGORY_LABELS[request.sub_category].icon;
                                        return <Icon className="h-3 w-3" />;
                                      })()}
                                    </span>
                                  )}
                                  {SUB_CATEGORY_LABELS[request.sub_category]?.label || request.sub_category}
                                </Badge>
                              )}
                            </div>
                            
                            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                              <Phone className="h-3 w-3" />
                              <span>{request.user?.phone || 'No phone'}</span>
                            </div>

                            {/* Mobile Money Number - Highlighted for easy payout */}
                            {request.mobile_money_number && (
                              <div className={`mt-2 p-2.5 rounded-lg border-2 ${
                                request.mobile_money_provider === 'mtn' 
                                  ? 'bg-yellow-500/10 border-yellow-500/30' 
                                  : 'bg-red-500/10 border-red-500/30'
                              }`}>
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2">
                                    <div className={`p-1.5 rounded-full ${
                                      request.mobile_money_provider === 'mtn' 
                                        ? 'bg-yellow-500' 
                                        : 'bg-red-500'
                                    }`}>
                                      <Smartphone className={`h-3.5 w-3.5 ${
                                        request.mobile_money_provider === 'mtn' 
                                          ? 'text-black' 
                                          : 'text-white'
                                      }`} />
                                    </div>
                                    <div>
                                      <p className="text-xs font-medium text-muted-foreground uppercase">
                                        {request.mobile_money_provider || 'MoMo'} Payout
                                      </p>
                                      <p className="font-bold text-base tracking-wide">
                                        {request.mobile_money_number}
                                      </p>
                                      {request.mobile_money_name && (
                                        <p className="text-xs font-medium text-muted-foreground mt-0.5">
                                          Registered: <span className="font-semibold text-foreground">{request.mobile_money_name}</span>
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0"
                                    onClick={() => copyToClipboard(request.mobile_money_number || '', request.id)}
                                  >
                                    {copiedId === request.id ? (
                                      <Check className="h-4 w-4 text-success" />
                                    ) : (
                                      <Copy className="h-4 w-4" />
                                    )}
                                  </Button>
                                </div>
                              </div>
                            )}

                            {!request.mobile_money_number && (
                              <div className="mt-2 p-2 rounded-lg bg-muted/50 border border-border">
                                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                                  <AlertCircle className="h-3.5 w-3.5" />
                                  No mobile money number provided - use account phone
                                </p>
                              </div>
                            )}

                            <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
                              <div>
                                <p className="text-2xl font-bold text-primary">
                                  {formatCurrency(request.amount)}
                                </p>
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <Wallet className="h-3 w-3" />
                                  <span>Balance:</span>
                                  <span className={`font-mono font-semibold ${
                                    (request.wallet_balance || 0) >= request.amount 
                                      ? 'text-success' 
                                      : 'text-destructive'
                                  }`}>
                                    {formatCurrency(request.wallet_balance || 0)}
                                  </span>
                                  {(request.wallet_balance || 0) < request.amount && (
                                    <span className="text-destructive font-bold text-sm" title="Withdrawal exceeds wallet balance">
                                      🚩
                                    </span>
                                  )}
                                  <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/70">
                                    <span className="relative flex h-1.5 w-1.5">
                                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success"></span>
                                    </span>
                                    live
                                  </span>
                                </div>
                              </div>

                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setSelectedRequest(request);
                                    setRejectDialogOpen(true);
                                  }}
                                  disabled={processing === request.id}
                                  className="gap-1 border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                                >
                                  <XCircle className="h-4 w-4" />
                                  Reject
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => handleApproveClick(request)}
                                  disabled={processing === request.id}
                                  className="gap-1"
                                >
                                  {processing === request.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <CheckCircle className="h-4 w-4" />
                                  )}
                                  Approve
                                </Button>
                              </div>
                            </div>

                            {request.wallet_balance !== undefined && request.amount > request.wallet_balance && (
                              <div className="flex items-center gap-2 mt-2 p-2 bg-destructive/10 rounded-lg text-destructive text-sm">
                                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                                <span>Insufficient balance for this withdrawal</span>
                              </div>
                            )}

                            {/* Fund Sources */}
                            {(request.fund_sources || []).length > 0 && (
                              <div className="mt-2 p-2 rounded-lg bg-muted/40 border border-border/50">
                                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                                  Source of Funds
                                </p>
                                <div className="flex flex-wrap gap-1">
                                  {(request.fund_sources || []).map((source) => (
                                    <Badge
                                      key={source.category}
                                      variant="secondary"
                                      className="text-[10px] font-medium gap-1"
                                    >
                                      {source.category}: <span className="font-bold">{formatCurrency(source.total)}</span>
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </CardContent>
          </TabsContent>

          {/* History Tab */}
          <TabsContent value="history" className="mt-0">
            {/* Filters */}
            <div className="px-4 py-3 border-b bg-muted/30 space-y-3">
              {/* Due-diligence search */}
              <div className="flex items-center gap-2">
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search number, account, name, transaction ID or record ID"
                  className="h-9 text-xs"
                />
                {searchInput && (
                  <Button variant="ghost" size="sm" className="h-9 text-xs" onClick={() => setSearchInput('')}>
                    Clear
                  </Button>
                )}
              </div>
              {searchTerm && (
                <p className="text-[11px] text-muted-foreground">
                  Searching all withdrawal records for “{searchTerm}” — destination numbers, bank accounts, references and requester name/phone.
                </p>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <Filter className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium text-muted-foreground">Filters:</span>
              </div>
              
              <div className="flex flex-wrap gap-2">
                {/* Status Filter */}
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v)}>
                  <SelectTrigger className="w-[160px] h-8 text-xs">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="processing">Processing</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                    <SelectItem value="expired">Expired</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                    <SelectItem value="re_approved_for_recovery">Re-approved for recovery</SelectItem>
                  </SelectContent>
                </Select>

                {/* Sub-Category Filter */}
                <Select value={subCategoryFilter} onValueChange={(v) => setSubCategoryFilter(v)}>
                  <SelectTrigger className="w-[140px] h-8 text-xs">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    <SelectItem value="repair">🔧 Repair</SelectItem>
                    <SelectItem value="rent">🏠 Rent</SelectItem>
                    <SelectItem value="commission">💰 Commission</SelectItem>
                    <SelectItem value="investment">📈 Investment</SelectItem>
                    <SelectItem value="roi">📊 ROI</SelectItem>
                    <SelectItem value="general">📋 General</SelectItem>
                  </SelectContent>
                </Select>

                {/* Date Presets */}
                <div className="flex gap-1">
                  {[
                    { value: 'all', label: 'All Time' },
                    { value: 'today', label: 'Today' },
                    { value: '7days', label: '7 Days' },
                    { value: '30days', label: '30 Days' },
                  ].map((preset) => (
                    <Button
                      key={preset.value}
                      variant={datePreset === preset.value ? 'default' : 'outline'}
                      size="sm"
                      className="h-8 text-xs px-2.5"
                      onClick={() => applyDatePreset(preset.value as typeof datePreset)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>

                {/* Custom Date Range */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={datePreset === 'custom' ? 'default' : 'outline'}
                      size="sm"
                      className="h-8 text-xs gap-1.5"
                    >
                      <Calendar className="h-3.5 w-3.5" />
                      Custom
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarComponent
                      mode="range"
                      selected={{ from: dateRange.from, to: dateRange.to }}
                      onSelect={(range) => {
                        setDateRange({ from: range?.from, to: range?.to });
                        setDatePreset('custom');
                      }}
                      numberOfMonths={1}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {/* Active filters display */}
              {(statusFilter !== 'all' || dateRange.from || dateRange.to || subCategoryFilter !== 'all') && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground">Active:</span>
                  {statusFilter !== 'all' && (
                    <Badge variant="secondary" className="text-xs gap-1">
                      <span className="capitalize">{statusFilter.replace(/_/g, ' ')}</span>
                      <button onClick={() => setStatusFilter('all')} className="ml-1 hover:text-destructive">×</button>
                    </Badge>
                  )}
                  {subCategoryFilter !== 'all' && (
                    <Badge variant="secondary" className="text-xs gap-1">
                      {SUB_CATEGORY_LABELS[subCategoryFilter]?.label || subCategoryFilter}
                      <button onClick={() => setSubCategoryFilter('all')} className="ml-1 hover:text-destructive">×</button>
                    </Badge>
                  )}
                  {dateRange.from && (
                    <Badge variant="secondary" className="text-xs gap-1">
                      📅 {format(dateRange.from, 'MMM d')} - {dateRange.to ? format(dateRange.to, 'MMM d') : 'now'}
                      <button onClick={() => { setDateRange({ from: undefined, to: undefined }); setDatePreset('all'); }} className="ml-1 hover:text-destructive">×</button>
                    </Badge>
                  )}
                </div>
              )}
            </div>

            {/* Summary Statistics */}
            {!historyLoading && historyRequests.length > 0 && (
              <div className="px-4 py-3 border-b">
                <div className="grid grid-cols-2 gap-3">
                  {/* Settled (completed + approved) */}
                  <div className="p-3 rounded-xl bg-success/10 border border-success/20">
                    <div className="flex items-center gap-2 mb-1">
                      <CheckCircle className="h-4 w-4 text-success" />
                      <span className="text-xs font-medium text-success">Completed / approved</span>
                    </div>
                    <p className="text-lg font-bold text-success">
                      {formatCurrency(
                        historyRequests
                          .filter(r => r.status === 'approved' || r.status === 'completed')
                          .reduce((sum, r) => sum + r.amount, 0)
                      )}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {historyRequests.filter(r => r.status === 'approved' || r.status === 'completed').length} request(s)
                    </p>
                  </div>

                  {/* Rejected / failed / expired / cancelled */}
                  <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20">
                    <div className="flex items-center gap-2 mb-1">
                      <XCircle className="h-4 w-4 text-destructive" />
                      <span className="text-xs font-medium text-destructive">Rejected / failed / expired</span>
                    </div>
                    <p className="text-lg font-bold text-destructive">
                      {formatCurrency(
                        historyRequests
                          .filter(r => ['rejected', 'failed', 'expired', 'cancelled'].includes(r.status))
                          .reduce((sum, r) => sum + r.amount, 0)
                      )}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {historyRequests.filter(r => ['rejected', 'failed', 'expired', 'cancelled'].includes(r.status)).length} request(s)
                    </p>
                  </div>
                </div>

                {/* Total Summary */}
                <div className="mt-3 p-2 rounded-lg bg-muted/50 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Total processed</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-medium">
                      {historyRequests.length} request{historyRequests.length !== 1 ? 's' : ''}
                    </span>
                    <span className="text-sm font-bold">
                      {formatCurrency(historyRequests.reduce((sum, r) => sum + r.amount, 0))}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <CardContent className="p-0">
              {historyLoading ? (
                <div className="p-8 text-center">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                </div>
              ) : historyRequests.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <History className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p className="font-medium">No history found</p>
                  <p className="text-sm">Try adjusting your filters</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {historyRequests.map((request) => (
                    <motion.div
                      key={request.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="p-4 hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <UserAvatar 
                          avatarUrl={request.user?.avatar_url} 
                          fullName={request.user?.full_name} 
                          size="md" 
                        />
                          <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              onClick={() => openUserDetail(request.user_id)}
                              className="font-semibold truncate hover:text-primary hover:underline flex items-center gap-1 transition-colors"
                            >
                              {request.user?.full_name}
                              <ExternalLink className="h-3 w-3 opacity-50" />
                            </button>
                            <Badge 
                              variant={['approved', 'completed'].includes(request.status) ? 'default' : ['rejected', 'failed'].includes(request.status) ? 'destructive' : 'secondary'}
                              className="gap-1 text-xs"
                            >
                              {['approved', 'completed'].includes(request.status) ? (
                                <><CheckCircle className="h-3 w-3" /> <span className="capitalize">{request.status}</span></>
                              ) : (
                                <><XCircle className="h-3 w-3" /> <span className="capitalize">{request.status.replace(/_/g, ' ')}</span></>
                              )}
                            </Badge>
                            {request.sub_category && request.sub_category !== 'general' && (
                              <Badge 
                                variant="outline" 
                                className={`gap-1 text-xs ${SUB_CATEGORY_LABELS[request.sub_category]?.color || 'bg-muted text-muted-foreground'}`}
                              >
                                {SUB_CATEGORY_LABELS[request.sub_category]?.icon && (
                                  <span className="h-3 w-3 flex items-center justify-center">
                                    {(() => {
                                      const Icon = SUB_CATEGORY_LABELS[request.sub_category].icon;
                                      return <Icon className="h-3 w-3" />;
                                    })()}
                                  </span>
                                )}
                                {SUB_CATEGORY_LABELS[request.sub_category]?.label || request.sub_category}
                              </Badge>
                            )}
                          </div>
                          
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {format(new Date(request.created_at), 'MMM d, yyyy h:mm a')}
                            </span>
                            {request.mobile_money_number && (
                              <span className="flex items-center gap-1">
                                <Smartphone className="h-3 w-3" />
                                <span className="uppercase">{request.mobile_money_provider}</span> {request.mobile_money_number}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center justify-between mt-2">
                            <p className={`text-xl font-bold ${['approved', 'completed'].includes(request.status) ? 'text-success' : 'text-destructive'}`}>
                              {formatCurrency(request.amount)}
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => { setDetailId(request.id); setDetailOpen(true); }}
                            >
                              View full record
                            </Button>
                          </div>

                          {/* Settled: Show transaction ID and processed time */}
                          {['approved', 'completed'].includes(request.status) && request.transaction_id && (
                            <div className="mt-2 p-2 rounded-lg bg-success/10 border border-success/20 space-y-1">
                              <div className="flex items-center gap-2 text-xs text-success">
                                <CheckCircle className="h-3 w-3" />
                                <span className="font-medium">Transaction ID:</span>
                                <span className="font-mono font-bold">{request.transaction_id}</span>
                              </div>
                              {request.processed_at && (
                                <p className="text-xs text-muted-foreground">
                                  Processed: {format(new Date(request.processed_at), 'MMM d, yyyy • h:mm:ss a')}
                                </p>
                              )}
                            </div>
                          )}

                          {request.rejection_reason && (
                            <div className="mt-2 p-2 rounded-lg bg-destructive/10 border border-destructive/20">
                              <p className="text-xs text-destructive">
                                <strong>Rejection reason:</strong> {request.rejection_reason}
                              </p>
                              {request.processed_at && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  Rejected: {format(new Date(request.processed_at), 'MMM d, yyyy • h:mm:ss a')}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </CardContent>
          </TabsContent>
        </Tabs>
      </Card>

      {/* Rejection Dialog with Quick Reject Options */}
      <AlertDialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <AlertDialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              Reject Withdrawal Request
            </AlertDialogTitle>
            <AlertDialogDescription>
              Rejecting withdrawal of{' '}
              <strong className="text-foreground">{formatCurrency(selectedRequest?.amount || 0)}</strong> from{' '}
              <strong className="text-foreground">{selectedRequest?.user?.full_name}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="py-4 space-y-4">
            {/* Quick Reject Options */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">Quick Reject Reasons</label>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'Insufficient balance', icon: '💰' },
                  { label: 'Invalid mobile number', icon: '📱' },
                  { label: 'Number not registered', icon: '❌' },
                  { label: 'Duplicate request', icon: '🔄' },
                  { label: 'Suspicious activity', icon: '⚠️' },
                  { label: 'Try again later', icon: '⏰' },
                ].map((reason) => (
                  <Button
                    key={reason.label}
                    type="button"
                    variant={rejectionReason === reason.label ? 'default' : 'outline'}
                    size="sm"
                    className="gap-1.5 h-8 text-xs"
                    onClick={() => setRejectionReason(reason.label)}
                  >
                    <span>{reason.icon}</span>
                    {reason.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Custom Reason Input */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">
                Or enter custom reason
              </label>
              <Textarea
                placeholder="Enter rejection reason..."
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                className="min-h-[80px] resize-none"
              />
            </div>
          </div>
          
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel onClick={() => {
              setRejectionReason('');
              setSelectedRequest(null);
            }}>
              ← Back
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReject}
              disabled={!rejectionReason.trim() || processing === selectedRequest?.id}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {processing === selectedRequest?.id ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <XCircle className="h-4 w-4 mr-2" />
              )}
              Reject Request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Batch Rejection Dialog */}
      <AlertDialog open={batchRejectDialogOpen} onOpenChange={setBatchRejectDialogOpen}>
        <AlertDialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              Batch Reject Requests
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are about to reject <strong className="text-foreground">{selectedIds.size}</strong> withdrawal request{selectedIds.size > 1 ? 's' : ''} totaling{' '}
              <strong className="text-foreground">
                {formatCurrency(
                  requests
                    .filter(r => selectedIds.has(r.id))
                    .reduce((sum, r) => sum + r.amount, 0)
                )}
              </strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="py-4 space-y-4">
            {/* Selected requests summary */}
            <div className="max-h-32 overflow-y-auto space-y-1 p-2 bg-muted/50 rounded-lg">
              {requests.filter(r => selectedIds.has(r.id)).map(request => (
                <div key={request.id} className="flex items-center justify-between text-sm">
                  <span className="truncate">{request.user?.full_name}</span>
                  <span className="font-mono text-muted-foreground">{formatCurrency(request.amount)}</span>
                </div>
              ))}
            </div>

            {/* Quick Reject Options */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">Select Rejection Reason</label>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'Insufficient balance', icon: '💰' },
                  { label: 'Invalid mobile number', icon: '📱' },
                  { label: 'Number not registered', icon: '❌' },
                  { label: 'Duplicate request', icon: '🔄' },
                  { label: 'Suspicious activity', icon: '⚠️' },
                  { label: 'Try again later', icon: '⏰' },
                ].map((reason) => (
                  <Button
                    key={reason.label}
                    type="button"
                    variant={rejectionReason === reason.label ? 'default' : 'outline'}
                    size="sm"
                    className="gap-1.5 h-8 text-xs"
                    onClick={() => setRejectionReason(reason.label)}
                    disabled={batchProcessing}
                  >
                    <span>{reason.icon}</span>
                    {reason.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Custom Reason Input */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">
                Or enter custom reason
              </label>
              <Textarea
                placeholder="Enter rejection reason..."
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                className="min-h-[60px] resize-none"
                disabled={batchProcessing}
              />
            </div>

            {/* Progress bar when processing */}
            {batchProcessing && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Processing...</span>
                  <span className="font-mono">{batchProgress}%</span>
                </div>
                <Progress value={batchProgress} className="h-2" />
              </div>
            )}
          </div>
          
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel 
              onClick={() => {
                setRejectionReason('');
              }}
              disabled={batchProcessing}
            >
              ← Back
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBatchReject}
              disabled={!rejectionReason.trim() || batchProcessing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {batchProcessing ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <XCircle className="h-4 w-4 mr-2" />
              )}
              Reject {selectedIds.size} Request{selectedIds.size > 1 ? 's' : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Approval Dialog — Manager forwards to CFO */}
      <AlertDialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <AlertDialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-success" />
              Withdrawal Request
            </AlertDialogTitle>
            <AlertDialogDescription>
              This withdrawal request is pending CFO approval. You can view details below.
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="py-4 space-y-4">
            {/* User Info */}
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
              <UserAvatar 
                avatarUrl={selectedRequest?.user?.avatar_url} 
                fullName={selectedRequest?.user?.full_name} 
                size="md" 
              />
              <div>
                <p className="font-semibold">{selectedRequest?.user?.full_name}</p>
                <p className="text-sm text-muted-foreground">{selectedRequest?.user?.phone}</p>
              </div>
            </div>

            {/* Amount */}
            <div className="border rounded-xl overflow-hidden">
              <div className="bg-muted/30 px-4 py-2 border-b">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Withdrawal Details</p>
              </div>
              <div className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Amount</span>
                  <span className="font-mono font-bold text-lg">
                    {formatCurrency(selectedRequest?.amount || 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Wallet Balance</span>
                  <span className="font-mono font-bold">
                    {formatCurrency(selectedRequest?.wallet_balance || 0)}
                  </span>
                </div>
              </div>
            </div>

            {/* Mobile Money Details */}
            {selectedRequest?.mobile_money_number && (
              <div className={`p-3 rounded-lg border-2 ${
                selectedRequest?.mobile_money_provider === 'mtn' 
                  ? 'bg-yellow-500/10 border-yellow-500/30' 
                  : 'bg-red-500/10 border-red-500/30'
              }`}>
                <div className="flex items-center gap-2">
                  <Smartphone className={`h-4 w-4 ${
                    selectedRequest?.mobile_money_provider === 'mtn' ? 'text-yellow-600' : 'text-red-500'
                  }`} />
                  <span className="text-sm font-medium uppercase">{selectedRequest?.mobile_money_provider}</span>
                  <span className="font-mono font-bold">{selectedRequest?.mobile_money_number}</span>
                </div>
              </div>
            )}

            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
              <p className="text-xs text-blue-700 dark:text-blue-400 font-medium">
                ℹ️ This request goes directly to the CFO for approval and payment. No manager action needed.
              </p>
            </div>

            {/* Transaction ID */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Transaction ID (required)</label>
              <Input
                placeholder="Enter Transaction ID"
                value={transactionId}
                onChange={(e) => setTransactionId(e.target.value)}
                className="font-mono uppercase"
              />
            </div>
          </div>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel onClick={() => {
              setTransactionId('');
              setSelectedRequest(null);
            }}>
              ← Back
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleApprove}
              disabled={processing === selectedRequest?.id || !transactionId.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {processing === selectedRequest?.id ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <CheckCircle className="h-4 w-4 mr-2" />
              )}
              Approve & Pay
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* User Details Dialog — opened when name is clicked */}
      {selectedUserForDetail && (
        <UserDetailsDialog
          open={userDetailOpen}
          onOpenChange={(open) => {
            setUserDetailOpen(open);
            if (!open) setSelectedUserForDetail(null);
          }}
          user={selectedUserForDetail}
        />
      )}

      {/* Full withdrawal record — due diligence view */}
      <WithdrawalRecordDetailDialog
        requestId={detailId}
        open={detailOpen}
        onOpenChange={(open) => { setDetailOpen(open); if (!open) setDetailId(null); }}
      />
    </>
  );
}