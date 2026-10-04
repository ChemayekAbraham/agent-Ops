import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { generateEmployeeId } from '@/lib/employeeId';
import { toast } from 'sonner';
import { Loader2, Copy, Check } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';

interface RegisterEmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const DEPARTMENTS = ['Engineering', 'Operations', 'Finance', 'Marketing', 'Customer Support', 'Human Resources', 'Management', 'Sales'];
const POSITIONS = ['Staff', 'Team Lead', 'Supervisor', 'Head of Department', 'Director', 'VP', 'C-Level'];

export default function RegisterEmployeeDialog({ open, onOpenChange, onSuccess }: RegisterEmployeeDialogProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    department: '',
    position: '',
    role: 'employee' as string,
    tempPassword: '',
  });
  const [result, setResult] = useState<{ employeeId: string; email: string; password: string } | null>(null);
  // Captured in parts; `form.fullName` stays the single stored string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const [copied, setCopied] = useState(false);

  const generatePassword = () => {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!';
    let pw = '';
    for (let i = 0; i < 8; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    setForm(f => ({ ...f, tempPassword: pw }));
  };

  const resetForm = () => {
    setForm({ fullName: '', email: '', phone: '', department: '', position: '', role: 'employee', tempPassword: '' });
    setNameParts({ firstName: '', otherNames: '', lastName: '' });
    setResult(null);
    setCopied(false);
  };

  const handleSubmit = async () => {
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid) {
      toast.error(nameCheck.error || 'Enter first and last name');
      return;
    }
    if (!form.fullName || !form.email || !form.phone || !form.department || !form.position || !form.tempPassword) {
      toast.error('All fields are required');
      return;
    }

    setLoading(true);
    try {
      // Generate unique employee ID
      let employeeId = generateEmployeeId(form.fullName);
      
      // Check uniqueness
      const { data: existing } = await supabase
        .from('staff_profiles')
        .select('employee_id')
        .eq('employee_id', employeeId)
        .maybeSingle();
      
      if (existing) {
        employeeId = generateEmployeeId(form.fullName); // retry once
      }

      // Create the auth user via edge function
      const { data: createResult, error: fnError } = await supabase.functions.invoke('register-employee', {
        body: {
          email: form.email,
          password: form.tempPassword,
          full_name: form.fullName,
          phone: form.phone,
          department: form.department,
          position: form.position,
          role: form.role,
          employee_id: employeeId,
          created_by: user?.id,
        },
      });

      if (fnError) throw fnError;
      if (createResult?.error) throw new Error(createResult.error);

      // Log audit
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'employee_registered',
        table_name: 'staff_profiles',
        record_id: createResult?.user_id || employeeId,
        metadata: { employee_id: employeeId, role: form.role, department: form.department },
      });

      setResult({ employeeId, email: form.email, password: form.tempPassword });
      toast.success(`Employee ${form.fullName} registered successfully`);
      onSuccess();
    } catch (err: any) {
      console.error('Register employee error:', err);
      toast.error(err.message || 'Failed to register employee');
    } finally {
      setLoading(false);
    }
  };

  const whatsAppMessage = result
    ? encodeURIComponent(
        `Welcome to WELILE.\n\nYour employee account has been created.\n\nEmployee ID: ${result.employeeId}\nLogin Email: ${result.email}\nTemporary Password: ${result.password}\n\nPlease log in and change your password immediately.`
      )
    : '';

  const sendWhatsApp = () => {
    const phone = form.phone.replace(/[^0-9]/g, '');
    window.open(`https://wa.me/${phone}?text=${whatsAppMessage}`, '_blank');
  };

  const copyCredentials = () => {
    if (!result) return;
    navigator.clipboard.writeText(
      `Employee ID: ${result.employeeId}\nEmail: ${result.email}\nPassword: ${result.password}`
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{result ? 'Employee Registered ✅' : 'Register New Employee'}</DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-2 text-sm font-mono">
              <p><span className="text-muted-foreground">Employee ID:</span> {result.employeeId}</p>
              <p><span className="text-muted-foreground">Email:</span> {result.email}</p>
              <p><span className="text-muted-foreground">Temp Password:</span> {result.password}</p>
            </div>
            <div className="flex gap-2">
              <Button onClick={copyCredentials} variant="outline" className="flex-1 gap-2">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button onClick={sendWhatsApp} className="flex-1 bg-[#25D366] hover:bg-[#25D366]/90 text-white">
                Send via WhatsApp
              </Button>
            </div>
            <Button variant="outline" className="w-full" onClick={() => { resetForm(); }}>
              Register Another
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Full Name *</Label>
              <PersonNameFields
                idPrefix="register-employee"
                value={nameParts}
                onChange={(next) => {
                  setNameParts(next);
                  setForm(f => ({ ...f, fullName: joinPersonName(next) }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>Email *</Label>
              <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="john@welile.com" />
            </div>
            <div className="space-y-2">
              <Label>Phone Number *</Label>
              <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+256..." />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Department *</Label>
                <Select value={form.department} onValueChange={v => setForm(f => ({ ...f, department: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {DEPARTMENTS.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Position *</Label>
                <Select value={form.position} onValueChange={v => setForm(f => ({ ...f, position: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {POSITIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="employee">Employee</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="operations">Operations</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Temporary Password *</Label>
              <div className="flex gap-2">
                <Input value={form.tempPassword} onChange={e => setForm(f => ({ ...f, tempPassword: e.target.value }))} placeholder="Min 6 chars" />
                <Button type="button" variant="outline" size="sm" onClick={generatePassword} className="shrink-0">
                  Generate
                </Button>
              </div>
            </div>
            <Button onClick={handleSubmit} disabled={loading} className="w-full h-11">
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Register Employee
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
