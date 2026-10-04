import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Loader2, Receipt, ChevronDown, ChevronUp, Users, Phone, MessageCircle, Trash2, FileDown, Share2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { buildReceiptText, shareViaWhatsApp } from '@/lib/shareReceipt';
import { generateAgentReportPdf, buildAgentReportWhatsAppText } from '@/lib/agentReportPdf';
import UserDetailsDialog from '@/components/manager/UserDetailsDialog';

import { formatDynamic as formatUGX } from '@/lib/currencyFormat';

interface MerchantPayment {
  id: string;
  agent_id: string;
  amount: number;
  merchant_name: string;
  notes: string | null;
  payment_date: string;
  tenant_phone: string;
  tenant_id: string | null;
  transaction_id: string;
  created_at: string;
  agent_name?: string;
  tenant_name?: string;
}

interface AgentGroup {
  agent_id: string;
  agent_name: string;
  total: number;
  count: number;
  payments: MerchantPayment[];
}

export function AgentCollectionsWidget() {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [grandTotal, setGrandTotal] = useState(0);
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [userDetailOpen, setUserDetailOpen] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: payments, error } = await supabase
        .from('tenant_merchant_payments')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      if (!payments || payments.length === 0) {
        setGroups([]);
        setGrandTotal(0);
        setLoading(false);
        return;
      }

      const agentIds = [...new Set(payments.map(p => p.agent_id))];
      const tenantIds = [...new Set(payments.filter(p => p.tenant_id).map(p => p.tenant_id!))];
      const allUserIds = [...new Set([...agentIds, ...tenantIds])];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', allUserIds);

      const profileMap = new Map((profiles || []).map(p => [p.id, p.full_name]));

      const agentMap = new Map<string, AgentGroup>();
      let total = 0;
      for (const p of payments) {
        total += p.amount;
        const existing = agentMap.get(p.agent_id);
        const enriched: MerchantPayment = { ...p, agent_name: profileMap.get(p.agent_id) || 'Unknown', tenant_name: p.tenant_id ? profileMap.get(p.tenant_id) || undefined : undefined };
        if (existing) {
          existing.total += p.amount;
          existing.count++;
          existing.payments.push(enriched);
        } else {
          agentMap.set(p.agent_id, {
            agent_id: p.agent_id,
            agent_name: profileMap.get(p.agent_id) || 'Unknown',
            total: p.amount,
            count: 1,
            payments: [enriched],
          });
        }
      }

      setGrandTotal(total);
      setGroups(Array.from(agentMap.values()).sort((a, b) => b.total - a.total));
    } catch (err) {
      console.error('Agent collections fetch error:', err);
      toast.error('Failed to load agent collections');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleViewUser = async (userId: string) => {
    try {
      const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
      if (data) {
        setSelectedUser(data);
        setUserDetailOpen(true);
      } else {
        toast.error('User profile not found');
      }
    } catch { toast.error('Failed to load user'); }
  };

  const handleDownloadReport = async (group: AgentGroup) => {
    const reportData = {
      agentName: group.agent_name,
      totalCollected: group.total,
      paymentCount: group.count,
      payments: group.payments.map(p => ({
        tenant_name: p.tenant_name,
        tenant_phone: p.tenant_phone || '',
        amount: p.amount,
        merchant_name: p.merchant_name,
        transaction_id: p.transaction_id,
        created_at: p.created_at,
        notes: p.notes,
      })),
    };
    const blob = await generateAgentReportPdf(reportData);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${group.agent_name.replace(/\s+/g, '_')}_report_${new Date().toISOString().split('T')[0]}.pdf`;
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
      window.open(url, '_blank');
    } else {
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success('PDF report downloaded');
  };

  const handleShareReport = (group: AgentGroup) => {
    const reportData = {
      agentName: group.agent_name,
      totalCollected: group.total,
      paymentCount: group.count,
      payments: group.payments.map(p => ({
        tenant_name: p.tenant_name,
        tenant_phone: p.tenant_phone || '',
        amount: p.amount,
        merchant_name: p.merchant_name,
        transaction_id: p.transaction_id,
        created_at: p.created_at,
        notes: p.notes,
      })),
    };
    const text = buildAgentReportWhatsAppText(reportData);
    shareViaWhatsApp(text);
    toast.success('Opening WhatsApp...');
  };

  const handleDeleteUser = async (userId: string) => {
    setDeletingUserId(userId);
    try {
      const reason = window.prompt('Reason for permanently deleting this user (min 10 characters, recorded in audit log):')?.trim() || '';
      if (reason.length < 10) { toast.error('A reason of at least 10 characters is required'); setDeletingUserId(null); return; }
      const { error } = await supabase.functions.invoke('delete-user', {
        body: { user_id: userId, reason },
      });
      if (error) throw error;
      toast.success('User permanently deleted');
      fetchData();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete user');
    } finally {
      setDeletingUserId(null);
    }
  };

  if (loading) {
    return (
      <div className="p-6 text-center">
        <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
        <p className="text-xs text-muted-foreground mt-1">Loading collections...</p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-muted-foreground">
          <Receipt className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No agent-recorded payments found</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Receipt className="h-4 w-4 text-emerald-600" />
            Agent Field Collections
          </CardTitle>
          <p className="text-[10px] text-muted-foreground">
            Payments recorded by agents via the old "Record Payment" feature
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {/* Grand Total */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Total Collected</p>
              <p className="text-lg font-black text-emerald-600">{formatUGX(grandTotal)}</p>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              {groups.reduce((s, g) => s + g.count, 0)} payments
            </Badge>
          </div>

          {/* Agent Groups */}
          <div className="divide-y divide-border rounded-lg border overflow-hidden">
            {groups.map(group => (
              <div key={group.agent_id}>
                <div className="flex items-center">
                  <button
                    onClick={() => setExpandedAgent(expandedAgent === group.agent_id ? null : group.agent_id)}
                    className="flex-1 flex items-center justify-between p-3 hover:bg-muted/30 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Users className="h-4 w-4 text-primary shrink-0" />
                      <div className="min-w-0">
                        <span
                          role="button"
                          onClick={(e) => { e.stopPropagation(); handleViewUser(group.agent_id); }}
                          className="font-semibold text-sm truncate text-primary underline decoration-dotted underline-offset-2 hover:text-primary/80 cursor-pointer block"
                        >
                          {group.agent_name}
                        </span>
                        <p className="text-[10px] text-muted-foreground">{group.count} payment{group.count !== 1 ? 's' : ''}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <p className="font-bold text-sm text-emerald-600">{formatUGX(group.total)}</p>
                      {expandedAgent === group.agent_id ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </button>
                  {/* Report buttons */}
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:bg-primary/10 shrink-0" title="Download PDF Report" onClick={(e) => { e.stopPropagation(); handleDownloadReport(group); }}>
                    <FileDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-emerald-600 hover:bg-emerald-500/10 shrink-0" title="Share on WhatsApp" onClick={(e) => { e.stopPropagation(); handleShareReport(group); }}>
                    <Share2 className="h-3.5 w-3.5" />
                  </Button>
                  {/* Delete agent button */}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 mr-1 text-destructive hover:bg-destructive/10 shrink-0">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>🗑️ Delete {group.agent_name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently remove this user and all their data from the platform. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleDeleteUser(group.agent_id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          disabled={deletingUserId === group.agent_id}
                        >
                          {deletingUserId === group.agent_id ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                          Delete Permanently
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>

                {expandedAgent === group.agent_id && (
                  <div className="bg-muted/20 divide-y divide-border/50">
                    {group.payments.map(p => (
                      <div key={p.id} className="px-4 py-2.5">
                        <div className="flex items-center justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <Phone className="h-3 w-3 text-muted-foreground shrink-0" />
                              {p.tenant_id ? (
                                <span
                                  role="button"
                                  onClick={(e) => { e.stopPropagation(); handleViewUser(p.tenant_id!); }}
                                  className="text-xs font-medium truncate text-primary underline decoration-dotted underline-offset-2 hover:text-primary/80 cursor-pointer"
                                >
                                  {p.tenant_name || p.tenant_phone}
                                </span>
                              ) : (
                                <span className="text-xs font-medium truncate">{p.tenant_phone}</span>
                              )}
                              {p.merchant_name && (
                                <span className="text-[10px] text-muted-foreground">• {p.merchant_name}</span>
                              )}
                            </div>
                            {p.notes && (
                              <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{p.notes}</p>
                            )}
                            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                              <span>{format(new Date(p.created_at), 'MMM d, h:mm a')}</span>
                              {p.transaction_id && (
                                <span className="font-mono">Txn: {p.transaction_id.substring(0, 15)}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0 ml-2">
                            <p className="font-bold text-sm text-foreground">{formatUGX(p.amount)}</p>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                const text = buildReceiptText({
                                  type: 'collection',
                                  amount: p.amount,
                                  agentName: p.agent_name,
                                  tenantPhone: p.tenant_phone,
                                  merchantName: p.merchant_name,
                                  transactionId: p.transaction_id,
                                  date: format(new Date(p.created_at), 'MMM d, yyyy h:mm a'),
                                  description: p.notes || undefined,
                                });
                                shareViaWhatsApp(text);
                                toast.success('Opening WhatsApp...');
                              }}
                              className="p-1 rounded-md hover:bg-emerald-500/10 text-emerald-600 transition-colors"
                              title="Share on WhatsApp"
                            >
                              <MessageCircle className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* User Details Dialog */}
      {selectedUser && (
        <UserDetailsDialog
          open={userDetailOpen}
          onOpenChange={(open) => { setUserDetailOpen(open); if (!open) setSelectedUser(null); }}
          user={selectedUser}
          onUserDeleted={() => { setUserDetailOpen(false); setSelectedUser(null); fetchData(); }}
        />
      )}
    </>
  );
}
