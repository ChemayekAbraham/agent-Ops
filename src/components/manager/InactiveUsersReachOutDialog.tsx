import { useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  MessageCircle, ExternalLink, Check, Clock, 
  Send, Users, AlertCircle
} from 'lucide-react';
import { toast } from 'sonner';
import { parsePhoneNumber } from '@/lib/phoneUtils';
import { hapticSuccess, hapticTap } from '@/lib/haptics';

interface InactiveUser {
  id: string;
  full_name: string;
  phone: string;
  avatar_url: string | null;
  last_active_at: string | null;
}

interface InactiveUsersReachOutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inactiveUsers: InactiveUser[];
}

const DEFAULT_RE_ENGAGEMENT_MESSAGES = [
  {
    id: 'welcome_back',
    label: 'Welcome Back',
    emoji: '👋',
    content: `Hey {first_name}! 👋

We've missed you at Welile! It's been a while since your last visit.

🏠 We've got new properties and exciting features waiting for you.

Tap here to log in and see what's new! 🚀`
  },
  {
    id: 'new_features',
    label: 'New Features',
    emoji: '✨',
    content: `Hi {first_name}! ✨

Great news! We've added some amazing new features to Welile while you were away:

📱 Faster, smoother experience
🏡 More properties available
💰 Better savings options

Come check it out! Your account is waiting.`
  },
  {
    id: 'personal_touch',
    label: 'Personal Touch',
    emoji: '💙',
    content: `Hello {first_name}! 💙

I noticed you haven't been on Welile lately and wanted to personally check in.

Is there anything I can help you with? Whether it's finding a place, rent payments, or just questions - I'm here!

Let's chat whenever you're ready. 😊`
  },
  {
    id: 'incentive',
    label: 'Special Offer',
    emoji: '🎁',
    content: `Hey {first_name}! 🎁

We want you back! As a valued member, you're getting early access to our latest listings.

🏠 New properties just added
⚡ Faster approvals available
💵 Special rates for returning users

Log in now and see what's available!`
  }
];

const getDaysSinceActive = (lastActiveAt: string | null): number => {
  if (!lastActiveAt) return 999;
  const now = new Date();
  const lastActive = new Date(lastActiveAt);
  return Math.floor((now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24));
};

export default function InactiveUsersReachOutDialog({
  open,
  onOpenChange,
  inactiveUsers,
}: InactiveUsersReachOutDialogProps) {
  const [message, setMessage] = useState(DEFAULT_RE_ENGAGEMENT_MESSAGES[0].content);
  const [selectedTemplate, setSelectedTemplate] = useState(DEFAULT_RE_ENGAGEMENT_MESSAGES[0].id);
  const [sendingProgress, setSendingProgress] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const [openedCount, setOpenedCount] = useState(0);

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const replacePlaceholders = (text: string, user: InactiveUser) => {
    const phoneInfo = parsePhoneNumber(user.phone);
    const firstName = user.full_name.split(' ')[0];
    
    return text
      .replace(/{name}/gi, user.full_name)
      .replace(/{first_name}/gi, firstName)
      .replace(/{phone}/gi, phoneInfo.formatted);
  };

  const getWhatsAppLinkWithMessage = (phone: string, user: InactiveUser) => {
    const phoneInfo = parsePhoneNumber(phone);
    const baseLink = phoneInfo.whatsappLink;
    if (message.trim()) {
      const personalizedMessage = replacePlaceholders(message.trim(), user);
      return `${baseLink}?text=${encodeURIComponent(personalizedMessage)}`;
    }
    return baseLink;
  };

  const handleSelectTemplate = (templateId: string) => {
    hapticTap();
    const template = DEFAULT_RE_ENGAGEMENT_MESSAGES.find(t => t.id === templateId);
    if (template) {
      setSelectedTemplate(templateId);
      setMessage(template.content);
    }
  };

  const handleOpenSingleChat = (user: InactiveUser) => {
    hapticTap();
    window.open(getWhatsAppLinkWithMessage(user.phone, user), '_blank');
    toast.success(`Opened chat with ${user.full_name.split(' ')[0]}`);
  };

  const handleSendToAll = async () => {
    if (inactiveUsers.length === 0) return;

    hapticTap();
    setIsSending(true);
    setSendingProgress(0);
    setOpenedCount(0);

    const batchSize = 5;
    const delayBetweenBatches = 800;
    const delayBetweenUsers = 300;

    if (inactiveUsers.length > 10) {
      toast.info(`Opening ${inactiveUsers.length} WhatsApp chats in batches...`, {
        duration: 3000
      });
    }

    let opened = 0;
    for (let i = 0; i < inactiveUsers.length; i++) {
      const user = inactiveUsers[i];
      
      setTimeout(() => {
        window.open(getWhatsAppLinkWithMessage(user.phone, user), '_blank');
        opened++;
        setOpenedCount(opened);
        setSendingProgress(Math.round((opened / inactiveUsers.length) * 100));
        
        if (opened === inactiveUsers.length) {
          hapticSuccess();
          setIsSending(false);
          toast.success(`Opened ${inactiveUsers.length} WhatsApp chats!`, {
            description: 'Now send your re-engagement messages'
          });
        }
      }, i < batchSize ? i * delayBetweenUsers : (Math.floor(i / batchSize) * delayBetweenBatches) + (i % batchSize) * delayBetweenUsers);
    }
  };

  const sortedUsers = useMemo(() => {
    return [...inactiveUsers].sort((a, b) => {
      return getDaysSinceActive(b.last_active_at) - getDaysSinceActive(a.last_active_at);
    });
  }, [inactiveUsers]);

  const avgDaysInactive = useMemo(() => {
    if (inactiveUsers.length === 0) return 0;
    const total = inactiveUsers.reduce((sum, u) => sum + getDaysSinceActive(u.last_active_at), 0);
    return Math.round(total / inactiveUsers.length);
  }, [inactiveUsers]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="p-2 rounded-full bg-orange-500/20">
              <Clock className="h-5 w-5 text-orange-500" />
            </div>
            Reach Out to Inactive Users
          </DialogTitle>
          <DialogDescription>
            Send personalized WhatsApp messages to bring back {inactiveUsers.length} inactive users
          </DialogDescription>
        </DialogHeader>

        {/* Stats Bar */}
        <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-xl">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold">{inactiveUsers.length}</span>
            <span className="text-sm text-muted-foreground">users</span>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-orange-500" />
            <span className="font-semibold">{avgDaysInactive}</span>
            <span className="text-sm text-muted-foreground">avg days inactive</span>
          </div>
        </div>

        {/* Quick Templates */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Quick Messages</Label>
          <div className="flex flex-wrap gap-2">
            {DEFAULT_RE_ENGAGEMENT_MESSAGES.map((template) => (
              <Badge
                key={template.id}
                variant={selectedTemplate === template.id ? 'default' : 'outline'}
                className="cursor-pointer py-1.5 px-3 text-sm transition-all hover:scale-105 active:scale-95"
                onClick={() => handleSelectTemplate(template.id)}
              >
                {template.emoji} {template.label}
              </Badge>
            ))}
          </div>
        </div>

        {/* Message Editor */}
        <div className="space-y-2">
          <Label htmlFor="reengagement-message">Message</Label>
          <Textarea
            id="reengagement-message"
            placeholder="Type your message here..."
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setSelectedTemplate('');
            }}
            rows={5}
            maxLength={1000}
            className="resize-none"
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {'{first_name}'} will be personalized
            </p>
            <p className="text-xs text-muted-foreground">
              {message.length}/1000
            </p>
          </div>
        </div>

        {/* Users List */}
        <div className="space-y-2 flex-1 min-h-0">
          <Label>Recipients ({inactiveUsers.length})</Label>
          <ScrollArea className="h-[160px] rounded-lg border">
            <div className="p-2 space-y-1">
              {sortedUsers.map((user) => {
                const phoneInfo = parsePhoneNumber(user.phone);
                const daysInactive = getDaysSinceActive(user.last_active_at);
                
                return (
                  <div
                    key={user.id}
                    className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar className="h-9 w-9">
                        <AvatarImage src={user.avatar_url || undefined} />
                        <AvatarFallback className="text-xs bg-orange-500/10 text-orange-600">
                          {getInitials(user.full_name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{user.full_name}</p>
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-muted-foreground">
                            {phoneInfo.formatted}
                          </p>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-orange-500/10 text-orange-600 border-orange-500/30">
                            {daysInactive}d
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleOpenSingleChat(user)}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>

        {/* Progress Bar (when sending) */}
        {isSending && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Opening chats...</span>
              <span className="font-medium">{openedCount}/{inactiveUsers.length}</span>
            </div>
            <Progress value={sendingProgress} className="h-2" />
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-3 pt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="flex-1"
            disabled={isSending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSendToAll}
            className="flex-1 gap-2 bg-success hover:bg-success/90 text-success-foreground"
            disabled={isSending || !message.trim()}
          >
            {isSending ? (
              <>
                <Clock className="h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Reach Out to All
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
