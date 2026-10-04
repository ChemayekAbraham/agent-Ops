import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { format } from "date-fns";
import { 
  Activity, 
  Search, 
  ChevronLeft, 
  ChevronRight, 
  Filter,
  Edit,
  Trash2,
  Home,
  CreditCard,
  Receipt,
  ShoppingCart,
  Wallet,
  User,
  FileText,
  Eye,
  X,
  Loader2,
  Check,
  Clock,
  XCircle,
  AlertCircle
} from "lucide-react";
import { formatUGX } from "@/lib/rentCalculations";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";

interface UserActivity {
  id: string;
  type: 'rent_request' | 'loan_application' | 'deposit_request' | 'product_order' | 'receipt' | 'repayment' | 'wallet_transaction';
  user_id: string;
  user_name: string;
  user_phone?: string;
  title: string;
  description: string;
  amount: number;
  status: string;
  created_at: string;
  metadata: Record<string, unknown>;
  original_data: Record<string, unknown>;
}

interface EditDialogData {
  activity: UserActivity;
  newStatus: string;
  reason: string;
}

export const ActivityManager = () => {
  const [page, setPage] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [editDialog, setEditDialog] = useState<EditDialogData | null>(null);
  const [viewDialog, setViewDialog] = useState<UserActivity | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<UserActivity | null>(null);
  const limit = 20;

  const queryClient = useQueryClient();

  // Fetch all activities from multiple tables
  const { data: activities, isLoading, refetch } = useQuery({
    queryKey: ["all-activities", page, typeFilter, statusFilter],
    queryFn: async () => {
      const allActivities: UserActivity[] = [];

      // Fetch profiles for user names
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name, phone");
      
      const getProfile = (userId: string) => profiles?.find(p => p.id === userId);

      // Rent Requests
      if (typeFilter === "all" || typeFilter === "rent_request") {
        const { data: rentRequests } = await supabase
          .from("rent_requests")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100);

        rentRequests?.forEach(r => {
          const profile = getProfile(r.tenant_id);
          if (statusFilter === "all" || r.status === statusFilter) {
            allActivities.push({
              id: r.id,
              type: "rent_request",
              user_id: r.tenant_id,
              user_name: profile?.full_name || "Unknown User",
              user_phone: profile?.phone,
              title: "Rent Assistance Request",
              description: `Requested ${formatUGX(r.rent_amount)} for ${r.duration_days} days`,
              amount: r.rent_amount,
              status: r.status || "pending",
              created_at: r.created_at,
              metadata: { duration: r.duration_days, daily_repayment: r.daily_repayment },
              original_data: r as unknown as Record<string, unknown>
            });
          }
        });
      }

      // Loan Applications - table removed, skip

      // Deposit Requests
      if (typeFilter === "all" || typeFilter === "deposit_request") {
        const { data: deposits } = await supabase
          .from("deposit_requests")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100);

        deposits?.forEach(d => {
          const profile = getProfile(d.user_id);
          if (statusFilter === "all" || d.status === statusFilter) {
            allActivities.push({
              id: d.id,
              type: "deposit_request",
              user_id: d.user_id,
              user_name: profile?.full_name || "Unknown User",
              user_phone: profile?.phone,
              title: "Wallet Deposit Request",
              description: `Deposit request of ${formatUGX(d.amount)}`,
              amount: d.amount,
              status: d.status,
              created_at: d.created_at,
              metadata: { agent_id: d.agent_id },
              original_data: d as unknown as Record<string, unknown>
            });
          }
        });
      }

      // Product Orders
      if (typeFilter === "all" || typeFilter === "product_order") {
        const { data: orders } = await supabase
          .from("product_orders")
          .select("*, products(name)")
          .order("created_at", { ascending: false })
          .limit(100);

        orders?.forEach(o => {
          const profile = getProfile(o.buyer_id);
          if (statusFilter === "all" || o.status === statusFilter) {
            allActivities.push({
              id: o.id,
              type: "product_order",
              user_id: o.buyer_id,
              user_name: profile?.full_name || "Unknown User",
              user_phone: profile?.phone,
              title: "Product Order",
              description: `Ordered ${o.products?.name || "Unknown Product"} (x${o.quantity})`,
              amount: o.total_price,
              status: o.status,
              created_at: o.created_at,
              metadata: { quantity: o.quantity, product: o.products?.name },
              original_data: o as unknown as Record<string, unknown>
            });
          }
        });
      }

      // User Receipts
      if (typeFilter === "all" || typeFilter === "receipt") {
        const { data: receipts } = await supabase
          .from("user_receipts")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100);

        receipts?.forEach(r => {
          const profile = getProfile(r.user_id);
          const status = r.verified ? "verified" : (r.rejection_reason ? "rejected" : "pending");
          if (statusFilter === "all" || status === statusFilter) {
            allActivities.push({
              id: r.id,
              type: "receipt",
              user_id: r.user_id,
              user_name: profile?.full_name || "Unknown User",
              user_phone: profile?.phone,
              title: "Receipt Submission",
              description: r.items_description || "Shopping receipt",
              amount: r.claimed_amount,
              status: status,
              created_at: r.created_at,
              metadata: { items: r.items_description, verified: r.verified },
              original_data: r as unknown as Record<string, unknown>
            });
          }
        });
      }

      // Repayments - table removed, skip

      // Sort by date and paginate
      allActivities.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return allActivities.slice(page * limit, (page + 1) * limit);
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async ({ activity, newStatus, reason }: EditDialogData) => {
      if (activity.type === "receipt") {
        const { error } = await supabase
          .from("user_receipts")
          .update({ 
            verified: newStatus === "verified",
            rejection_reason: newStatus === "rejected" ? reason : null,
            verified_at: newStatus === "verified" ? new Date().toISOString() : null
          })
          .eq("id", activity.id);
        if (error) throw error;
      } else if (activity.type === "rent_request") {
        const { error } = await supabase
          .from("rent_requests")
          .update({ status: newStatus })
          .eq("id", activity.id);
        if (error) throw error;
      } else if (activity.type === "loan_application") {
        // loan_applications table removed
        throw new Error('Feature unavailable');
      } else if (activity.type === "deposit_request") {
        const { error } = await supabase
          .from("deposit_requests")
          .update({ status: newStatus })
          .eq("id", activity.id);
        if (error) throw error;
      } else if (activity.type === "product_order") {
        const { error } = await supabase
          .from("product_orders")
          .update({ status: newStatus })
          .eq("id", activity.id);
        if (error) throw error;
      }

      // Log the action - skip for now due to type complexity
      // The audit log will be captured by other means
    },
    onSuccess: () => {
      toast.success("Activity updated successfully");
      setEditDialog(null);
      refetch();
      queryClient.invalidateQueries({ queryKey: ["audit-logs"] });
    },
    onError: (error) => {
      toast.error("Failed to update: " + (error as Error).message);
    }
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (activity: UserActivity) => {
      // Delete from proper table
      if (activity.type === "rent_request") {
        const { error } = await supabase.from("rent_requests").delete().eq("id", activity.id);
        if (error) throw error;
      } else if (activity.type === "loan_application") {
        // loan_applications table removed
        throw new Error('Feature unavailable');
      } else if (activity.type === "deposit_request") {
        const { error } = await supabase.from("deposit_requests").delete().eq("id", activity.id);
        if (error) throw error;
      } else if (activity.type === "product_order") {
        const { error } = await supabase.from("product_orders").delete().eq("id", activity.id);
        if (error) throw error;
      } else if (activity.type === "receipt") {
        const { error } = await supabase.from("user_receipts").delete().eq("id", activity.id);
        if (error) throw error;
      } else if (activity.type === "repayment") {
        // repayments table removed
        throw new Error('Feature unavailable');
      }
    },
    onSuccess: () => {
      toast.success("Activity deleted successfully");
      setDeleteDialog(null);
      refetch();
    },
    onError: (error) => {
      toast.error("Failed to delete: " + (error as Error).message);
    }
  });

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "rent_request": return <Home className="h-4 w-4" />;
      case "loan_application": return <CreditCard className="h-4 w-4" />;
      case "deposit_request": return <Wallet className="h-4 w-4" />;
      case "product_order": return <ShoppingCart className="h-4 w-4" />;
      case "receipt": return <Receipt className="h-4 w-4" />;
      case "repayment": return <FileText className="h-4 w-4" />;
      default: return <Activity className="h-4 w-4" />;
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "rent_request": return "bg-blue-500/10 text-blue-500 border-blue-500/20";
      case "loan_application": return "bg-purple-500/10 text-purple-500 border-purple-500/20";
      case "deposit_request": return "bg-green-500/10 text-green-500 border-green-500/20";
      case "product_order": return "bg-orange-500/10 text-orange-500 border-orange-500/20";
      case "receipt": return "bg-pink-500/10 text-pink-500 border-pink-500/20";
      case "repayment": return "bg-emerald-500/10 text-emerald-500 border-emerald-500/20";
      default: return "bg-muted text-muted-foreground";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "approved":
      case "completed":
      case "verified":
      case "funded":
      case "disbursed":
        return <Check className="h-3 w-3" />;
      case "pending":
        return <Clock className="h-3 w-3" />;
      case "rejected":
      case "cancelled":
        return <XCircle className="h-3 w-3" />;
      default:
        return <AlertCircle className="h-3 w-3" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "approved":
      case "completed":
      case "verified":
      case "funded":
      case "disbursed":
        return "bg-success/10 text-success border-success/20";
      case "pending":
        return "bg-warning/10 text-warning border-warning/20";
      case "rejected":
      case "cancelled":
        return "bg-destructive/10 text-destructive border-destructive/20";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  const getStatusOptions = (type: string) => {
    switch (type) {
      case "rent_request":
        return ["pending", "approved", "funded", "disbursed", "repaid", "rejected"];
      case "loan_application":
        return ["pending", "approved", "rejected"];
      case "deposit_request":
        return ["pending", "approved", "rejected"];
      case "product_order":
        return ["pending", "processing", "shipped", "delivered", "cancelled"];
      case "receipt":
        return ["pending", "verified", "rejected"];
      default:
        return ["pending", "completed"];
    }
  };

  const filteredActivities = activities?.filter((activity) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      activity.user_name.toLowerCase().includes(term) ||
      activity.title.toLowerCase().includes(term) ||
      activity.description.toLowerCase().includes(term) ||
      activity.user_phone?.includes(term)
    );
  });

  return (
    <Card className="border-0 shadow-lg">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Activity className="h-5 w-5 text-primary" />
          All User Activities
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or phone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[150px] h-9">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="rent_request">Rent Requests</SelectItem>
              <SelectItem value="loan_application">Loans</SelectItem>
              <SelectItem value="deposit_request">Deposits</SelectItem>
              <SelectItem value="product_order">Orders</SelectItem>
              <SelectItem value="receipt">Receipts</SelectItem>
              <SelectItem value="repayment">Repayments</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[130px] h-9">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="verified">Verified</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Activity List */}
        <ScrollArea className="h-[500px]">
          {isLoading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : filteredActivities?.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Activity className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>No activities found</p>
            </div>
          ) : (
            <div className="space-y-2">
              <AnimatePresence>
                {filteredActivities?.map((activity, index) => (
                  <motion.div
                    key={activity.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.03 }}
                    className="bg-card border rounded-xl p-3 hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-start gap-3">
                      {/* Type Icon */}
                      <div className={`p-2 rounded-lg ${getTypeColor(activity.type)}`}>
                        {getTypeIcon(activity.type)}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-sm truncate">{activity.user_name}</span>
                              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${getStatusColor(activity.status)}`}>
                                {getStatusIcon(activity.status)}
                                <span className="ml-1">{activity.status}</span>
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">{activity.user_phone}</p>
                          </div>
                          <span className="text-xs font-semibold text-primary whitespace-nowrap">
                            {formatUGX(activity.amount)}
                          </span>
                        </div>

                        <p className="text-sm mt-1 font-medium">{activity.title}</p>
                        <p className="text-xs text-muted-foreground line-clamp-1">{activity.description}</p>

                        <div className="flex items-center justify-between mt-2">
                          <span className="text-[10px] text-muted-foreground">
                            {format(new Date(activity.created_at), "MMM d, yyyy 'at' h:mm a")}
                          </span>
                          
                          {/* Actions */}
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => setViewDialog(activity)}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                            {activity.type !== "repayment" && activity.type !== "wallet_transaction" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => setEditDialog({ activity, newStatus: activity.status, reason: "" })}
                              >
                                <Edit className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => setDeleteDialog(activity)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </ScrollArea>

        {/* Pagination */}
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground">
            Showing {filteredActivities?.length || 0} activities
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={(activities?.length || 0) < limit}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>

      {/* View Dialog */}
      <Dialog open={!!viewDialog} onOpenChange={() => setViewDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Activity Details
            </DialogTitle>
          </DialogHeader>
          {viewDialog && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className={`p-3 rounded-lg ${getTypeColor(viewDialog.type)}`}>
                  {getTypeIcon(viewDialog.type)}
                </div>
                <div>
                  <p className="font-medium">{viewDialog.user_name}</p>
                  <p className="text-sm text-muted-foreground">{viewDialog.user_phone}</p>
                </div>
              </div>

              <div className="grid gap-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Type</span>
                  <Badge variant="outline">{viewDialog.type.replace(/_/g, " ")}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <Badge className={getStatusColor(viewDialog.status)}>{viewDialog.status}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Amount</span>
                  <span className="font-semibold">{formatUGX(viewDialog.amount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Date</span>
                  <span>{format(new Date(viewDialog.created_at), "MMM d, yyyy h:mm a")}</span>
                </div>
              </div>

              <div className="pt-2 border-t">
                <p className="text-sm font-medium mb-1">{viewDialog.title}</p>
                <p className="text-sm text-muted-foreground">{viewDialog.description}</p>
              </div>

              {Object.keys(viewDialog.metadata).length > 0 && (
                <div className="pt-2 border-t">
                  <p className="text-xs font-medium mb-2 text-muted-foreground">Additional Info</p>
                  <div className="text-xs space-y-1">
                    {Object.entries(viewDialog.metadata).map(([key, value]) => (
                      <div key={key} className="flex justify-between">
                        <span className="text-muted-foreground capitalize">{key.replace(/_/g, " ")}</span>
                        <span>{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editDialog} onOpenChange={() => setEditDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit className="h-5 w-5" />
              Edit Activity
            </DialogTitle>
          </DialogHeader>
          {editDialog && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                <User className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="font-medium">{editDialog.activity.user_name}</p>
                  <p className="text-sm text-muted-foreground">{editDialog.activity.title}</p>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">New Status</label>
                <Select value={editDialog.newStatus} onValueChange={(v) => setEditDialog({ ...editDialog, newStatus: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {getStatusOptions(editDialog.activity.type).map(status => (
                      <SelectItem key={status} value={status}>
                        {status.charAt(0).toUpperCase() + status.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Reason (optional)</label>
                <Textarea
                  placeholder="Enter reason for this change..."
                  value={editDialog.reason}
                  onChange={(e) => setEditDialog({ ...editDialog, reason: e.target.value })}
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialog(null)}>
              Cancel
            </Button>
            <Button 
              onClick={() => editDialog && updateMutation.mutate(editDialog)}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={!!deleteDialog} onOpenChange={() => setDeleteDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              Delete Activity
            </DialogTitle>
          </DialogHeader>
          {deleteDialog && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Are you sure you want to delete this activity? This action cannot be undone.
              </p>
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="font-medium">{deleteDialog.title}</p>
                <p className="text-sm text-muted-foreground">{deleteDialog.user_name} • {formatUGX(deleteDialog.amount)}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialog(null)}>
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={() => deleteDialog && deleteMutation.mutate(deleteDialog)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
