import { useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Download, ArrowLeft, CheckCircle2, ArrowRight, ShieldCheck, Phone, MapPin, FileText, Users, Wallet, Building2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { exportToPDF } from '@/lib/exportUtils';
import { toast } from 'sonner';

const STAGES = [
  {
    number: 1,
    title: 'Agent Submits Rent Request',
    role: 'Field Agent',
    status: 'pending',
    icon: FileText,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    description: 'The agent meets the tenant in the field and fills out the rent request form on their behalf.',
    details: [
      'Agent collects tenant personal details (name, phone, National ID)',
      'Agent records landlord information (name, phone, MoMo number)',
      'Agent captures property details (location, rent amount, GPS coordinates)',
      'Agent uploads supporting documents (ID photos, house photos)',
      'Request is submitted with status "Pending"',
    ],
  },
  {
    number: 2,
    title: 'Tenant Ops Verification',
    role: 'Tenant Operations Manager',
    status: 'tenant_ops_approved',
    icon: Users,
    color: 'text-green-500',
    bgColor: 'bg-green-500/10',
    description: 'The Tenant Operations Manager verifies that the tenant\'s details are true and accurate.',
    details: [
      'Verify tenant identity matches submitted documents',
      'Confirm phone number is reachable and belongs to tenant',
      'Validate National ID authenticity',
      'Check tenant has no existing defaults or blacklist flags',
      'Approve or reject with documented reasoning',
    ],
  },
  {
    number: 3,
    title: 'Agent Ops Verification',
    role: 'Agent Operations Manager',
    status: 'agent_verified',
    icon: ShieldCheck,
    color: 'text-orange-500',
    bgColor: 'bg-orange-500/10',
    description: 'Agent Operations verifies that the agent qualifies to take on more tenants and is in good standing.',
    details: [
      'Check agent\'s current portfolio load and capacity',
      'Verify agent has no unresolved escalations or defaults',
      'Confirm agent\'s float settlement history is clean',
      'Assess agent\'s collection performance metrics',
      'Approve agent qualification or flag concerns',
    ],
  },
  {
    number: 4,
    title: 'Landlord Ops Verification',
    role: 'Landlord Operations Manager',
    status: 'landlord_ops_approved',
    icon: Building2,
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10',
    description: 'Landlord Operations verifies that the landlord is legitimate and agrees to Welile\'s terms.',
    details: [
      'Call the landlord to confirm property ownership',
      'Verify the MoMo phone number entered by the agent matches the landlord',
      'Landlord must acknowledge that Welile becomes the tenant when rent is paid',
      'Recommend verification method: Phone Call, Physical Visit, or LC1 Confirmation',
      'Record call notes and landlord acknowledgment status',
      'Approval blocked until: Landlord called ✓ AND Landlord acknowledged ✓',
    ],
  },
  {
    number: 5,
    title: 'COO Approval',
    role: 'Chief Operating Officer',
    status: 'coo_approved',
    icon: CheckCircle2,
    color: 'text-teal-500',
    bgColor: 'bg-teal-500/10',
    description: 'The COO reviews all approved requests and makes the final operational decision.',
    details: [
      'Reviews requests individually or approves in bulk',
      'Assesses overall risk exposure and portfolio concentration',
      'May reject requests based on strategic direction from top management',
      'Considers geographic distribution and agent load balancing',
      'Approved requests move to CFO for funding',
    ],
  },
  {
    number: 6,
    title: 'CFO Funds Agent Wallet',
    role: 'Chief Financial Officer',
    status: 'funded',
    icon: Wallet,
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
    description: 'The CFO sends the rent amount to the agent\'s wallet as Operations Float for landlord delivery.',
    details: [
      'CFO reviews approved requests in the Rent Disbursement Pipeline',
      'Funds are sent to the agent\'s wallet as "Operations Float"',
      'Float appears in the agent\'s wallet but CANNOT be freely withdrawn',
      'Float can ONLY be used to pay the tagged landlord via OTP verification',
      'Ledger entry created: category "agent_float_assignment"',
    ],
  },
  {
    number: 7,
    title: 'Agent Delivers Rent to Landlord',
    role: 'Field Agent + Landlord',
    status: 'delivered',
    icon: Phone,
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    description: 'The agent physically meets the landlord and initiates the OTP-verified payout.',
    details: [
      'Agent selects the funded rent request in the app',
      'Agent taps "Send OTP to Landlord" — SMS is sent to landlord\'s phone',
      'Landlord receives the OTP code on their phone (works on any phone, including feature phones)',
      'Landlord physically reads the 6-digit code to the agent',
      'Agent enters the OTP to prove physical presence and landlord consent',
      'Agent enters MoMo Transaction ID + captures GPS location + uploads receipt photo',
      'Confirmation SMS sent to landlord: "Welile has paid UGX {amount} for {tenant}"',
    ],
  },
  {
    number: 8,
    title: 'Financial Ops Verification',
    role: 'Financial Operations Team',
    status: 'verified',
    icon: MapPin,
    color: 'text-indigo-500',
    bgColor: 'bg-indigo-500/10',
    description: 'Financial Operations verifies the withdrawal was legitimate and the landlord received payment.',
    details: [
      'Review OTP verification status (must be verified ✓)',
      'Check GPS location matches property coordinates',
      'Verify MoMo Transaction ID is valid',
      'Review receipt photo evidence',
      'Approve or flag for investigation',
      'Float settlement ledger entry created upon approval',
    ],
  },
];

export default function RentDisbursementProcess() {
  const navigate = useNavigate();
  const contentRef = useRef<HTMLDivElement>(null);

  const handleDownloadPDF = async () => {
    if (!contentRef.current) return;
    try {
      toast.loading('Generating PDF...');
      await exportToPDF(contentRef.current, 'Welile_Rent_Disbursement_Process', 'Welile Rent Disbursement Process');
      toast.dismiss();
      toast.success('PDF downloaded successfully');
    } catch {
      toast.dismiss();
      toast.error('Failed to generate PDF');
    }
  };

  return (
    <div className="min-h-screen bg-background pb-8">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1">
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <Button onClick={handleDownloadPDF} size="sm" className="gap-2">
            <Download className="h-4 w-4" /> Download PDF
          </Button>
        </div>
      </div>

      {/* Content */}
      <div ref={contentRef} className="max-w-4xl mx-auto px-4 pt-6 space-y-6">
        {/* Title Card */}
        <Card className="border-primary/20">
          <CardContent className="pt-6 pb-4 text-center space-y-2">
            <h1 className="text-2xl font-bold text-foreground">Welile Rent Disbursement Process</h1>
            <p className="text-sm text-muted-foreground">Official Internal Process Document</p>
            <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground pt-2">
              <span>Created by: <strong>Benjamin</strong></span>
              <span>Version: 1.0</span>
              <span>Date: {new Date().toLocaleDateString('en-UG', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 pt-3">
              {['Agent', 'Agent Ops', 'Tenant Ops', 'Landlord Ops', 'COO', 'CFO', 'CEO', 'Financial Ops'].map(role => (
                <Badge key={role} variant="secondary" className="text-xs">{role}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Overview */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Overview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              The Welile rent disbursement process is an <strong className="text-foreground">8-stage pipeline</strong> designed to ensure every shilling of rent reaches the correct landlord with full accountability. Each stage has a designated role responsible for verification before the request advances.
            </p>
            <p>
              <strong className="text-foreground">Key Principle:</strong> Money flows from Welile → Agent Wallet (as Operations Float) → Landlord. The agent acts as a field cashier — they never own the float, they only deliver it. Delivery is verified through <strong className="text-foreground">SMS OTP</strong> sent to the landlord's phone (works on any phone, including feature phones).
            </p>
          </CardContent>
        </Card>

        {/* Pipeline Flow Visual */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Pipeline Flow</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-1 justify-center text-xs font-medium">
              {STAGES.map((stage, i) => (
                <div key={stage.number} className="flex items-center gap-1">
                  <div className={`${stage.bgColor} ${stage.color} px-2 py-1 rounded-md whitespace-nowrap`}>
                    {stage.number}. {stage.role.split(' ')[0]}
                  </div>
                  {i < STAGES.length - 1 && <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Detailed Stages */}
        {STAGES.map((stage) => {
          const Icon = stage.icon;
          return (
            <Card key={stage.number} className="overflow-hidden">
              <CardHeader className="pb-2">
                <div className="flex items-start gap-3">
                  <div className={`${stage.bgColor} p-2 rounded-lg shrink-0`}>
                    <Icon className={`h-5 w-5 ${stage.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs shrink-0">Stage {stage.number}</Badge>
                      <Badge variant="secondary" className="text-xs shrink-0">{stage.role}</Badge>
                    </div>
                    <CardTitle className="text-base mt-1">{stage.title}</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">{stage.description}</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="ml-12 space-y-1.5">
                  {stage.details.map((detail, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${stage.color}`} />
                      <span className="text-muted-foreground">{detail}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}

        {/* Key Rules */}
        <Card className="border-destructive/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg text-destructive">⚠️ Critical Rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[
              'Operations Float is company money — agents CANNOT withdraw it freely.',
              'Float can ONLY be released via OTP verification with the landlord.',
              'Commission (agent\'s earnings) is always freely withdrawable — no restrictions.',
              'Every payout requires: OTP ✓ + GPS ✓ + MoMo TID ✓ + Receipt Photo ✓',
              'Outstanding float older than 72 hours triggers a risk flag.',
              'No stage can be skipped — the pipeline enforces sequential approval.',
            ].map((rule, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-destructive font-bold shrink-0">{i + 1}.</span>
                <span className="text-muted-foreground">{rule}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Footer */}
        <div className="text-center text-xs text-muted-foreground pt-4 pb-8 space-y-1">
          <p>Welile Technologies Limited — Internal Process Document</p>
          <p>Created by Benjamin • {new Date().getFullYear()}</p>
          <p>This document is confidential and intended for authorized personnel only.</p>
        </div>
      </div>
    </div>
  );
}
