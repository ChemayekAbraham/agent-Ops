import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Users, UserPlus, Calendar, Phone, Wallet, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

interface RegisteredUser {
  id: string;
  full_name: string;
  phone: string;
  avatar_url: string | null;
  created_at: string;
  roles: string[];
  wallet_balance: number;
}

interface UserReferralsSectionProps {
  userId: string;
}

const PAGE_SIZE = 20;

const roleColors: Record<string, string> = {
  tenant: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  agent: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  supporter: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  landlord: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
  manager: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
};

export default function UserReferralsSection({ userId }: UserReferralsSectionProps) {
  const [registeredUsers, setRegisteredUsers] = useState<RegisteredUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRegisteredUsers([]);
    setHasMore(true);
    fetchRegisteredUsers(0, true);
  }, [userId]);

  // Intersection observer for infinite scroll
  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
          fetchRegisteredUsers(registeredUsers.length, false);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, registeredUsers.length]);

  const fetchRegisteredUsers = async (offset: number, isInitial: boolean) => {
    if (isInitial) setLoading(true);
    else setLoadingMore(true);

    try {
      // Get total count on initial load
      if (isInitial) {
        const { count } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('referrer_id', userId);
        setTotalCount(count || 0);
      }

      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, avatar_url, created_at')
        .eq('referrer_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) throw error;

      if (!profiles || profiles.length === 0) {
        setHasMore(false);
        if (isInitial) setRegisteredUsers([]);
        return;
      }

      if (profiles.length < PAGE_SIZE) setHasMore(false);

      // Fetch roles & wallets for this batch
      const userIds = profiles.map(p => p.id);
      const [rolesRes, walletsRes] = await Promise.all([
        supabase.from('user_roles').select('user_id, role').in('user_id', userIds).eq('enabled', true),
        supabase.from('wallets').select('user_id, balance').in('user_id', userIds),
      ]);

      const rolesMap: Record<string, string[]> = {};
      (rolesRes.data || []).forEach(r => {
        if (!rolesMap[r.user_id]) rolesMap[r.user_id] = [];
        rolesMap[r.user_id].push(r.role);
      });

      const walletMap: Record<string, number> = {};
      (walletsRes.data || []).forEach(w => {
        walletMap[w.user_id] = w.balance;
      });

      const enriched: RegisteredUser[] = profiles.map(p => ({
        id: p.id,
        full_name: p.full_name,
        phone: p.phone,
        avatar_url: p.avatar_url,
        created_at: p.created_at,
        roles: rolesMap[p.id] || [],
        wallet_balance: walletMap[p.id] || 0,
      }));

      setRegisteredUsers(prev => isInitial ? enriched : [...prev, ...enriched]);
    } catch (err) {
      console.error('UserReferralsSection fetch error:', err);
    } finally {
      if (isInitial) setLoading(false);
      else setLoadingMore(false);
    }
  };

  const getInitials = (name: string) =>
    name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?';

  if (loading) {
    return (
      <div className="space-y-3 p-1">
        {[1, 2, 3].map(i => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    );
  }

  if (registeredUsers.length === 0 && totalCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <div className="p-4 rounded-full bg-muted/50 mb-3">
          <Users className="h-8 w-8 text-muted-foreground" />
        </div>
        <p className="font-medium text-muted-foreground">No registered users yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          This user hasn't referred anyone to the platform
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="flex items-center gap-2 p-3 rounded-xl bg-primary/5 border border-primary/20">
        <div className="p-2 rounded-lg bg-primary/10">
          <UserPlus className="h-4 w-4 text-primary" />
        </div>
        <div>
          <p className="text-sm font-bold text-primary">{totalCount} user{totalCount !== 1 ? 's' : ''} registered</p>
          <p className="text-xs text-muted-foreground">People this user has brought onto the platform</p>
        </div>
      </div>

      {/* Scrollable user list */}
      <div
        ref={scrollRef}
        className="max-h-[60vh] overflow-y-auto overscroll-contain -mx-1 px-1"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div className="space-y-2">
          {registeredUsers.map((user, index) => (
            <div
              key={user.id}
              className="flex items-center gap-3 p-3 rounded-xl border bg-card hover:bg-muted/30 transition-colors"
            >
              <span className="text-xs font-bold text-muted-foreground w-5 text-center shrink-0">
                {index + 1}
              </span>

              <Avatar className="h-10 w-10 border border-border shrink-0">
                <AvatarImage src={user.avatar_url || undefined} />
                <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
                  {getInitials(user.full_name)}
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate">{user.full_name}</p>
                <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                  <Phone className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                  <span className="text-[10px] text-muted-foreground">{user.phone}</span>
                </div>
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  {user.roles.slice(0, 2).map(role => (
                    <Badge
                      key={role}
                      variant="outline"
                      className={`text-[9px] px-1.5 py-0 capitalize ${roleColors[role] || ''}`}
                    >
                      {role}
                    </Badge>
                  ))}
                  {user.roles.length > 2 && (
                    <span className="text-[9px] text-muted-foreground">+{user.roles.length - 2}</span>
                  )}
                </div>
              </div>

              <div className="text-right shrink-0 space-y-1">
                <div className="flex items-center gap-1 justify-end">
                  <Wallet className="h-3 w-3 text-success" />
                  <span className="text-xs font-bold text-success">{formatUGX(user.wallet_balance)}</span>
                </div>
                <div className="flex items-center gap-1 justify-end text-muted-foreground">
                  <Calendar className="h-2.5 w-2.5" />
                  <span className="text-[10px]">
                    {formatDistanceToNow(new Date(user.created_at), { addSuffix: true })}
                  </span>
                </div>
              </div>
            </div>
          ))}

          {/* Sentinel for infinite scroll */}
          <div ref={sentinelRef} className="h-4" />

          {loadingMore && (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground ml-2">Loading more...</span>
            </div>
          )}

          {!hasMore && registeredUsers.length > 0 && (
            <p className="text-center text-xs text-muted-foreground py-2">
              All {totalCount} referrals loaded
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
