import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { 
  cacheConversations, 
  getCachedConversations, 
  cacheMessages, 
  getCachedMessages 
} from '@/lib/offlineStorage';

export interface MessageReaction {
  emoji: string;
  count: number;
  users: string[];
  hasReacted: boolean;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  read_at: string | null;
  sender?: {
    full_name: string;
    avatar_url: string | null;
    roles: string[];
  };
  reactions?: MessageReaction[];
}

export interface Conversation {
  id: string;
  created_at: string;
  updated_at: string;
  participants: {
    user_id: string;
    full_name: string;
    avatar_url: string | null;
    roles: string[];
  }[];
  last_message?: Message;
  unread_count: number;
}

// In-memory profile cache to avoid repeated DB lookups
const profileCache = new Map<string, { full_name: string; avatar_url: string | null }>();
const rolesCache = new Map<string, string[]>();
let profileCacheTime = 0;
const PROFILE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getProfilesAndRoles(userIds: string[]): Promise<{
  profiles: Map<string, { full_name: string; avatar_url: string | null }>;
  roles: Map<string, string[]>;
}> {
  const now = Date.now();
  // Invalidate stale cache
  if (now - profileCacheTime > PROFILE_CACHE_TTL) {
    profileCache.clear();
    rolesCache.clear();
    profileCacheTime = now;
  }

  const uncachedIds = userIds.filter(id => !profileCache.has(id));

  if (uncachedIds.length > 0 && navigator.onLine) {
    const [profilesRes, rolesRes] = await Promise.all([
      supabase.from('profiles').select('id, full_name, avatar_url').in('id', uncachedIds),
      supabase.from('user_roles').select('user_id, role').in('user_id', uncachedIds)
    ]);

    profilesRes.data?.forEach(p => profileCache.set(p.id, { full_name: p.full_name, avatar_url: p.avatar_url }));
    rolesRes.data?.forEach(r => {
      const existing = rolesCache.get(r.user_id) || [];
      rolesCache.set(r.user_id, [...existing, r.role]);
    });
  }

  return { profiles: profileCache, roles: rolesCache };
}

export function useChat() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const lastFetchTime = useRef(0);
  const FETCH_COOLDOWN = 5 * 60 * 1000; // 5 minutes minimum between fetches (aggressive caching)

  const fetchConversations = useCallback(async (force = false) => {
    if (!user) return;

    // Chat reads are now offline-only via IndexedDB cache
    setLoading(true);

    try {
      const cached = await getCachedConversations();
      if (cached.length > 0) {
        setConversations(cached);
      }
    } catch (e) {
      console.warn('[useChat] Cache read failed:', e);
    }

    setLoading(false);
  }, [user]);

  const startConversation = async (otherUserId: string): Promise<string | null> => {
    if (!user) return null;

    // Check existing conversations from local state first (no DB call)
    const existing = conversations.find(c => 
      c.participants.some(p => p.user_id === otherUserId)
    );
    if (existing) return existing.id;

    // Create on server
    const { data: conversationId, error: convError } = await supabase
      .rpc('create_direct_conversation', { other_user_id: otherUserId });

    if (convError || !conversationId) {
      console.error('Failed to create conversation:', convError);
      return null;
    }

    await fetchConversations(true);
    return conversationId;
  };

  useEffect(() => {
    fetchConversations(true);
  }, [fetchConversations]);

  return {
    conversations,
    loading,
    fetchConversations,
    startConversation
  };
}

export function useConversation(conversationId: string | null) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [otherParticipant, setOtherParticipant] = useState<{
    user_id: string;
    full_name: string;
    avatar_url: string | null;
    roles: string[];
  } | null>(null);

  const fetchMessages = useCallback(async () => {
    if (!conversationId || !user) return;

    setLoading(true);

    // Chat message reads are now offline-only via IndexedDB cache
    try {
      const cached = await getCachedMessages(conversationId);
      if (cached.length > 0) {
        setMessages(cached);
      }
    } catch (e) {
      console.warn('[useConversation] Cache read failed:', e);
    }

    setLoading(false);
  }, [conversationId, user]);

  const sendMessage = async (content: string) => {
    if (!conversationId || !user || !content.trim()) return false;

    const { error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: user.id,
        content: content.trim()
      });

    if (error) {
      console.error('Failed to send message:', error);
      toast.error(error.message || 'Failed to send message');
      return false;
    }

    return true;
  };

  const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

  const canEditMessage = (message: Message) => {
    if (message.sender_id !== user?.id) return false;
    return Date.now() - new Date(message.created_at).getTime() < MESSAGE_EDIT_WINDOW_MS;
  };

  const editMessage = async (messageId: string, newContent: string) => {
    if (!user || !newContent.trim()) return false;
    const message = messages.find(m => m.id === messageId);
    if (!message || !canEditMessage(message)) return false;

    const { error } = await supabase
      .from('messages')
      .update({ content: newContent.trim() })
      .eq('id', messageId)
      .eq('sender_id', user.id);

    if (error) return false;
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, content: newContent.trim() } : m));
    return true;
  };

  const deleteMessage = async (messageId: string) => {
    if (!user) return false;
    const message = messages.find(m => m.id === messageId);
    if (!message || !canEditMessage(message)) return false;

    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('id', messageId)
      .eq('sender_id', user.id);

    if (error) return false;
    setMessages(prev => prev.filter(m => m.id !== messageId));
    return true;
  };

  const markMessageAsRead = async (messageId: string) => {
    if (!user) return;
    await supabase.from('messages').update({ read_at: new Date().toISOString() })
      .eq('id', messageId).is('read_at', null);
  };

  const markAllAsRead = useCallback(async () => {
    if (!conversationId || !user) return;
    const { data: unread } = await supabase.from('messages').select('id')
      .eq('conversation_id', conversationId).neq('sender_id', user.id).is('read_at', null);
    if (unread && unread.length > 0) {
      await supabase.from('messages').update({ read_at: new Date().toISOString() })
        .in('id', unread.map(m => m.id));
    }
  }, [conversationId, user]);

  // Realtime subscription — only for messages (single channel)
  useEffect(() => {
    if (!conversationId || !user) return;

    fetchMessages();

    const channel = supabase
      .channel(`messages-${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        async (payload) => {
          const newMessage = payload.new as Message;
          // Use cached profile data (no DB call)
          const profile = profileCache.get(newMessage.sender_id);
          const roles = rolesCache.get(newMessage.sender_id);

          const messageWithSender: Message = {
            ...newMessage,
            sender: {
              full_name: profile?.full_name || 'Unknown',
              avatar_url: profile?.avatar_url || null,
              roles: roles || []
            }
          };

          setMessages(prev => [...prev, messageWithSender]);

          if (newMessage.sender_id !== user.id) {
            await markMessageAsRead(newMessage.id);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const updated = payload.new as Message;
          setMessages(prev => prev.map(m => m.id === updated.id ? { ...m, read_at: updated.read_at } : m));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, user]);

  return {
    messages,
    loading,
    otherParticipant,
    sendMessage,
    editMessage,
    deleteMessage,
    canEditMessage,
    markMessageAsRead,
    markAllAsRead,
    fetchMessages,
  };
}
