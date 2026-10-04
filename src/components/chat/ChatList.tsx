import { useState, useEffect, useMemo } from 'react';
import { useChat, Conversation } from '@/hooks/useChat';
import { usePresenceContext } from '@/hooks/usePresence';
import { useGlobalTyping } from '@/hooks/useGlobalTyping';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { MessageCircle, Users, PlusCircle, WifiOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import NewChatSearch from './NewChatSearch';
import OnlineIndicator from './OnlineIndicator';
import TypingIndicator from './TypingIndicator';
import { AnimatePresence } from 'framer-motion';
import { getCachedConversations, cacheConversations } from '@/lib/offlineStorage';

interface ChatListProps {
  onSelectConversation: (conversationId: string) => void;
  selectedId?: string;
  isOffline?: boolean;
}

export default function ChatList({ onSelectConversation, selectedId, isOffline = false }: ChatListProps) {
  const { conversations, loading } = useChat();
  const { isOnline } = usePresenceContext();
  const [activeTab, setActiveTab] = useState<string>('chats');
  const [cachedConversations, setCachedConversations] = useState<Conversation[]>([]);

  // Get conversation IDs for global typing tracker
  const conversationIds = useMemo(() => 
    conversations.map(c => c.id), 
    [conversations]
  );
  const { isTypingInConversation } = useGlobalTyping(conversationIds);

  // Load cached conversations on mount
  useEffect(() => {
    getCachedConversations().then(cached => {
      if (cached.length > 0) {
        setCachedConversations(cached as Conversation[]);
      }
    });
  }, []);

  // Cache conversations when they change
  useEffect(() => {
    if (conversations.length > 0 && !isOffline) {
      cacheConversations(conversations);
      setCachedConversations(conversations);
    }
  }, [conversations, isOffline]);

  // Use cached data when offline
  const displayConversations = isOffline ? cachedConversations : conversations;

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

  const handleStartConversation = (conversationId: string) => {
    setActiveTab('chats');
    onSelectConversation(conversationId);
  };

  const renderConversationsList = () => {
    if (loading) {
      return (
        <div className="space-y-3 p-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (displayConversations.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-center px-4">
          <div className="p-4 rounded-full bg-muted mb-4">
            {isOffline ? (
              <WifiOff className="h-8 w-8 text-muted-foreground" />
            ) : (
              <MessageCircle className="h-8 w-8 text-muted-foreground" />
            )}
          </div>
          <h3 className="font-semibold mb-1">
            {isOffline ? 'No cached conversations' : 'No conversations yet'}
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            {isOffline 
              ? 'Your conversations will appear here when you go online'
              : 'Tap "New Chat" to start chatting with someone'
            }
          </p>
          {!isOffline && (
            <Button onClick={() => setActiveTab('new')} className="gap-2">
              <PlusCircle className="h-4 w-4" />
              Start New Chat
            </Button>
          )}
        </div>
      );
    }

    return (
      <ScrollArea className="h-full">
        <div className="divide-y">
          {displayConversations.map((conv) => {
            const participant = conv.participants[0];
            if (!participant) return null;
            
            const typingUser = !isOffline ? isTypingInConversation(conv.id) : null;

            return (
              <button
                key={conv.id}
                onClick={() => onSelectConversation(conv.id)}
                className={`w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left ${
                  selectedId === conv.id ? 'bg-muted' : ''
                }`}
              >
                <div className="relative">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={participant.avatar_url || undefined} />
                    <AvatarFallback>{getInitials(participant.full_name)}</AvatarFallback>
                  </Avatar>
                  {conv.unread_count > 0 ? (
                    <div className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-bold">
                      {conv.unread_count > 9 ? '9+' : conv.unread_count}
                    </div>
                  ) : (
                    !isOffline && (
                      <OnlineIndicator 
                        isOnline={isOnline(participant.user_id)} 
                        size="md"
                        className="absolute bottom-0 right-0"
                      />
                    )
                  )}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-semibold truncate">{participant.full_name}</span>
                    {participant.roles.length > 0 && (
                      <Badge className={`text-[10px] h-4 ${getRoleBadgeColor(participant.roles[0])}`}>
                        {participant.roles[0]}
                      </Badge>
                    )}
                  </div>
                  
                  {/* Show typing indicator or last message */}
                  <AnimatePresence mode="wait">
                    {typingUser ? (
                      <TypingIndicator 
                        key="typing"
                        name={participant.full_name.split(' ')[0]} 
                        variant="inline" 
                      />
                    ) : conv.last_message ? (
                      <p key="message" className="text-sm text-muted-foreground truncate">
                        {conv.last_message.content}
                      </p>
                    ) : null}
                  </AnimatePresence>
                </div>

                <div className="text-xs text-muted-foreground shrink-0">
                  {conv.last_message && formatDistanceToNow(new Date(conv.last_message.created_at), { addSuffix: true })}
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    );
  };

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
      <TabsList className="grid w-full grid-cols-3 mx-4 mt-2" style={{ width: 'calc(100% - 2rem)' }}>
        <TabsTrigger value="chats" className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4" />
          Chats
        </TabsTrigger>
        <TabsTrigger value="new" className="flex items-center gap-2" disabled={isOffline}>
          <PlusCircle className="h-4 w-4" />
          New Chat
        </TabsTrigger>
        <TabsTrigger value="users" className="flex items-center gap-2" disabled={isOffline}>
          <Users className="h-4 w-4" />
          All Users
        </TabsTrigger>
      </TabsList>
      
      <TabsContent value="chats" className="flex-1 mt-2 overflow-hidden">
        {renderConversationsList()}
      </TabsContent>

      <TabsContent value="new" className="flex-1 mt-2 overflow-hidden">
        {!isOffline && (
          <NewChatSearch 
            onStartConversation={handleStartConversation} 
            onClose={() => setActiveTab('chats')}
          />
        )}
      </TabsContent>
      
      <TabsContent value="users" className="flex-1 mt-2 overflow-hidden">
        {!isOffline && (
          <NewChatSearch 
            onStartConversation={handleStartConversation}
          />
        )}
      </TabsContent>
    </Tabs>
  );
}