import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Home, Search, Edit2, Trash2, Loader2, CheckCircle, XCircle, Users, TrendingUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { toast } from 'sonner';

interface Subscription {
  id: string;
  tenant_id: string;
  landlord_id: string | null;
  monthly_rent: number;
  subscription_status: string;
  landlord_registered: boolean;
  total_savings: number;
  months_enrolled: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  tenant?: {
    full_name: string;
    phone: string;
  };
  landlord?: {
    full_name: string;
  } | null;
}

export function WelileHomesSubscriptionsManager() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [editingSubscription, setEditingSubscription] = useState<Subscription | null>(null);
  const [editForm, setEditForm] = useState({
    monthly_rent: '',
    subscription_status: '',
    landlord_registered: false,
    total_savings: '',
    months_enrolled: '',
    notes: '',
  });

  // Fetch subscriptions with tenant and landlord info
  const { data: subscriptions = [], isLoading } = useQuery({
    queryKey: ['welile-homes-subscriptions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('welile_homes_subscriptions')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Fetch tenant and landlord profiles
      const tenantIds = data.map((s) => s.tenant_id);
      const landlordIds = data.filter((s) => s.landlord_id).map((s) => s.landlord_id);

      const [tenantProfiles, landlordProfiles] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds),
        landlordIds.length > 0
          ? supabase.from('profiles').select('id, full_name').in('id', landlordIds)
          : { data: [] },
      ]);

      return data.map((sub) => ({
        ...sub,
        tenant: tenantProfiles.data?.find((p) => p.id === sub.tenant_id),
        landlord: landlordProfiles.data?.find((p) => p.id === sub.landlord_id),
      })) as Subscription[];
    },
  });

  // Update subscription mutation
  const updateMutation = useMutation({
    mutationFn: async (data: { id: string; updates: Partial<Subscription> }) => {
      const { error } = await supabase
        .from('welile_homes_subscriptions')
        .update(data.updates)
        .eq('id', data.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['welile-homes-subscriptions'] });
      toast.success('Subscription updated successfully');
      setEditingSubscription(null);
    },
    onError: (error) => {
      toast.error('Failed to update subscription: ' + error.message);
    },
  });

  // Delete subscription mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('welile_homes_subscriptions')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['welile-homes-subscriptions'] });
      toast.success('Subscription deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete subscription: ' + error.message);
    },
  });

  // Apply interest mutation. Calls the RPC directly -- there is no
  // 'apply-welile-homes-interest' edge function; the logic lives in
  // apply_welile_homes_monthly_interest(), which returns the updated row
  // count as a plain integer (not an { updated_count } object).
  const applyInterestMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('apply_welile_homes_monthly_interest');
      if (error) throw error;
      return data as number;
    },
    onSuccess: (updatedCount) => {
      queryClient.invalidateQueries({ queryKey: ['welile-homes-subscriptions'] });
      toast.success(`Applied 5% interest to ${updatedCount ?? 0} subscriptions`);
    },
    onError: (error) => {
      toast.error('Failed to apply interest: ' + error.message);
    },
  });

  const handleEditClick = (subscription: Subscription) => {
    setEditingSubscription(subscription);
    setEditForm({
      monthly_rent: subscription.monthly_rent.toString(),
      subscription_status: subscription.subscription_status,
      landlord_registered: subscription.landlord_registered,
      total_savings: subscription.total_savings.toString(),
      months_enrolled: subscription.months_enrolled.toString(),
      notes: subscription.notes || '',
    });
  };

  const handleSaveEdit = () => {
    if (!editingSubscription) return;

    updateMutation.mutate({
      id: editingSubscription.id,
      updates: {
        monthly_rent: parseFloat(editForm.monthly_rent) || 0,
        subscription_status: editForm.subscription_status,
        landlord_registered: editForm.landlord_registered,
        total_savings: parseFloat(editForm.total_savings) || 0,
        months_enrolled: parseInt(editForm.months_enrolled) || 0,
        notes: editForm.notes || null,
      },
    });
  };

  const filteredSubscriptions = subscriptions.filter((sub) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      sub.tenant?.full_name?.toLowerCase().includes(query) ||
      sub.tenant?.phone?.toLowerCase().includes(query) ||
      sub.landlord?.full_name?.toLowerCase().includes(query)
    );
  });

  const stats = {
    total: subscriptions.length,
    active: subscriptions.filter((s) => s.subscription_status === 'active').length,
    landlordRegistered: subscriptions.filter((s) => s.landlord_registered).length,
    totalSavings: subscriptions.reduce((sum, s) => sum + (s.total_savings || 0), 0),
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-purple-600" />
              <div>
                <p className="text-xs text-muted-foreground">Total Subscribers</p>
                <p className="text-lg font-bold">{stats.total}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-600" />
              <div>
                <p className="text-xs text-muted-foreground">Active</p>
                <p className="text-lg font-bold">{stats.active}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2">
              <Home className="h-4 w-4 text-blue-600" />
              <div>
                <p className="text-xs text-muted-foreground">Landlord Registered</p>
                <p className="text-lg font-bold">{stats.landlordRegistered}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2">
              <Home className="h-4 w-4 text-amber-600" />
              <div>
                <p className="text-xs text-muted-foreground">Total Savings</p>
                <p className="text-lg font-bold">{formatUGX(stats.totalSavings)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Actions Row */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by tenant or landlord name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button
          onClick={() => applyInterestMutation.mutate()}
          disabled={applyInterestMutation.isPending}
          className="bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 h-10"
        >
          {applyInterestMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <TrendingUp className="h-4 w-4 mr-2" />
          )}
          Apply 5% Interest
        </Button>
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Home className="h-5 w-5 text-purple-600" />
            Welile Homes Subscriptions
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Monthly Rent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Landlord</TableHead>
                  <TableHead>Savings</TableHead>
                  <TableHead>Enrolled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSubscriptions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      No subscriptions found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredSubscriptions.map((sub) => (
                    <TableRow key={sub.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium">{sub.tenant?.full_name || 'Unknown'}</p>
                          <p className="text-xs text-muted-foreground">{sub.tenant?.phone}</p>
                        </div>
                      </TableCell>
                      <TableCell>{formatUGX(sub.monthly_rent)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            sub.subscription_status === 'active'
                              ? 'default'
                              : sub.subscription_status === 'paused'
                              ? 'secondary'
                              : 'destructive'
                          }
                        >
                          {sub.subscription_status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {sub.landlord_registered ? (
                          <div className="flex items-center gap-1 text-emerald-600">
                            <CheckCircle className="h-4 w-4" />
                            <span className="text-xs">{sub.landlord?.full_name || 'Registered'}</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-amber-600">
                            <XCircle className="h-4 w-4" />
                            <span className="text-xs">Not registered</span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">{formatUGX(sub.total_savings)}</TableCell>
                      <TableCell>{sub.months_enrolled} months</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleEditClick(sub)}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => {
                              if (confirm('Delete this subscription?')) {
                                deleteMutation.mutate(sub.id);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingSubscription} onOpenChange={() => setEditingSubscription(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Subscription</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Monthly Rent (UGX)</label>
              <Input
                type="number"
                value={editForm.monthly_rent}
                onChange={(e) => setEditForm({ ...editForm, monthly_rent: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Status</label>
              <Select
                value={editForm.subscription_status}
                onValueChange={(v) => setEditForm({ ...editForm, subscription_status: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="landlord_registered"
                checked={editForm.landlord_registered}
                onChange={(e) => setEditForm({ ...editForm, landlord_registered: e.target.checked })}
                className="h-4 w-4 rounded border-border"
              />
              <label htmlFor="landlord_registered" className="text-sm font-medium">
                Landlord Registered
              </label>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Total Savings (UGX)</label>
              <Input
                type="number"
                value={editForm.total_savings}
                onChange={(e) => setEditForm({ ...editForm, total_savings: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Months Enrolled</label>
              <Input
                type="number"
                value={editForm.months_enrolled}
                onChange={(e) => setEditForm({ ...editForm, months_enrolled: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Notes</label>
              <Textarea
                value={editForm.notes}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                placeholder="Add notes about this subscription..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSubscription(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
