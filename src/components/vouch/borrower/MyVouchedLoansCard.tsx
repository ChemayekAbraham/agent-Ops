import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Banknote, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { Badge } from '@/components/ui/badge';

interface Claim {
  id: string;
  principal_ugx: number;
  vouched_amount_ugx: number;
  status: string;
  disbursement_date: string;
  expected_repayment_date: string | null;
  loan_purpose: string | null;
  lender_partner_id: string;
  created_at: string;
}

interface PartnerLite { id: string; legal_name: string; }

/**
 * Borrower-facing card showing all vouched loans recorded against the user's profile.
 * Renders only when the user views their OWN profile and has at least one claim.
 */
export default function MyVouchedLoansCard() {
  const { user } = useAuth();
  const [claims, setClaims] = useState<Claim[]>([]);
  const [partners, setPartners] = useState<Record<string, PartnerLite>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    (async () => {
      const { data: claimsData } = await (supabase
        .from('vouch_claims' as any)
        .select('*')
        .eq('borrower_user_id', user.id)
        .order('created_at', { ascending: false }) as any);
      if (claimsData?.length) {
        setClaims(claimsData as Claim[]);
        const ids = [...new Set((claimsData as Claim[]).map(c => c.lender_partner_id))];
        const { data: partnersData } = await (supabase
          .from('lender_partners' as any)
          .select('id, legal_name')
          .in('id', ids) as any);
        if (partnersData) {
          const map: Record<string, PartnerLite> = {};
          (partnersData as PartnerLite[]).forEach(p => { map[p.id] = p; });
          setPartners(map);
        }
      }
      setLoading(false);
    })();
  }, [user]);

  if (loading) return <div className="flex justify-center py-2"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  if (claims.length === 0) return null;

  const statusColor = (s: string) =>
    s === 'repaid' ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30' :
    s === 'defaulted' || s === 'claim_paid' ? 'bg-destructive/10 text-destructive border-destructive/30' :
    s === 'disputed' ? 'bg-amber-500/10 text-amber-700 border-amber-500/30' :
    'bg-primary/10 text-primary border-primary/30';

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Banknote className="h-4 w-4 text-primary" />
          <p className="text-sm font-bold">My Vouched Loans ({claims.length})</p>
        </div>
        <div className="space-y-2">
          {claims.map((c) => (
            <div key={c.id} className="p-3 rounded-lg bg-muted/40 border border-border/50">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{formatUGX(c.principal_ugx)}</p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {partners[c.lender_partner_id]?.legal_name || 'Lender'}
                  </p>
                </div>
                <Badge variant="outline" className={`text-[10px] capitalize ${statusColor(c.status)}`}>
                  {c.status.replace(/_/g, ' ')}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2 text-[10px] text-muted-foreground">
                <div>Vouched: <span className="font-medium text-foreground">{formatUGX(c.vouched_amount_ugx)}</span></div>
                <div>Disbursed: <span className="font-medium text-foreground">{new Date(c.disbursement_date).toLocaleDateString()}</span></div>
                {c.expected_repayment_date && (
                  <div className="col-span-2">Due: <span className="font-medium text-foreground">{new Date(c.expected_repayment_date).toLocaleDateString()}</span></div>
                )}
                {c.loan_purpose && <div className="col-span-2 truncate">Purpose: {c.loan_purpose}</div>}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
