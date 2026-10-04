import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  History, 
  TrendingUp, 
  Wallet, 
  Percent, 
  ChevronDown,
  ChevronUp,
  Loader2,
  Calendar
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';

interface Contribution {
  id: string;
  contribution_type: string;
  amount: number;
  balance_after: number;
  notes: string | null;
  created_at: string;
}

interface ContributionHistoryTimelineProps {
  userId: string;
  limit?: number;
}

export function ContributionHistoryTimeline({ 
  userId, 
  limit = 5 
}: ContributionHistoryTimelineProps) {
  const [expanded, setExpanded] = useState(false);

  const { data: contributions = [], isLoading } = useQuery({
    queryKey: ['welile-homes-contributions-timeline', userId],
    queryFn: async () => {
      // welile_homes_contributions table removed - return empty
      return [] as Contribution[];
    },
    enabled: !!userId,
  });

  const getContributionIcon = (type: string) => {
    switch (type) {
      case 'rent_payment':
        return <Wallet className="h-4 w-4 text-emerald-600" />;
      case 'interest':
        return <Percent className="h-4 w-4 text-purple-600" />;
      case 'bonus':
        return <TrendingUp className="h-4 w-4 text-amber-600" />;
      default:
        return <Wallet className="h-4 w-4 text-blue-600" />;
    }
  };

  const getContributionLabel = (type: string) => {
    switch (type) {
      case 'rent_payment':
        return 'Rent Contribution';
      case 'interest':
        return 'Interest Earned';
      case 'bonus':
        return 'Bonus';
      case 'manual':
        return 'Manual Adjustment';
      default:
        return 'Contribution';
    }
  };

  const getContributionColor = (type: string) => {
    switch (type) {
      case 'rent_payment':
        return 'bg-emerald-50 border-emerald-200';
      case 'interest':
        return 'bg-purple-50 border-purple-200';
      case 'bonus':
        return 'bg-amber-50 border-amber-200';
      default:
        return 'bg-blue-50 border-blue-200';
    }
  };

  const displayedContributions = expanded ? contributions : contributions.slice(0, limit);

  // Calculate totals
  const totalContributions = contributions
    .filter(c => c.contribution_type === 'rent_payment')
    .reduce((sum, c) => sum + c.amount, 0);
  const totalInterest = contributions
    .filter(c => c.contribution_type === 'interest')
    .reduce((sum, c) => sum + c.amount, 0);

  if (isLoading) {
    return (
      <Card className="border-purple-200">
        <CardContent className="p-6 flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
        </CardContent>
      </Card>
    );
  }

  if (contributions.length === 0) {
    return (
      <Card className="border-purple-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <History className="h-4 w-4 text-purple-600" />
            Contribution History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <Calendar className="h-10 w-10 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No contributions yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Your contributions will appear here when you make rent payments through Welile Wallet.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-purple-200 overflow-hidden">
      <CardHeader className="pb-2 bg-gradient-to-r from-purple-50 to-white">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <History className="h-4 w-4 text-purple-600" />
            Contribution History
          </CardTitle>
          <Badge variant="outline" className="text-[10px] bg-card">
            {contributions.length} entries
          </Badge>
        </div>
      </CardHeader>
      
      <CardContent className="pt-3 pb-4">
        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200">
            <div className="flex items-center gap-1.5 mb-1">
              <Wallet className="h-3.5 w-3.5 text-emerald-600" />
              <span className="text-[10px] font-medium text-emerald-700">Total Deposits</span>
            </div>
            <p className="text-sm font-bold text-emerald-800">{formatUGX(totalContributions)}</p>
          </div>
          <div className="p-2.5 rounded-lg bg-purple-50 border border-purple-200">
            <div className="flex items-center gap-1.5 mb-1">
              <Percent className="h-3.5 w-3.5 text-purple-600" />
              <span className="text-[10px] font-medium text-purple-700">Interest Earned</span>
            </div>
            <p className="text-sm font-bold text-purple-800">{formatUGX(totalInterest)}</p>
          </div>
        </div>

        {/* Timeline */}
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-4 top-0 bottom-0 w-px bg-gradient-to-b from-purple-300 via-purple-200 to-transparent" />
          
          <AnimatePresence mode="popLayout">
            <div className="space-y-3">
              {displayedContributions.map((contribution, index) => (
                <motion.div
                  key={contribution.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ delay: index * 0.05 }}
                  className="relative pl-10"
                >
                  {/* Timeline dot */}
                  <div className={`absolute left-2 top-3 w-4 h-4 rounded-full border-2 bg-card flex items-center justify-center ${
                    contribution.contribution_type === 'interest' ? 'border-purple-400' : 'border-emerald-400'
                  }`}>
                    <div className={`w-2 h-2 rounded-full ${
                      contribution.contribution_type === 'interest' ? 'bg-purple-500' : 'bg-emerald-500'
                    }`} />
                  </div>
                  
                  {/* Content */}
                  <div className={`p-3 rounded-lg border ${getContributionColor(contribution.contribution_type)}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {getContributionIcon(contribution.contribution_type)}
                        <div>
                          <p className="text-sm font-medium">
                            {getContributionLabel(contribution.contribution_type)}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {format(new Date(contribution.created_at), 'MMM d, yyyy • h:mm a')}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-bold ${
                          contribution.contribution_type === 'interest' ? 'text-purple-700' : 'text-emerald-700'
                        }`}>
                          +{formatUGX(contribution.amount)}
                        </p>
                      </div>
                    </div>
                    {contribution.notes && (
                      <p className="text-xs text-muted-foreground mt-2 pt-2 border-t border-dashed">
                        {contribution.notes}
                      </p>
                    )}
                  </div>
                </motion.div>
              ))}
            </div>
          </AnimatePresence>
        </div>

        {/* Expand/Collapse Button */}
        {contributions.length > limit && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="w-full mt-4 text-purple-600 hover:text-purple-700 hover:bg-purple-50"
          >
            {expanded ? (
              <>
                <ChevronUp className="h-4 w-4 mr-1" />
                Show Less
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4 mr-1" />
                Show All {contributions.length} Entries
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
