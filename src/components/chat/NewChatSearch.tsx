import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useChat } from '@/hooks/useChat';
import { usePresenceContext } from '@/hooks/usePresence';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Users, Search, MessageCircle, Loader2, X, Filter } from 'lucide-react';
import { toast } from 'sonner';
import OnlineIndicator from './OnlineIndicator';
import { cn } from '@/lib/utils';

interface UserProfile {
  id: string;
  full_name: string;
  avatar_url: string | null;
  roles: string[];
}

interface NewChatSearchProps {
  onStartConversation: (conversationId: string) => void;
  onClose?: () => void;
}

const ROLES = ['tenant', 'agent', 'landlord', 'supporter', 'manager'] as const;
type RoleFilter = typeof ROLES[number] | null;

const PAGE_SIZE = 20;

export default function NewChatSearch({ onStartConversation, onClose }: NewChatSearchProps) {
  const { user } = useAuth();
  const { startConversation } = useChat();
  const { isOnline } = usePresenceContext();
  
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<RoleFilter>(null);
  const [startingChat, setStartingChat] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const fetchUsers = useCallback(async (pageNum: number, reset = false) => {
    if (!user) return;

    if (pageNum === 0) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }

    try {
      const from = pageNum * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      // Build query for profiles
      let query = supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .neq('id', user.id)
        .order('full_name', { ascending: true })
        .range(from, to);

      // Apply search filter
      if (searchQuery.trim()) {
        query = query.ilike('full_name', `%${searchQuery.trim()}%`);
      }

      const { data: profiles, error } = await query;

      if (error) {
        console.error('Failed to fetch users:', error);
        return;
      }

      if (!profiles || profiles.length === 0) {
        if (pageNum === 0) {
          setUsers([]);
        }
        setHasMore(false);
        return;
      }

      // Get roles for fetched users
      const userIds = profiles.map(p => p.id);
      const { data: rolesData } = await supabase
        .from('user_roles')
        .select('user_id, role')
        .in('user_id', userIds);

      const rolesMap = new Map<string, string[]>();
      rolesData?.forEach(r => {
        const existing = rolesMap.get(r.user_id) || [];
        rolesMap.set(r.user_id, [...existing, r.role]);
      });

      let usersWithRoles: UserProfile[] = profiles.map(p => ({
        id: p.id,
        full_name: p.full_name,
        avatar_url: p.avatar_url,
        roles: rolesMap.get(p.id) || []
      }));

      // Filter by role if selected
      if (selectedRole) {
        usersWithRoles = usersWithRoles.filter(u => u.roles.includes(selectedRole));
      }

      setHasMore(profiles.length === PAGE_SIZE);

      if (reset || pageNum === 0) {
        setUsers(usersWithRoles);
      } else {
        setUsers(prev => [...prev, ...usersWithRoles]);
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [user, searchQuery, selectedRole]);

  // Reset and fetch when filters change
  useEffect(() => {
    setPage(0);
    setHasMore(true);
    fetchUsers(0, true);
  }, [searchQuery, selectedRole, user]);

  // Infinite scroll observer
  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
          const nextPage = page + 1;
          setPage(nextPage);
          fetchUsers(nextPage);
        }
      },
      { threshold: 0.1 }
    );

    if (loadMoreRef.current) {
      observerRef.current.observe(loadMoreRef.current);
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [hasMore, loading, loadingMore, page, fetchUsers]);

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'manager': return 'bg-primary text-primary-foreground';
      case 'agent': return 'bg-amber-500 text-white';
      case 'supporter': return 'bg-success text-success-foreground';
      case 'landlord': return 'bg-blue-500 text-white';
      case 'tenant': return 'bg-muted text-muted-foreground';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const handleUserClick = async (userId: string) => {
    setStartingChat(userId);
    const conversationId = await startConversation(userId);
    
    if (conversationId) {
      onStartConversation(conversationId);
    } else {
      toast.error('Failed to start conversation');
    }
    setStartingChat(null);
  };

  const handleRoleFilter = (role: RoleFilter) => {
    setSelectedRole(prev => prev === role ? null : role);
  };

  if (loading && page === 0) {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold text-lg">New Chat</h2>
          {onClose && (
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          )}
        </div>
        
        <div className="space-y-3 p-4">
          <Skeleton className="h-10 w-full rounded-lg" />
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map(i => (
              <Skeleton key={i} className="h-8 w-20 rounded-full" />
            ))}
          </div>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="font-semibold text-lg">New Chat</h2>
        {onClose && (
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        )}
      </div>

      {/* Search */}
      <div className="p-3 border-b space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search users by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Role filters */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
          {ROLES.map(role => (
            <Button
              key={role}
              variant={selectedRole === role ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleRoleFilter(role)}
              className={cn(
                "capitalize shrink-0 h-8",
                selectedRole === role && getRoleBadgeColor(role)
              )}
            >
              {role}
            </Button>
          ))}
          {selectedRole && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedRole(null)}
              className="h-8 text-muted-foreground"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Users list */}
      <div className="flex-1 overflow-y-auto">
        {users.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <div className="p-4 rounded-full bg-muted mb-4">
              <Users className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold mb-1">No users found</h3>
            <p className="text-sm text-muted-foreground">
              {searchQuery || selectedRole 
                ? 'Try adjusting your search or filters' 
                : 'No other users in the app yet'}
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {users.map((userProfile) => (
              <button
                key={userProfile.id}
                onClick={() => handleUserClick(userProfile.id)}
                disabled={startingChat === userProfile.id}
                className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left disabled:opacity-50"
              >
                <div className="relative">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={userProfile.avatar_url || undefined} />
                    <AvatarFallback className="bg-primary/10 text-primary">
                      {getInitials(userProfile.full_name)}
                    </AvatarFallback>
                  </Avatar>
                  <OnlineIndicator 
                    isOnline={isOnline(userProfile.id)} 
                    size="sm"
                    className="absolute bottom-0 right-0"
                  />
                </div>
                
                <div className="flex-1 min-w-0">
                  <span className="font-medium block truncate">
                    {userProfile.full_name}
                  </span>
                  {userProfile.roles.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {userProfile.roles.map(role => (
                        <Badge 
                          key={role} 
                          className={`text-[10px] h-5 px-2 ${getRoleBadgeColor(role)}`}
                        >
                          {role}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                {startingChat === userProfile.id ? (
                  <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
                ) : (
                  <MessageCircle className="h-5 w-5 text-muted-foreground shrink-0" />
                )}
              </button>
            ))}

            {/* Load more trigger */}
            <div ref={loadMoreRef} className="p-4 flex justify-center">
              {loadingMore && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Loading more...</span>
                </div>
              )}
              {!hasMore && users.length > 0 && (
                <span className="text-sm text-muted-foreground">
                  No more users to load
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
