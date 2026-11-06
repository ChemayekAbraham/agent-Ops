import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { extractInquiryLeadDetails, buildInquirySignupResult, type InquirySignupResult } from '@/lib/nexaSalesEngine';

export function NexaInquirySignupBar({ result, initialRole = 'tenant' }: { result: InquirySignupResult | null; initialRole?: string }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState(initialRole);
  const [error, setError] = useState('');
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const lead = extractInquiryLeadDetails('', {leadName:name,leadPhone:phone,leadRole:role});
    if (!lead.name || !lead.displayPhone) { setError('Enter your name and a Uganda mobile number (07…).'); return; }
    const url = new URL(buildInquirySignupResult(lead.role).loginUrl);
    url.searchParams.set('name', lead.name);
    url.searchParams.set('phone', lead.displayPhone);
    navigate(url.pathname + url.search);
  };
  return <section data-testid="nexa-instant-signup-bar" className="border-b border-border bg-muted/30 px-4 py-4 text-sm">
    <div className="mb-3 flex items-center gap-2 font-semibold text-foreground"><Wallet className="h-4 w-4 text-primary" />Free signup + Welile Wallet</div>
    {result && <div data-testid="nexa-signup-ready" className="mb-3 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-success">Ready to join? Complete secure signup to open your account.</div>}
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div><Label htmlFor="nexa-lead-name" className="text-sm">Your Name</Label><Input id="nexa-lead-name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} maxLength={80} className="mb-0 mt-1 h-11 px-3" required /></div>
        <div><Label htmlFor="nexa-lead-phone" className="text-sm">Phone (07…)</Label><Input id="nexa-lead-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} maxLength={24} className="mb-0 mt-1 h-11 px-3" required /></div>
      </div>
      <div><Label htmlFor="nexa-lead-role" className="text-sm">Join as</Label><Select value={role} onValueChange={setRole}><SelectTrigger id="nexa-lead-role" className="mt-1 h-11 px-3 text-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="supporter">Supporter (15% monthly Returns)</SelectItem><SelectItem value="tenant">Tenant (up to UGX 30M)</SelectItem><SelectItem value="agent">Field Agent</SelectItem><SelectItem value="landlord">Landlord</SelectItem></SelectContent></Select></div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <Button data-testid="nexa-instant-signup-btn" type="submit" className="w-full">Continue to Free Sign Up<ArrowRight /></Button>
      <p className="text-sm leading-relaxed text-muted-foreground">Choose your password and complete secure signup. Already registered? Sign in on the next page.</p>
    </form>
  </section>;
}