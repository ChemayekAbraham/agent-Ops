import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { ClipboardList, Search, ChevronLeft, ChevronRight, Filter } from "lucide-react";

interface AuditLog {
  id: string;
  action_type: string;
  table_name: string;
  record_id: string;
  performed_by: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface AuditLogViewerProps {
  tableName?: string;
  recordId?: string;
  limit?: number;
}

export const AuditLogViewer = ({ tableName, recordId, limit = 50 }: AuditLogViewerProps) => {
  const [page, setPage] = useState(0);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [tableFilter, setTableFilter] = useState<string>(tableName || "all");
  const [searchTerm, setSearchTerm] = useState("");

  const { data: logs, isLoading } = useQuery({
    queryKey: ["audit-logs", page, actionFilter, tableFilter, searchTerm, recordId],
    queryFn: async () => {
      let query = supabase
        .from("audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .range(page * limit, (page + 1) * limit - 1);

      if (actionFilter !== "all") {
        query = query.eq("action_type", actionFilter);
      }
      if (tableFilter !== "all") {
        query = query.eq("table_name", tableFilter);
      }
      if (recordId) {
        query = query.eq("record_id", recordId);
      }

      const { data, error } = await query;
      if (error) throw error;

      return (data || []).map((log: any) => ({
        id: log.id,
        action_type: log.action_type,
        table_name: log.table_name || '',
        record_id: log.record_id || '',
        performed_by: log.user_id || '',
        old_values: null,
        new_values: null,
        reason: (log.metadata as any)?.reason || null,
        metadata: log.metadata as Record<string, unknown> | null,
        created_at: log.created_at,
      })) as AuditLog[];
    },
  });

  const { data: managers } = useQuery({
    queryKey: ["managers-for-audit"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name");
      if (error) throw error;
      return data;
    },
  });

  const getManagerName = (managerId: string) => {
    const manager = managers?.find((m) => m.id === managerId);
    return manager?.full_name || "Unknown";
  };

  const getActionBadge = (action: string) => {
    switch (action) {
      case "approve":
        return <Badge className="bg-green-500">Approved</Badge>;
      case "reject":
        return <Badge variant="destructive">Rejected</Badge>;
      case "update":
        return <Badge variant="secondary">Updated</Badge>;
      case "create":
        return <Badge className="bg-blue-500">Created</Badge>;
      case "delete":
        return <Badge variant="outline">Deleted</Badge>;
      default:
        return <Badge variant="outline">{action}</Badge>;
    }
  };

  const filteredLogs = logs?.filter((log) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      log.action_type.toLowerCase().includes(term) ||
      log.table_name.toLowerCase().includes(term) ||
      getManagerName(log.performed_by).toLowerCase().includes(term) ||
      log.reason?.toLowerCase().includes(term)
    );
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5" />
          Audit Log
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search logs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-[140px]">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              <SelectItem value="approve">Approved</SelectItem>
              <SelectItem value="reject">Rejected</SelectItem>
              <SelectItem value="update">Updated</SelectItem>
              <SelectItem value="create">Created</SelectItem>
            </SelectContent>
          </Select>
          {!tableName && (
            <Select value={tableFilter} onValueChange={setTableFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Table" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Tables</SelectItem>
                <SelectItem value="deposit_requests">Deposits</SelectItem>
                <SelectItem value="rent_requests">Rent Requests</SelectItem>
                <SelectItem value="loan_applications">Loans</SelectItem>
                <SelectItem value="investment_accounts">Investments</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Table */}
        <ScrollArea className="h-[400px]">
          {isLoading ? (
            <div className="flex items-center justify-center h-40">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : filteredLogs?.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No audit logs found
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date & Time</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Table</TableHead>
                  <TableHead>Manager</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLogs?.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="whitespace-nowrap">
                      {format(new Date(log.created_at), "MMM d, yyyy HH:mm")}
                    </TableCell>
                    <TableCell>{getActionBadge(log.action_type)}</TableCell>
                    <TableCell className="capitalize">
                      {log.table_name.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell>{getManagerName(log.performed_by)}</TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {log.reason || "-"}
                    </TableCell>
                    <TableCell>
                      {log.metadata && (
                        <span className="text-xs text-muted-foreground">
                          {log.metadata.amount && `UGX ${Number(log.metadata.amount).toLocaleString()}`}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ScrollArea>

        {/* Pagination */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {filteredLogs?.length || 0} entries
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
              disabled={(logs?.length || 0) < limit}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
