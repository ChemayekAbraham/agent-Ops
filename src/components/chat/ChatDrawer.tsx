import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useChat } from '@/hooks/useChat';
import { usePresenceContext } from '@/hooks/usePresence';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, Search, MessageCircle, ArrowRight, X } from 'lucide-react';
import { toast } from 'sonner';
import OnlineIndicator from './OnlineIndicator';
import { formatDistanceToNow } from 'date-fns';
import { hapticTap } from '@/lib/haptics';

interface UserProfile {
  id: string;
  full_name: string;
  avatar_url: string | null;
  roles: string[];
}

interface Conversation {
  id: string;
  participant: {
    id: string;
    full_name: string;
    avatar_url: string | null;
  };
  lastMessage?: {
    content: string;
    created_at: string;
  };
  unreadCount: number;
}

interface ChatDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ChatDrawer({ open, onOpenChange }: ChatDrawerProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { startConversation } = useChat();
  const { isOnline } = usePresenceContext();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [startingChat, setStartingChat] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('users');

  useEffect(() => {
    if (!open || !user) return;

    // Chat drawer DB calls stubbed - use cached data from useChat hook
    setLoading(false);
  }, [open, user]);

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
    hapticTap();
    setStartingChat(userId);
    const conversationId = await startConversation(userId);
    
    if (conversationId) {
      onOpenChange(false);
      navigate(`/chat?conversation=${conversationId}`);
    } else {
      toast.error('Failed to start conversation');
    }
    setStartingChat(null);
  };

  const handleConversationClick = (conversationId: string) => {
    hapticTap();
    onOpenChange(false);
    navigate(`/chat?conversation=${conversationId}`);
  };

  const handleViewAllChats = () => {
    hapticTap();
    onOpenChange(false);
    navigate('/chat');
  };

  const filteredUsers = users.filter(u =>
    u.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.roles.some(r => r.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-primary" />
              Chat
            </SheetTitle>
            <Button variant="ghost" size="sm" onClick={handleViewAllChats} className="text-xs">
              View All <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        </SheetHeader>

        {/* Search */}
        <div className="px-4 py-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
          <TabsList className="grid w-full grid-cols-2 mx-4 mt-2" style={{ width: 'calc(100% - 32px)' }}>
            <TabsTrigger value="users" className="text-xs">
              <Users className="h-3 w-3 mr-1" /> All Users
            </TabsTrigger>
            <TabsTrigger value="chats" className="text-xs relative">
              <MessageCircle className="h-3 w-3 mr-1" /> Recent Chats
              {conversations.reduce((acc, c) => acc + c.unreadCount, 0) > 0 && (
                <span className="ml-1 bg-destructive text-destructive-foreground text-[10px] px-1.5 rounded-full">
                  {conversations.reduce((acc, c) => acc + c.unreadCount, 0)}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="flex-1 mt-0 overflow-hidden">
            <ScrollArea className="h-full">
              {loading ? (
                <div className="space-y-3 p-4">
                  {[1, 2, 3, 4, 5].map(i => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-12 w-12 rounded-full" />
                      <div className="flex-1 space-y-1">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-3 w-16" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : filteredUsers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                  <div className="p-4 rounded-full bg-muted mb-4">
                    <Users className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <h3 className="font-semibold mb-1">No users found</h3>
                  <p className="text-sm text-muted-foreground">
                    {searchQuery ? 'Try a different search term' : 'No other users in the app yet'}
                  </p>
                </div>
              ) : (
                <div className="divide-y">
                  {filteredUsers.map((userProfile) => (
                    <button
                      key={userProfile.id}
                      onClick={() => handleUserClick(userProfile.id)}
                      disabled={startingChat === userProfile.id}
                      className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left disabled:opacity-50 active:bg-muted"
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
                          size="md"
                          className="absolute bottom-0 right-0"
                        />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <span className="font-medium block truncate">
                          {userProfile.full_name}
                        </span>
                        {userProfile.roles.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {userProfile.roles.slice(0, 3).map(role => (
                              <Badge 
                                key={role} 
                                className={`text-[10px] h-4 px-1.5 ${getRoleBadgeColor(role)}`}
                              >
                                {role}
                              </Badge>
                            ))}
                            {userProfile.roles.length > 3 && (
                              <Badge className="text-[10px] h-4 px-1.5 bg-muted text-muted-foreground">
                                +{userProfile.roles.length - 3}
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>

                      <MessageCircle className="h-5 w-5 text-primary shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="chats" className="flex-1 mt-0 overflow-hidden">
            <ScrollArea className="h-full">
              {loading ? (
                <div className="space-y-3 p-4">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-12 w-12 rounded-full" />
                      <div className="flex-1 space-y-1">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-3 w-40" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : conversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                  <div className="p-4 rounded-full bg-muted mb-4">
                    <MessageCircle className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <h3 className="font-semibold mb-1">No conversations yet</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Tap on a user to start chatting
                  </p>
                  <Button variant="outline" size="sm" onClick={() => setActiveTab('users')}>
                    Browse Users
                  </Button>
                </div>
              ) : (
                <div className="divide-y">
                  {conversations.map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => handleConversationClick(conv.id)}
                      className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left active:bg-muted"
                    >
                      <div className="relative">
                        <Avatar className="h-12 w-12">
                          <AvatarImage src={conv.participant.avatar_url || undefined} />
                          <AvatarFallback className="bg-primary/10 text-primary">
                            {getInitials(conv.participant.full_name)}
                          </AvatarFallback>
                        </Avatar>
                        <OnlineIndicator 
                          isOnline={isOnline(conv.participant.id)} 
                          size="md"
                          className="absolute bottom-0 right-0"
                        />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate">
                            {conv.participant.full_name}
                          </span>
                          {conv.lastMessage && (
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {formatDistanceToNow(new Date(conv.lastMessage.created_at), { addSuffix: true })}
                            </span>
                          )}
                        </div>
                        {conv.lastMessage && (
                          <p className="text-sm text-muted-foreground truncate mt-0.5">
                            {conv.lastMessage.content}
                          </p>
                        )}
                      </div>

                      {conv.unreadCount > 0 && (
                        <Badge className="bg-primary text-primary-foreground h-5 min-w-5 px-1.5 shrink-0">
                          {conv.unreadCount}
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
