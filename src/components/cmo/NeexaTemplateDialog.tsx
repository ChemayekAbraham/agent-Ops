import { useEffect, useState } from 'react';
import { MessageSquare, Send, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { fillNeexaTemplate, neexaPlaceholderNumbers, normalizeNeexaPhone, type NeexaTemplate } from '@/hooks/useNeexaInbox';

interface Props {
  open: boolean; onOpenChange: (open: boolean) => void; initialPhone: string;
  templates: NeexaTemplate[]; loading: boolean; error: string | null; sending: boolean;
  loadTemplates: () => Promise<void>;
  sendTemplate: (template: string, phone: string, variables: { header?: string[]; body?: string[] }) => Promise<boolean>;
}
export function NeexaTemplateDialog({ open, onOpenChange, initialPhone, templates, loading, error, sending, loadTemplates, sendTemplate }: Props) {
  const [phone, setPhone] = useState(initialPhone);
  const [templateId, setTemplateId] = useState('');
  const [headerValues, setHeaderValues] = useState<Record<number, string>>({});
  const [bodyValues, setBodyValues] = useState<Record<number, string>>({});
  const [phoneTouched, setPhoneTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPhone(initialPhone); setTemplateId(''); setHeaderValues({}); setBodyValues({}); setPhoneTouched(false);
    void loadTemplates();
  }, [open, initialPhone]);
  const template = templates.find(row => row.attributes.public_id === templateId)?.attributes;
  const headerText = template?.header?.text || '';
  const bodyText = template?.body?.text || '';
  const headerNumbers = neexaPlaceholderNumbers(headerText);
  const bodyNumbers = neexaPlaceholderNumbers(bodyText);
  const validPhone = normalizeNeexaPhone(phone);
  const complete = headerNumbers.every(index => headerValues[index]?.trim()) && bodyNumbers.every(index => bodyValues[index]?.trim());
  const variablesArray = (numbers: number[], values: Record<number, string>) =>
    Array.from({ length: Math.max(0, ...numbers) }, (_, index) => (values[index + 1] || '').trim());
  const submit = async () => {
    if (!template || !validPhone || !complete || sending) return;
    const sent = await sendTemplate(template.public_id, phone, {
      ...(headerNumbers.length ? { header: variablesArray(headerNumbers, headerValues) } : {}),
      ...(bodyNumbers.length ? { body: variablesArray(bodyNumbers, bodyValues) } : {}),
    });
    if (sent) onOpenChange(false);
  };
  const footer = typeof template?.footer === 'string' ? template.footer : template?.footer?.text;
  return <Dialog open={open} onOpenChange={next => { if (!sending) onOpenChange(next); }}>
    <DialogContent stable className="max-w-lg rounded-lg">
      <DialogHeader className="pr-10 text-left">
        <DialogTitle className="flex items-center gap-2 tracking-normal"><MessageSquare className="h-5 w-5 text-primary" /> New WhatsApp message</DialogTitle>
        <DialogDescription>Approved template</DialogDescription>
      </DialogHeader>
      <div className="space-y-2"><Label htmlFor="neexa-phone">Phone number</Label>
        <Input id="neexa-phone" type="tel" placeholder="0772 123 456" value={phone} disabled={sending} onBlur={() => setPhoneTouched(true)} onChange={event => setPhone(event.target.value)} />
        {phoneTouched && !validPhone && <p className="text-xs text-destructive">Enter a Ugandan number or an international number starting with +.</p>}
      </div>
      <div className="space-y-2"><Label htmlFor="neexa-template">Template</Label>
        <Select value={templateId} disabled={loading || sending} onValueChange={value => { setTemplateId(value); setHeaderValues({}); setBodyValues({}); }}>
          <SelectTrigger id="neexa-template" className="h-11"><SelectValue placeholder={loading ? 'Loading templates…' : 'Choose a template'} /></SelectTrigger>
          <SelectContent>{templates.map(row => <SelectItem key={row.attributes.public_id} value={row.attributes.public_id}>{row.attributes.name.replace(/_/g, ' ')}</SelectItem>)}</SelectContent>
        </Select>
        {!loading && !templates.length && !error && <p className="text-sm text-muted-foreground">No approved templates available.</p>}
      </div>
      {template && <>
        {(['header', 'body'] as const).map(section => (section === 'header' ? headerNumbers : bodyNumbers).map(index =>
          <div key={`${section}-${index}`} className="space-y-2"><Label htmlFor={`neexa-${section}-${index}`}>{section === 'header' ? 'Header' : 'Body'} variable {index}</Label>
            <Input id={`neexa-${section}-${index}`} maxLength={section === 'header' ? 60 : 120} disabled={sending}
              value={(section === 'header' ? headerValues : bodyValues)[index] || ''}
              onChange={event => (section === 'header' ? setHeaderValues : setBodyValues)(old => ({ ...old, [index]: event.target.value }))} />
          </div>))}
        <div className="space-y-2"><p className="text-xs font-medium text-muted-foreground">Preview</p>
          <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {headerText && <p className="font-semibold">{fillNeexaTemplate(headerText, headerValues)}</p>}
            <p>{fillNeexaTemplate(bodyText, bodyValues)}</p>
            {footer && <p className="text-xs text-muted-foreground">{footer}</p>}
          </div>
        </div>
      </>}
      {error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p>
        {!template && <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadTemplates()}>Retry templates</Button>}
      </div>}
      <Button disabled={!template || !validPhone || !complete || sending || loading} onClick={() => void submit()}>
        {sending ? <Loader2 className="animate-spin" /> : <Send />} {sending ? 'Sending…' : 'Send template'}
      </Button>
    </DialogContent>
  </Dialog>;
}
