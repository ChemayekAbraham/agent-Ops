import { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { useConversation, Message } from '@/hooks/useChat';
import { useAuth } from '@/hooks/useAuth';
import { usePresenceContext } from '@/hooks/usePresence';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, Send, Check, CheckCheck, Pencil, Trash2, X, Clock, WifiOff } from 'lucide-react';
import ReadReceipt from './ReadReceipt';
import { format, isToday, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';
import OnlineIndicator from './OnlineIndicator';
import MessageReactions from './MessageReactions';
import PendingMessageIndicator from './PendingMessageIndicator';
import TypingIndicator from './TypingIndicator';
import { AnimatePresence } from 'framer-motion';
import { 
  getCachedMessages, 
  cacheMessages, 
  queuePendingMessage, 
  getPendingMessagesForConversation,
  removePendingMessage 
} from '@/lib/offlineStorage';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

const UserDetailsDialog = lazy(() => 
  import('@/components/manager/UserDetailsDialog').then(mod => ({
    default: (props: any) => <mod.default {...props} />
  }))
);

interface PendingMessage {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
  status: 'pending' | 'sending' | 'failed';
}

interface ChatWindowProps {
  conversationId: string;
  onBack?: () => void;
  isOffline?: boolean;
}

export default function ChatWindow({ conversationId, onBack, isOffline = false }: ChatWindowProps) {
  const { user, roles } = useAuth();
  const isManager = roles?.includes('manager');
  const { isOnline } = usePresenceContext();
  const { 
    messages, 
    loading, 
    otherParticipant, 
    sendMessage, 
    editMessage,
    deleteMessage,
    canEditMessage,
    fetchMessages
  } = useConversation(conversationId);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [cachedMessages, setCachedMessages] = useState<Message[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const [selectedChatUser, setSelectedChatUser] = useState<any>(null);

  const handleOpenUserDetails = async (userId: string) => {
    if (!isManager) return;
    try {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, avatar_url, rent_discount_active, monthly_rent, roles, average_rating, rating_count, verified')
        .eq('id', userId)
        .single();
      if (data) {
        setSelectedChatUser(data);
      }
    } catch (err) {
      console.error('Failed to fetch user details:', err);
    }
  };
  // Load cached messages on mount
  useEffect(() => {
    getCachedMessages(conversationId).then(cached => {
      if (cached.length > 0) {
        setCachedMessages(cached as Message[]);
      }
    });
    getPendingMessagesForConversation(conversationId).then(pending => {
      setPendingMessages(pending);
    });
  }, [conversationId]);

  // Cache messages when they change
  useEffect(() => {
    if (messages.length > 0 && !isOffline) {
      cacheMessages(conversationId, messages);
      setCachedMessages(messages);
    }
  }, [messages, conversationId, isOffline]);

  // Use cached data when offline
  const displayMessages = isOffline ? cachedMessages : messages;

  useEffect(() => {
    // Scroll to bottom when messages change
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [displayMessages, pendingMessages]);

  const handleSend = async () => {
    if (!newMessage.trim() || sending) return;

    // If offline, queue the message
    if (isOffline) {
      const pendingMsg: PendingMessage = {
        id: `pending-${Date.now()}`,
        conversationId,
        content: newMessage.trim(),
        createdAt: new Date().toISOString(),
        status: 'pending'
      };
      
      await queuePendingMessage(pendingMsg);
      setPendingMessages(prev => [...prev, pendingMsg]);
      setNewMessage('');
      toast.info('Message queued. Will be sent when you\'re back online.');
      return;
    }

    setSending(true);
    const success = await sendMessage(newMessage);
    if (success) {
      setNewMessage('');
    }
    setSending(false);
    inputRef.current?.focus();
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const startEditing = (msg: Message) => {
    setEditingMessageId(msg.id);
    setEditContent(msg.content);
    setTimeout(() => editInputRef.current?.focus(), 0);
  };

  const cancelEditing = () => {
    setEditingMessageId(null);
    setEditContent('');
  };

  const handleEditSave = async () => {
    if (!editingMessageId || !editContent.trim()) return;
    
    const success = await editMessage(editingMessageId, editContent);
    if (success) {
      cancelEditing();
    }
  };

  const handleEditKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleEditSave();
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    await deleteMessage(messageId);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value);
  };

  const isOtherTyping = false;

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

  const formatMessageDate = (dateStr: string) => {
    const date = new Date(dateStr);
    if (isToday(date)) {
      return format(date, 'HH:mm');
    } else if (isYesterday(date)) {
      return 'Yesterday ' + format(date, 'HH:mm');
    }
    return format(date, 'MMM d, HH:mm');
  };

  const groupMessagesByDate = (msgs: Message[]) => {
    const groups: { date: string; messages: Message[] }[] = [];
    let currentDate = '';

    msgs.forEach(msg => {
      const msgDate = format(new Date(msg.created_at), 'yyyy-MM-dd');
      if (msgDate !== currentDate) {
        currentDate = msgDate;
        groups.push({ date: msgDate, messages: [msg] });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    });

    return groups;
  };

  const formatGroupDate = (dateStr: string) => {
    const date = new Date(dateStr);
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'MMMM d, yyyy');
  };

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 border-b flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
        <div className="flex-1 p-4 space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className={`flex ${i % 2 === 0 ? 'justify-end' : ''}`}>
              <Skeleton className="h-12 w-48 rounded-xl" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b flex items-center gap-3 shrink-0">
        {onBack && (
          <Button variant="ghost" size="icon" onClick={onBack} className="md:hidden">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        {otherParticipant && (
          <>
            <div className="relative">
              <Avatar className="h-10 w-10">
                <AvatarImage src={otherParticipant.avatar_url || undefined} />
                <AvatarFallback>{getInitials(otherParticipant.full_name)}</AvatarFallback>
              </Avatar>
              {!isOffline && (
                <OnlineIndicator 
                  isOnline={isOnline(otherParticipant.user_id)} 
                  size="md"
                  className="absolute bottom-0 right-0"
                />
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span 
                  className={cn("font-semibold", isManager && "underline decoration-dotted cursor-pointer active:opacity-70")}
                  onClick={() => isManager && handleOpenUserDetails(otherParticipant.user_id)}
                >{otherParticipant.full_name}</span>
                {!isOffline && isOnline(otherParticipant.user_id) && (
                  <span className="text-xs text-success font-medium">Online</span>
                )}
                {isOffline && (
                  <span className="text-xs text-amber-600 font-medium flex items-center gap-1">
                    <WifiOff className="h-3 w-3" />
                    Offline mode
                  </span>
                )}
              </div>
              <div className="flex gap-1 flex-wrap">
                {otherParticipant.roles.map(role => (
                  <Badge key={role} className={`text-[10px] h-4 ${getRoleBadgeColor(role)}`}>
                    {role}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {groupMessagesByDate(displayMessages).map(group => (
            <div key={group.date}>
              <div className="flex justify-center mb-4">
                <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">
                  {formatGroupDate(group.date)}
                </span>
              </div>
              <div className="space-y-3">
                {group.messages.map((msg) => {
                  const isOwn = msg.sender_id === user?.id;
                  const isEditing = editingMessageId === msg.id;
                  const canEdit = isOwn && canEditMessage(msg) && !isOffline;
                  
                  return (
                    <div
                      key={msg.id}
                      className={`flex ${isOwn ? 'justify-end' : 'justify-start'} group`}
                    >
                      <div className={`flex gap-2 max-w-[80%] ${isOwn ? 'flex-row-reverse' : ''}`}>
                        {!isOwn && msg.sender && (
                          <Avatar className="h-8 w-8 shrink-0">
                            <AvatarImage src={msg.sender.avatar_url || undefined} />
                            <AvatarFallback className="text-xs">
                              {getInitials(msg.sender.full_name)}
                            </AvatarFallback>
                          </Avatar>
                        )}
                        <div className="relative">
                          {!isOwn && msg.sender && (
                            <div className="flex items-center gap-1 mb-1">
                              <span 
                                className={cn("text-xs font-medium", isManager && "underline decoration-dotted cursor-pointer active:opacity-70")}
                                onClick={() => isManager && handleOpenUserDetails(msg.sender_id)}
                              >{msg.sender.full_name}</span>
                              {msg.sender.roles.length > 0 && (
                                <Badge className={`text-[8px] h-3 px-1 ${getRoleBadgeColor(msg.sender.roles[0])}`}>
                                  {msg.sender.roles[0]}
                                </Badge>
                              )}
                            </div>
                          )}
                          
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <Input
                                ref={editInputRef}
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                onKeyDown={handleEditKeyPress}
                                className="min-w-[200px]"
                              />
                              <Button size="icon" variant="ghost" onClick={handleEditSave} className="h-8 w-8">
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button size="icon" variant="ghost" onClick={cancelEditing} className="h-8 w-8">
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : (
                            <div
                              className={cn(
                                "rounded-2xl px-4 py-2",
                                isOwn
                                  ? 'bg-primary text-primary-foreground rounded-br-md'
                                  : 'bg-muted rounded-bl-md'
                              )}
                            >
                              <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                            </div>
                          )}
                          
                          {/* Edit/Delete buttons for own messages */}
                          {canEdit && !isEditing && (
                            <div className={cn(
                              "absolute top-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity",
                              isOwn ? "right-full mr-2" : "left-full ml-2"
                            )}>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => startEditing(msg)}
                                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => handleDeleteMessage(msg.id)}
                                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                          
                          {/* Reactions */}
                          {!isOffline && (
                            <MessageReactions
                              messageId={msg.id}
                              reactions={msg.reactions || []}
                              isOwn={isOwn}
                              onReactionChange={fetchMessages}
                            />
                          )}
                          
                          <div className={`flex items-center gap-1.5 ${isOwn ? 'justify-end' : ''}`}>
                            <p className="text-[10px] text-muted-foreground">
                              {formatMessageDate(msg.created_at)}
                            </p>
                            <ReadReceipt 
                              sentAt={msg.created_at} 
                              readAt={msg.read_at} 
                              isOwn={isOwn} 
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          
          {/* Pending messages (queued while offline) */}
          {pendingMessages.map((pending) => (
            <div key={pending.id} className="flex justify-end">
              <div className="flex gap-2 max-w-[80%] flex-row-reverse">
                <div className="relative">
                  <div className="rounded-2xl px-4 py-2 bg-primary/60 text-primary-foreground rounded-br-md">
                    <p className="text-sm whitespace-pre-wrap break-words">{pending.content}</p>
                  </div>
                  <div className="flex items-center gap-1.5 justify-end">
                    <PendingMessageIndicator status={pending.status} />
                  </div>
                </div>
              </div>
            </div>
          ))}
          
          {/* Typing indicator */}
          <AnimatePresence>
            {!isOffline && isOtherTyping && otherParticipant && (
              <div className="flex justify-start">
                <div className="flex gap-2 items-center">
                  <Avatar className="h-8 w-8 shrink-0">
                    <AvatarImage src={otherParticipant.avatar_url || undefined} />
                    <AvatarFallback className="text-xs">
                      {getInitials(otherParticipant.full_name)}
                    </AvatarFallback>
                  </Avatar>
                  <TypingIndicator name={otherParticipant.full_name} variant="bubble" />
                </div>
              </div>
            )}
          </AnimatePresence>
          
          <div ref={scrollRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="p-4 border-t shrink-0">
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            placeholder={isOffline ? "Type a message (will send when online)..." : "Type a message..."}
            value={newMessage}
            onChange={onInputChange}
            onKeyPress={handleKeyPress}
            disabled={sending}
            className="flex-1"
          />
          <Button
            onClick={handleSend}
            disabled={!newMessage.trim() || sending}
            size="icon"
            variant={isOffline ? "outline" : "default"}
          >
            {isOffline ? <Clock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        {isOffline && pendingMessages.length > 0 && (
          <p className="text-xs text-muted-foreground mt-2 text-center">
            {pendingMessages.length} message{pendingMessages.length > 1 ? 's' : ''} queued
          </p>
        )}
      </div>

      {/* User Details Dialog for Managers */}
      {isManager && (
        <Suspense fallback={null}>
          <UserDetailsDialog
            open={!!selectedChatUser}
            onOpenChange={(open) => { if (!open) setSelectedChatUser(null); }}
            user={selectedChatUser}
          />
        </Suspense>
      )}
    </div>
  );
}
