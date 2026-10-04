import { useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import StatusBadge, { TransactionStatus } from './StatusBadge';
import { Eye, Download, Search, Filter, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

export interface Transaction {
  id: string;
  date: Date;
  type: 'deposit' | 'withdrawal' | 'payment' | 'transfer' | 'refund' | 'funding';
  method: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  reference: string;
  description?: string;
  recipient?: string;
}

interface TransactionTableProps {
  transactions: Transaction[];
  onView?: (transaction: Transaction) => void;
  onDownload?: (transaction: Transaction) => void;
  showSearch?: boolean;
  showFilters?: boolean;
  title?: string;
  maxRows?: number;
}

const typeLabels = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  payment: 'Payment',
  transfer: 'Transfer',
  refund: 'Refund',
  funding: 'Funding',
};

const typeIcons = {
  deposit: ArrowDownLeft,
  withdrawal: ArrowUpRight,
  payment: ArrowUpRight,
  transfer: ArrowUpRight,
  refund: ArrowDownLeft,
  funding: ArrowUpRight,
};

export default function TransactionTable({
  transactions,
  onView,
  onDownload,
  showSearch = true,
  showFilters = true,
  title = 'Recent Transactions',
  maxRows,
}: TransactionTableProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const filteredTransactions = transactions
    .filter(t => {
      if (search && !t.reference.toLowerCase().includes(search.toLowerCase()) && 
          !t.description?.toLowerCase().includes(search.toLowerCase())) {
        return false;
      }
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      return true;
    })
    .slice(0, maxRows);

  const formatAmount = (amount: number, currency: string, type: string) => {
    const isIncoming = type === 'deposit' || type === 'refund';
    const prefix = isIncoming ? '+' : '-';
    return `${prefix} ${currency} ${amount.toLocaleString()}`;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <CardTitle className="text-lg">{title}</CardTitle>
          
          {(showSearch || showFilters) && (
            <div className="flex flex-wrap gap-2">
              {showSearch && (
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input 
                    placeholder="Search reference..." 
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9 h-9"
                  />
                </div>
              )}
              
              {showFilters && (
                <>
                  <Select value={typeFilter} onValueChange={setTypeFilter}>
                    <SelectTrigger className="w-[120px] h-9">
                      <SelectValue placeholder="Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Types</SelectItem>
                      <SelectItem value="deposit">Deposit</SelectItem>
                      <SelectItem value="withdrawal">Withdrawal</SelectItem>
                      <SelectItem value="payment">Payment</SelectItem>
                      <SelectItem value="funding">Funding</SelectItem>
                    </SelectContent>
                  </Select>
                  
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-[120px] h-9">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Status</SelectItem>
                      <SelectItem value="success">Success</SelectItem>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTransactions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    No transactions found
                  </TableCell>
                </TableRow>
              ) : (
                filteredTransactions.map((transaction) => {
                  const TypeIcon = typeIcons[transaction.type];
                  const isIncoming = transaction.type === 'deposit' || transaction.type === 'refund';
                  
                  return (
                    <TableRow key={transaction.id} className="group">
                      <TableCell className="whitespace-nowrap">
                        {format(transaction.date, 'MMM d, yyyy')}
                        <span className="block text-xs text-muted-foreground">
                          {format(transaction.date, 'HH:mm')}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className={cn(
                            'w-6 h-6 rounded-full flex items-center justify-center',
                            isIncoming ? 'bg-emerald-100 text-emerald-600' : 'bg-orange-100 text-orange-600'
                          )}>
                            <TypeIcon className="w-3 h-3" />
                          </div>
                          <span className="text-sm font-medium">{typeLabels[transaction.type]}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{transaction.method}</TableCell>
                      <TableCell className={cn(
                        'text-right font-semibold whitespace-nowrap',
                        isIncoming ? 'text-emerald-600' : 'text-foreground'
                      )}>
                        {formatAmount(transaction.amount, transaction.currency, transaction.type)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={transaction.status} size="sm" />
                      </TableCell>
                      <TableCell className="text-sm font-mono text-muted-foreground">
                        {transaction.reference.slice(0, 12)}...
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {onView && (
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="h-8 w-8"
                              onClick={() => onView(transaction)}
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                          )}
                          {onDownload && transaction.status === 'success' && (
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="h-8 w-8"
                              onClick={() => onDownload(transaction)}
                            >
                              <Download className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
