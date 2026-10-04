import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Phone, User, ChevronRight, X, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/UserAvatar';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface FoundUser {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  avatar_url: string | null;
  verified: boolean;
  created_at: string;
  roles: string[];
  roleEnabledStatus: Record<string, boolean>;
  rent_discount_active: boolean;
  monthly_rent: number | null;
  average_rating: number | null;
  rating_count: number;
  country: string | null;
  city: string | null;
  country_code: string | null;
  subagent_count: number;
  last_active_at: string | null;
}

interface QuickUserLookupProps {
  onUserFound: (user: FoundUser) => void;
}

export function QuickUserLookup({ onUserFound }: QuickUserLookupProps) {
  const [phone, setPhone] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<FoundUser[]>([]);
  const [searched, setSearched] = useState(false);

  const normalizePhone = (input: string) => {
    const digits = input.replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(-9) : digits;
  };

  const handleSearch = useCallback(async () => {
    const normalized = normalizePhone(phone);
    if (normalized.length < 7) {
      toast.error('Enter at least 7 digits');
      return;
    }

    setSearching(true);
    setSearched(true);
    setResults([]);

    try {
      // Use exact-match IN query — uses btree index, no full-table scan
      const phoneFormats = [normalized, `0${normalized}`, `256${normalized}`, `+256${normalized}`];
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, avatar_url, verified, created_at, last_active_at')
        .in('phone', phoneFormats)
        .limit(20);

      if (error) throw error;

      if (!profiles || profiles.length === 0) {
        setResults([]);
        setSearching(false);
        return;
      }

      // Fetch roles for found users
      const userIds = profiles.map(p => p.id);
      const { data: roleRows } = await supabase
        .from('user_roles')
        .select('user_id, role, enabled')
        .in('user_id', userIds);

      const rolesMap = new Map<string, { roles: string[]; enabledMap: Record<string, boolean> }>();
      roleRows?.forEach(r => {
        if (!rolesMap.has(r.user_id)) rolesMap.set(r.user_id, { roles: [], enabledMap: {} });
        const entry = rolesMap.get(r.user_id)!;
        entry.roles.push(r.role);
        entry.enabledMap[r.role] = r.enabled;
      });

      const users: FoundUser[] = profiles.map(p => {
        const rm = rolesMap.get(p.id);
        return {
          ...p,
          roles: rm?.roles || [],
          roleEnabledStatus: rm?.enabledMap || {},
          rent_discount_active: false,
          monthly_rent: null,
          average_rating: null,
          rating_count: 0,
          country: null,
          city: null,
          country_code: null,
          subagent_count: 0,
          last_active_at: p.last_active_at || null,
        };
      });

      setResults(users);

      // Auto-open details if exactly one result
      if (users.length === 1) {
        onUserFound(users[0]);
      }
    } catch (err) {
      console.error('User lookup error:', err);
      toast.error('Search failed');
    } finally {
      setSearching(false);
    }
  }, [phone]);

  const handleClear = () => {
    setPhone('');
    setResults([]);
    setSearched(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const formatPhone = (ph: string) => {
    const digits = ph.replace(/\D/g, '');
    if (digits.length >= 9) {
      const last9 = digits.slice(-9);
      return `+256 ${last9.slice(0, 3)} ${last9.slice(3, 6)} ${last9.slice(6)}`;
    }
    return ph;
  };

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-primary/[0.02] shadow-sm overflow-hidden">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-primary/15">
            <Search className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="font-semibold text-sm text-foreground">Quick User Lookup</p>
            <p className="text-[10px] text-muted-foreground">Search by phone number to view & edit profile</p>
          </div>
        </div>

        {/* Search Input */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="0771234567 or +256..."
              value={phone}
              onChange={e => setPhone(e.target.value)}
              onKeyDown={handleKeyDown}
              className="pl-9 h-10 font-mono text-sm"
              type="tel"
              inputMode="tel"
            />
            {phone && (
              <button
                onClick={handleClear}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-muted transition-colors"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          <Button
            onClick={handleSearch}
            disabled={searching || normalizePhone(phone).length < 7}
            size="default"
            className="h-10 px-4 shrink-0"
          >
            {searching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
          </Button>
        </div>

        {/* Results */}
        <AnimatePresence mode="wait">
          {searching && (
            <motion.div
              key="loading"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center justify-center py-4"
            >
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">Searching...</span>
            </motion.div>
          )}

          {!searching && searched && results.length === 0 && (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="rounded-lg bg-muted/50 p-4 text-center"
            >
              <User className="h-8 w-8 text-muted-foreground/40 mx-auto mb-1.5" />
              <p className="text-sm text-muted-foreground">No user found with that number</p>
            </motion.div>
          )}

          {!searching && results.length > 0 && (
            <motion.div
              key="results"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="space-y-1.5"
            >
              {results.length > 1 && (
                <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                  {results.length} users found
                </p>
              )}
              {results.map(user => (
                <div
                  key={user.id}
                  onClick={() => onUserFound(user)}
                  className={cn(
                    "flex items-center gap-3 p-3 rounded-xl border border-border/60",
                    "bg-card hover:bg-muted/40 active:bg-muted/60",
                    "transition-all cursor-pointer touch-manipulation"
                  )}
                >
                  <UserAvatar
                    avatarUrl={user.avatar_url}
                    fullName={user.full_name}
                    size="md"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-foreground truncate">{user.full_name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{formatPhone(user.phone)}</p>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {user.roles.slice(0, 3).map(r => (
                        <Badge key={r} variant="outline" className="text-[9px] capitalize h-4 px-1.5">
                          {r.replace('_', ' ')}
                        </Badge>
                      ))}
                      {user.roles.length > 3 && (
                        <Badge variant="outline" className="text-[9px] h-4 px-1.5">
                          +{user.roles.length - 3}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}
