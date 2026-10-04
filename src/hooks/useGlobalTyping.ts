import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

interface TypingUser {
  conversationId: string;
  userId: string;
  userName: string;
  timestamp: number;
}

// Global state to track typing users across all conversations
export function useGlobalTyping(conversationIds: string[]) {
  const { user } = useAuth();
  const [typingMap, setTypingMap] = useState<Map<string, TypingUser>>(new Map());

  // Clean up stale typing indicators (older than 3 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTypingMap(prev => {
        const newMap = new Map(prev);
        let hasChanges = false;
        
        newMap.forEach((value, key) => {
          if (now - value.timestamp > 3000) {
            newMap.delete(key);
            hasChanges = true;
          }
        });
        
        return hasChanges ? newMap : prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Subscribe to typing events for all conversations
  useEffect(() => {
    if (!user || conversationIds.length === 0) return;

    const channels = conversationIds.map(convId => {
      return supabase
        .channel(`typing-global-${convId}`)
        .on('broadcast', { event: 'typing' }, async (payload) => {
          const { user_id, typing, user_name } = payload.payload as { 
            user_id: string; 
            typing: boolean;
            user_name?: string;
          };
          
          if (user_id === user.id) return;

          const key = `${convId}-${user_id}`;

          setTypingMap(prev => {
            const newMap = new Map(prev);
            
            if (typing) {
              newMap.set(key, {
                conversationId: convId,
                userId: user_id,
                userName: user_name || 'Someone',
                timestamp: Date.now()
              });
            } else {
              newMap.delete(key);
            }
            
            return newMap;
          });
        })
        .subscribe();
    });

    return () => {
      channels.forEach(channel => {
        supabase.removeChannel(channel);
      });
    };
  }, [conversationIds.join(','), user]);

  // Check if someone is typing in a specific conversation
  const isTypingInConversation = useCallback((conversationId: string): TypingUser | null => {
    for (const [key, value] of typingMap.entries()) {
      if (value.conversationId === conversationId) {
        return value;
      }
    }
    return null;
  }, [typingMap]);

  return {
    typingMap,
    isTypingInConversation
  };
}
