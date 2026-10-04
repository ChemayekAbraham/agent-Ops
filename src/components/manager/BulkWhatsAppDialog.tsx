import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  MessageCircle, Copy, ExternalLink, Check, Save, Trash2, 
  FileText, Plus, X, Tag
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const TEMPLATE_CATEGORIES = [
  { value: 'reminders', label: 'Reminders', color: 'bg-amber-500' },
  { value: 'greetings', label: 'Greetings', color: 'bg-green-500' },
  { value: 'follow-ups', label: 'Follow-ups', color: 'bg-blue-500' },
  { value: 'promotions', label: 'Promotions', color: 'bg-purple-500' },
  { value: 'support', label: 'Support', color: 'bg-rose-500' },
  { value: 'general', label: 'General', color: 'bg-slate-500' },
];

const PLACEHOLDERS = [
  { key: '{name}', label: 'Name', description: 'Full name' },
  { key: '{first_name}', label: 'First Name', description: 'First name only' },
  { key: '{phone}', label: 'Phone', description: 'Phone number' },
];
import { toast } from 'sonner';
import { parsePhoneNumber } from '@/lib/phoneUtils';

interface User {
  id: string;
  full_name: string;
  phone: string;
  avatar_url: string | null;
}

interface MessageTemplate {
  id: string;
  name: string;
  content: string;
  category: string;
  created_at: string;
}

interface BulkWhatsAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedUsers: User[];
}

export default function BulkWhatsAppDialog({
  open,
  onOpenChange,
  selectedUsers,
}: BulkWhatsAppDialogProps) {
  const [message, setMessage] = useState('');
  const [copiedNumbers, setCopiedNumbers] = useState(false);
  const [openingIndex, setOpeningIndex] = useState<number | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [newTemplateCategory, setNewTemplateCategory] = useState('general');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  useEffect(() => {
    if (open) {
      fetchTemplates();
    }
  }, [open]);

  const fetchTemplates = async () => {
    setLoadingTemplates(true);
    // message_templates table removed
    setTemplates([]);
    setLoadingTemplates(false);
  };

  const handleSaveTemplate = async () => {
    if (!newTemplateName.trim()) {
      toast.error('Please enter a template name');
      return;
    }
    if (!message.trim()) {
      toast.error('Please enter a message to save');
      return;
    }

    setSavingTemplate(true);
    const { data: { user } } = await supabase.auth.getUser();
    
    if (!user) {
      toast.error('You must be logged in to save templates');
      setSavingTemplate(false);
      return;
    }

    // message_templates table removed
    toast.error('Template saving is currently unavailable');
    setSavingTemplate(false);
  };

  const handleDeleteTemplate = async (id: string) => {
    setDeletingId(id);
    // message_templates table removed
    toast.error('Template management is currently unavailable');
    setDeletingId(null);
  };

  const handleUseTemplate = (template: MessageTemplate) => {
    setMessage(template.content);
    toast.success(`Template "${template.name}" loaded`);
  };

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const replacePlaceholders = (text: string, user: User) => {
    const phoneInfo = parsePhoneNumber(user.phone);
    const firstName = user.full_name.split(' ')[0];
    
    return text
      .replace(/{name}/gi, user.full_name)
      .replace(/{first_name}/gi, firstName)
      .replace(/{phone}/gi, phoneInfo.formatted);
  };

  const getWhatsAppLinkWithMessage = (phone: string, user?: User) => {
    const phoneInfo = parsePhoneNumber(phone);
    const baseLink = phoneInfo.whatsappLink;
    if (message.trim()) {
      const personalizedMessage = user ? replacePlaceholders(message.trim(), user) : message.trim();
      return `${baseLink}?text=${encodeURIComponent(personalizedMessage)}`;
    }
    return baseLink;
  };

  const insertPlaceholder = (placeholder: string) => {
    const textarea = document.getElementById('message') as HTMLTextAreaElement;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newMessage = message.slice(0, start) + placeholder + message.slice(end);
      setMessage(newMessage);
      // Set cursor position after placeholder
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + placeholder.length, start + placeholder.length);
      }, 0);
    } else {
      setMessage(prev => prev + placeholder);
    }
  };

  const handleCopyNumbers = () => {
    const numbers = selectedUsers.map(u => {
      const phoneInfo = parsePhoneNumber(u.phone);
      return phoneInfo.formatted;
    }).join('\n');
    
    navigator.clipboard.writeText(numbers);
    setCopiedNumbers(true);
    toast.success(`${selectedUsers.length} phone numbers copied to clipboard`);
    
    setTimeout(() => setCopiedNumbers(false), 2000);
  };

  const handleOpenSingleChat = (user: User, index: number) => {
    setOpeningIndex(index);
    window.open(getWhatsAppLinkWithMessage(user.phone, user), '_blank');
    setTimeout(() => setOpeningIndex(null), 500);
  };

  const handleOpenAllChats = () => {
    if (selectedUsers.length > 10) {
      toast.warning('Opening more than 10 chats may be blocked by your browser. Consider opening in batches.');
    }
    
    selectedUsers.forEach((user, index) => {
      setTimeout(() => {
        window.open(getWhatsAppLinkWithMessage(user.phone, user), '_blank');
      }, index * 300);
    });
    
    toast.success(`Opening ${selectedUsers.length} WhatsApp chats...`);
  };

  const hasPlaceholders = PLACEHOLDERS.some(p => message.includes(p.key));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-success" />
            Message {selectedUsers.length} Users
          </DialogTitle>
          <DialogDescription>
            Send a WhatsApp message to selected users
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="compose" className="flex-1 flex flex-col min-h-0">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="compose" className="gap-2">
              <MessageCircle className="h-4 w-4" />
              Compose
            </TabsTrigger>
            <TabsTrigger value="templates" className="gap-2">
              <FileText className="h-4 w-4" />
              Templates ({templates.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="compose" className="flex-1 flex flex-col min-h-0 mt-4 space-y-4">
            {/* Message Template */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="message">Message</Label>
                {message.trim() && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowSaveForm(!showSaveForm)}
                    className="h-7 text-xs gap-1"
                  >
                    <Save className="h-3 w-3" />
                    Save as Template
                  </Button>
                )}
              </div>
              <Textarea
                id="message"
                placeholder="Type your message here... Use {name}, {first_name}, or {phone} for personalization."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                maxLength={1000}
              />
              <div className="flex items-center justify-between">
                <div className="flex gap-1 flex-wrap">
                  <span className="text-xs text-muted-foreground mr-1">Insert:</span>
                  {PLACEHOLDERS.map((p) => (
                    <Badge
                      key={p.key}
                      variant="outline"
                      className="cursor-pointer text-xs h-5 hover:bg-primary hover:text-primary-foreground transition-colors"
                      onClick={() => insertPlaceholder(p.key)}
                      title={p.description}
                    >
                      {p.label}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {message.length}/1000
                </p>
              </div>
              {hasPlaceholders && (
                <p className="text-xs text-primary flex items-center gap-1">
                  <Check className="h-3 w-3" />
                  Placeholders will be personalized for each recipient
                </p>
              )}
            </div>

            {/* Save Template Form */}
            {showSaveForm && (
              <div className="space-y-2 p-3 bg-muted/50 rounded-lg">
                <div className="flex gap-2">
                  <Input
                    placeholder="Template name..."
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value)}
                    className="flex-1 h-8"
                    maxLength={50}
                  />
                  <Select value={newTemplateCategory} onValueChange={setNewTemplateCategory}>
                    <SelectTrigger className="w-[130px] h-8">
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      {TEMPLATE_CATEGORIES.map((cat) => (
                        <SelectItem key={cat.value} value={cat.value}>
                          <div className="flex items-center gap-2">
                            <div className={`h-2 w-2 rounded-full ${cat.color}`} />
                            {cat.label}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShowSaveForm(false);
                      setNewTemplateName('');
                      setNewTemplateCategory('general');
                    }}
                    className="h-8"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSaveTemplate}
                    disabled={savingTemplate}
                    className="h-8"
                  >
                    {savingTemplate ? 'Saving...' : 'Save Template'}
                  </Button>
                </div>
              </div>
            )}

            {/* Selected Users List */}
            <div className="space-y-2 flex-1 min-h-0 flex flex-col">
              <div className="flex items-center justify-between">
                <Label>Recipients ({selectedUsers.length})</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopyNumbers}
                  className="h-7 text-xs gap-1"
                >
                  {copiedNumbers ? (
                    <>
                      <Check className="h-3 w-3" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      Copy Numbers
                    </>
                  )}
                </Button>
              </div>
              
              <ScrollArea className="flex-1 min-h-[120px] max-h-[180px] rounded-lg border">
                <div className="p-2 space-y-1">
                  {selectedUsers.map((user, index) => {
                    const phoneInfo = parsePhoneNumber(user.phone);
                    return (
                      <div
                        key={user.id}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Avatar className="h-8 w-8">
                            <AvatarImage src={user.avatar_url || undefined} />
                            <AvatarFallback className="text-xs">
                              {getInitials(user.full_name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{user.full_name}</p>
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              {!phoneInfo.isUgandan && <span>{phoneInfo.countryFlag}</span>}
                              {phoneInfo.formatted}
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => handleOpenSingleChat(user, index)}
                        >
                          {openingIndex === index ? (
                            <Check className="h-4 w-4 text-success" />
                          ) : (
                            <ExternalLink className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          </TabsContent>

          <TabsContent value="templates" className="flex-1 min-h-0 mt-4 space-y-3">
            {/* Category Filter */}
            <div className="flex gap-2 flex-wrap">
              <Badge
                variant={filterCategory === 'all' ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => setFilterCategory('all')}
              >
                All ({templates.length})
              </Badge>
              {TEMPLATE_CATEGORIES.map((cat) => {
                const count = templates.filter(t => t.category === cat.value).length;
                if (count === 0) return null;
                return (
                  <Badge
                    key={cat.value}
                    variant={filterCategory === cat.value ? 'default' : 'outline'}
                    className="cursor-pointer gap-1.5"
                    onClick={() => setFilterCategory(cat.value)}
                  >
                    <div className={`h-2 w-2 rounded-full ${cat.color}`} />
                    {cat.label} ({count})
                  </Badge>
                );
              })}
            </div>

            <ScrollArea className="h-[240px]">
              {loadingTemplates ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  Loading templates...
                </div>
              ) : templates.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <FileText className="h-10 w-10 text-muted-foreground mb-2" />
                  <p className="text-muted-foreground">No templates saved yet</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Write a message and click "Save as Template"
                  </p>
                </div>
              ) : (
                <div className="space-y-2 p-1">
                  {templates
                    .filter(t => filterCategory === 'all' || t.category === filterCategory)
                    .map((template) => {
                      const categoryInfo = TEMPLATE_CATEGORIES.find(c => c.value === template.category);
                      return (
                        <div
                          key={template.id}
                          className="p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-sm">{template.name}</h4>
                              {categoryInfo && (
                                <Badge variant="secondary" className="text-[10px] h-5 gap-1">
                                  <div className={`h-1.5 w-1.5 rounded-full ${categoryInfo.color}`} />
                                  {categoryInfo.label}
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleUseTemplate(template)}
                                className="h-7 text-xs gap-1"
                              >
                                <Plus className="h-3 w-3" />
                                Use
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDeleteTemplate(template.id)}
                                disabled={deletingId === template.id}
                                className="h-7 px-2 text-destructive hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {template.content}
                          </p>
                        </div>
                      );
                    })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <DialogFooter className="flex-col sm:flex-row gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleOpenAllChats}
            className="gap-2 bg-success hover:bg-success/90 text-success-foreground"
          >
            <MessageCircle className="h-4 w-4" />
            Open All Chats
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}