import { useState, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Bold, Italic, List, ListOrdered, Quote, Heading2, Link2,
  Undo2, Redo2, Send, Users, Sparkles, Loader2, Mail, AlertTriangle, Eye,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { renderPartnerEmailPreview } from './partnerEmailPreview';

export function COOPartnerBroadcast() {
  const [subject, setSubject] = useState('');
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [suppressedCount, setSuppressedCount] = useState<number>(0);
  const [loadingCount, setLoadingCount] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [bodyHtml, setBodyHtml] = useState('');

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] } }),
      Link.configure({ openOnClick: false, HTMLAttributes: { class: 'text-primary underline' } }),
    ],
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none min-h-[260px] px-4 py-3 focus:outline-none',
      },
    },
    content: '',
    onUpdate: ({ editor }) => setBodyHtml(editor.getHTML()),
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await invokeEdgeFunction<{ recipient_count: number; suppressed_count: number }>(
        'coo-broadcast-partners',
        { body: { subject: 'Audience preview', html: '<p>preview</p>', dry_run: true }, silent: true },
      );
      if (cancelled) return;
      if (data) {
        setRecipientCount(data.recipient_count);
        setSuppressedCount(data.suppressed_count);
      }
      setLoadingCount(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSend = async () => {
    const html = editor?.getHTML() || '';
    const text = editor?.getText().trim() || '';
    if (!subject.trim()) { toast.error('Subject is required'); return; }
    if (!text) { toast.error('Message body is empty'); return; }
    setSending(true);
    const { data, error } = await invokeEdgeFunction<{ queued: number; suppressed: number; total: number }>(
      'coo-broadcast-partners',
      { body: { subject: subject.trim(), html }, errorTitle: 'Broadcast failed' },
    );
    setSending(false);
    setConfirmOpen(false);
    if (error || !data) return;
    toast.success(`Queued ${data.queued} email${data.queued === 1 ? '' : 's'}`, {
      description: data.suppressed
        ? `${data.suppressed} suppressed/unsubscribed recipients were skipped.`
        : 'Delivery is processing in the background.',
    });
    setSubject('');
    editor?.commands.clearContent();
  };

  if (!editor) return null;

  const previewHtml = renderPartnerEmailPreview({
    emailTitle: subject.trim() || 'Your subject will appear here',
    notificationType: 'Partner Communication',
    partnerName: 'Partner',
    messageBodyHtml: bodyHtml || '<p style="color:#94a3b8;font-style:italic;">Your message body preview will appear here…</p>',
    notificationDate: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
  });

  const ToolbarBtn = ({
    onClick, active, label, children,
  }: { onClick: () => void; active?: boolean; label: string; children: React.ReactNode }) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'h-8 w-8 rounded-md flex items-center justify-center text-sm transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-foreground/70',
      )}
    >
      {children}
    </button>
  );

  return (
    <div className="space-y-4">
      {/* Hero */}
      <Card className="overflow-hidden border-0 bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 text-white">
        <CardContent className="p-5 sm:p-6 flex items-start gap-4">
          <div className="h-12 w-12 rounded-2xl bg-white/15 backdrop-blur flex items-center justify-center shrink-0">
            <Sparkles className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-[0.2em] opacity-80">Partner Communications</p>
            <h2 className="text-xl sm:text-2xl font-bold leading-tight">Mass Email to Partners</h2>
            <p className="text-sm opacity-90 mt-1">
              Compose a branded message and broadcast it to every active partner inbox.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant="secondary" className="bg-white/15 hover:bg-white/15 text-white border-0">
                <Users className="h-3 w-3 mr-1" />
                {loadingCount ? 'Counting…' : `${recipientCount ?? 0} partners with portfolios`}
              </Badge>
              {suppressedCount > 0 && (
                <Badge variant="secondary" className="bg-white/15 hover:bg-white/15 text-white border-0">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  {suppressedCount} unsubscribed
                </Badge>
              )}
            </div>
            <p className="text-[11px] opacity-70 mt-1.5">
              {loadingCount
                ? 'Calculating audience…'
                : `Audience = every user holding one or more portfolio. ${recipientCount ?? 0} have valid emails and will receive this broadcast.`}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" /> Compose
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bcast-subject">Subject</Label>
            <Input
              id="bcast-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              placeholder="e.g. Q3 Partnership Update — Strong Returns Ahead"
            />
            <p className="text-[11px] text-muted-foreground text-right">{subject.length}/200</p>
          </div>

          <div className="space-y-1.5">
            <Label>Message</Label>
            <div className="rounded-lg border bg-background overflow-hidden">
              <div className="flex flex-wrap items-center gap-1 border-b bg-muted/30 px-2 py-1.5">
                <ToolbarBtn label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="h-3.5 w-3.5" /></ToolbarBtn>
                <ToolbarBtn label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="h-3.5 w-3.5" /></ToolbarBtn>
                <ToolbarBtn label="Heading" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="h-3.5 w-3.5" /></ToolbarBtn>
                <Separator orientation="vertical" className="h-5 mx-1" />
                <ToolbarBtn label="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="h-3.5 w-3.5" /></ToolbarBtn>
                <ToolbarBtn label="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="h-3.5 w-3.5" /></ToolbarBtn>
                <ToolbarBtn label="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="h-3.5 w-3.5" /></ToolbarBtn>
                <Separator orientation="vertical" className="h-5 mx-1" />
                <ToolbarBtn
                  label="Link"
                  active={editor.isActive('link')}
                  onClick={() => {
                    const prev = editor.getAttributes('link').href;
                    const url = window.prompt('Link URL', prev || 'https://');
                    if (url === null) return;
                    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
                    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
                  }}
                ><Link2 className="h-3.5 w-3.5" /></ToolbarBtn>
                <Separator orientation="vertical" className="h-5 mx-1" />
                <ToolbarBtn label="Undo" onClick={() => editor.chain().focus().undo().run()}><Undo2 className="h-3.5 w-3.5" /></ToolbarBtn>
                <ToolbarBtn label="Redo" onClick={() => editor.chain().focus().redo().run()}><Redo2 className="h-3.5 w-3.5" /></ToolbarBtn>
              </div>
              <EditorContent editor={editor} />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Tip: keep it scannable — short paragraphs, clear ask, one link.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-primary" /> Live email preview
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowPreview((v) => !v)}
              >
                {showPreview ? 'Hide' : 'Show'}
              </Button>
            </div>
            {showPreview && (
              <div className="rounded-lg border bg-muted/20 overflow-hidden">
                <iframe
                  title="Partner email preview"
                  srcDoc={previewHtml}
                  className="w-full h-[640px] bg-card"
                  sandbox=""
                />
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Each partner will see their own name in place of "Partner". Date is auto-filled at send time.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
            <p className="text-xs text-muted-foreground">
              Recipients are de-duplicated and unsubscribed addresses are auto-skipped.
            </p>
            <Button
              size="lg"
              disabled={sending || !subject.trim() || !editor.getText().trim() || (recipientCount ?? 0) === 0}
              onClick={() => setConfirmOpen(true)}
              className="bg-gradient-to-r from-indigo-600 to-fuchsia-600 hover:opacity-90"
            >
              {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              Send to {recipientCount ?? 0} partners
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Broadcast to all partners?</AlertDialogTitle>
            <AlertDialogDescription>
              This will queue an email to <b>{recipientCount ?? 0}</b> partner inbox{(recipientCount ?? 0) === 1 ? '' : 'es'}.
              This action is logged and cannot be recalled once sent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSend} disabled={sending}>
              {sending ? 'Queueing…' : 'Confirm & Send'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default COOPartnerBroadcast;
