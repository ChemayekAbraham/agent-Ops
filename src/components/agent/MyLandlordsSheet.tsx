import { useEffect, useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Building2,
  MapPin,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search,
  Phone,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

interface MyLandlordsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface LandlordRow {
  id: string;
  name: string | null;
  phone: string | null;
  property_address: string | null;
  district: string | null;
  region: string | null;
  village: string | null;
  verified: boolean | null;
  ready_to_receive: boolean | null;
  verification_status: string | null;
  created_at: string;
}

const PAGE_SIZE = 8;

function getStatus(l: LandlordRow): { label: string; className: string } {
  if (l.ready_to_receive) {
    return { label: 'Ready to Receive', className: 'bg-success/10 text-success border-success/30' };
  }
  if (l.verified) {
    return { label: 'Verified', className: 'bg-primary/10 text-primary border-primary/30' };
  }
  if (l.verification_status === 'rejected') {
    return { label: 'Rejected', className: 'bg-destructive/10 text-destructive border-destructive/30' };
  }
  return { label: 'Pending Verification', className: 'bg-muted text-muted-foreground border-border' };
}

function locationText(l: LandlordRow): string {
  const parts = [l.village, l.district, l.region].filter(Boolean);
  if (parts.length > 0) return parts.join(', ');
  return l.property_address || 'No location';
}

export function MyLandlordsSheet({ open, onOpenChange }: MyLandlordsSheetProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<LandlordRow[]>([]);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    setLoading(true);
    // Single round trip — fetch every landlord this agent registered or manages.
    (async () => {
      const { data, error } = await supabase
        .from('landlords')
        .select(
          'id, name, phone, property_address, district, region, village, verified, ready_to_receive, verification_status, created_at',
        )
        .or(`registered_by.eq.${user.id},managed_by_agent_id.eq.${user.id}`)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setRows(data as LandlordRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user?.id]);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (l) =>
        (l.name || '').toLowerCase().includes(q) ||
        (l.phone || '').toLowerCase().includes(q) ||
        locationText(l).toLowerCase().includes(q),
    );
  }, [rows, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl overflow-y-auto pb-8">
        <SheetHeader className="pb-4 border-b border-border mb-4">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <Building2 className="h-5 w-5 text-primary" />
            My Landlords
            {!loading && (
              <Badge variant="secondary" className="ml-1">
                {rows.length}
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, phone or location"
            className="pl-9"
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading landlords…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <Building2 className="h-10 w-10 mb-3 opacity-40" />
            <p className="font-medium">No landlords yet</p>
            <p className="text-sm">Landlords you register or refer will appear here.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {pageRows.map((l) => {
                const status = getStatus(l);
                return (
                  <div
                    key={l.id}
                    className="rounded-xl border border-border/60 bg-card p-4 flex flex-col gap-2 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold truncate">{l.name || 'Unnamed landlord'}</p>
                        {l.phone && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                            <Phone className="h-3 w-3" /> {l.phone}
                          </p>
                        )}
                      </div>
                      <Badge variant="outline" className={cn('shrink-0 text-[10px]', status.className)}>
                        {status.label}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground flex items-start gap-1">
                      <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span className="line-clamp-2">{locationText(l)}</span>
                    </p>
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" /> Prev
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}