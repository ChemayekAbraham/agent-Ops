import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, Check, Copy, Lock, Globe, MessageSquare, Wallet, FileDown, Home, Star } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const PROJECT_REF = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? '';
const SIGNED_IN_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/mcp`;
const PUBLIC_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/mcp-public`;

function UrlBox({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success('Link copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — select the text and copy manually');
    }
  };

  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs sm:text-sm">{url}</code>
        <Button size="sm" variant="secondary" onClick={copy} className="shrink-0">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span className="ml-1.5 hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
        </Button>
      </div>
    </div>
  );
}

function Steps({ items }: { items: { title: string; body: string }[] }) {
  return (
    <ol className="space-y-4">
      {items.map((s, i) => (
        <li key={s.title} className="flex gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
            {i + 1}
          </span>
          <div className="pt-0.5">
            <p className="font-medium leading-snug">{s.title}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

const CHATGPT_STEPS = [
  { title: 'Open ChatGPT settings', body: 'Use ChatGPT on the web or desktop, then open Settings from your profile menu.' },
  { title: 'Go to Connectors', body: 'Find Connectors (also shown as Apps or Custom connectors) and choose to add a new one. Connectors need a paid ChatGPT plan.' },
  { title: 'Paste the Welile MCP URL', body: 'Paste the URL from the box above and give the connector a name such as "Welile".' },
  { title: 'Sign in and approve', body: 'For the personal connection, a Welile sign-in screen opens. Log in with your normal Welile account, then tap Approve so ChatGPT can read your data.' },
  { title: 'Start asking', body: 'In a new chat, enable the Welile connector and ask something like "Show my Welile wallet statement for July as a PDF".' },
];

const CLAUDE_STEPS = [
  { title: 'Open Claude settings', body: 'Use Claude on the web or desktop app, then open Settings from your profile menu.' },
  { title: 'Go to Connectors', body: 'Open Connectors and choose Add custom connector.' },
  { title: 'Paste the Welile MCP URL', body: 'Paste the URL from the box above, name it "Welile", and save.' },
  { title: 'Sign in and approve', body: 'For the personal connection, Claude opens a Welile sign-in screen. Log in, then tap Approve to grant access.' },
  { title: 'Start asking', body: 'In a chat, open the tools menu, make sure Welile is enabled, and ask "What is my current withdrawable balance?"' },
];

const SIGNED_IN_TOOLS = [
  { icon: MessageSquare, title: 'My profile', body: 'Your name, role and verification status.' },
  { icon: Wallet, title: 'My wallet', body: 'Withdrawable, float and advance balances.' },
  { icon: MessageSquare, title: 'My transactions', body: 'Recent wallet activity in plain language.' },
  { icon: MessageSquare, title: 'My wallet statement', body: 'A full statement for any date range with totals.' },
  { icon: FileDown, title: 'Export my statement', body: 'A PDF, Excel or CSV download link, valid 7 days.' },
];

const PUBLIC_TOOLS = [
  { icon: MessageSquare, title: 'How Welile works', body: 'Answers common questions about rent plans and supporters.' },
  { icon: Globe, title: 'Explore Welile', body: 'An overview of what the platform offers.' },
  { icon: Wallet, title: 'Estimate rent access', body: 'Rough rent plan figures for an amount you name.' },
  { icon: Wallet, title: 'Estimate supporter returns', body: 'Indicative returns on a supporter contribution.' },
  { icon: Home, title: 'Find available houses', body: 'Public listings by area and budget.' },
];

function ToolList({ tools }: { tools: { icon: typeof Wallet; title: string; body: string }[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {tools.map((t) => (
        <li key={t.title} className="flex gap-3 rounded-lg border p-3">
          <t.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-sm font-medium">{t.title}</p>
            <p className="text-xs text-muted-foreground">{t.body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function ConnectAI() {
  const navigate = useNavigate();

  return (
    <>
      <Helmet>
        <title>Connect Welile to ChatGPT or Claude | Welile</title>
        <meta
          name="description"
          content="Step-by-step instructions and the exact MCP connection URL for using your Welile wallet, statements and house listings inside ChatGPT or Claude."
        />
        <link rel="canonical" href="https://welileapp.com/connect-ai" />
      </Helmet>

      <main className="mx-auto max-w-3xl px-4 py-6 pb-24 sm:py-10">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-4 -ml-2">
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>

        <header className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Connect Welile to ChatGPT or Claude</h1>
          <p className="mt-2 text-muted-foreground">
            Welile speaks the Model Context Protocol (MCP), so you can ask an AI assistant about your wallet, pull a
            statement, or browse houses without leaving the chat. Pick a connection, paste the URL, and follow the steps.
          </p>
        </header>

        <Tabs defaultValue="personal" className="space-y-6">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="personal">Personal (sign in)</TabsTrigger>
            <TabsTrigger value="public">Public (no sign in)</TabsTrigger>
          </TabsList>

          <TabsContent value="personal" className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Lock className="h-4 w-4 text-primary" />
                  <CardTitle className="text-base">Your own Welile account</CardTitle>
                  <Badge className="gap-1 bg-primary text-primary-foreground hover:bg-primary">
                    <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                    Recommended
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <UrlBox label="MCP server URL" url={SIGNED_IN_URL} />
                <p className="text-sm text-muted-foreground">
                  You sign in with your normal Welile account and approve access once. The assistant then sees only your
                  own records — never anyone else's.
                </p>
                <ToolList tools={SIGNED_IN_TOOLS} />
                <Button variant="outline" size="sm" onClick={() => navigate('/mcp-tool-test')}>
                  Test these tools on my account
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Set up in ChatGPT</CardTitle>
              </CardHeader>
              <CardContent>
                <Steps items={CHATGPT_STEPS} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Set up in Claude</CardTitle>
              </CardHeader>
              <CardContent>
                <Steps items={CLAUDE_STEPS} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="public" className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-primary" />
                  <CardTitle className="text-base">Public information only</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <UrlBox label="Public MCP server URL" url={PUBLIC_URL} />
                <p className="text-sm text-muted-foreground">
                  No login and no approval screen — useful for sharing with someone who is still deciding whether to join.
                  It answers only from public information and cannot reach any account, wallet or personal record.
                </p>
                <ToolList tools={PUBLIC_TOOLS} />
                <Button variant="outline" size="sm" onClick={() => navigate('/public-tools')}>
                  Full tool reference & example prompts
                </Button>
                <p className="text-sm text-muted-foreground">
                  Add it exactly like the personal connection above, but with this URL — the sign-in step is skipped.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Card className="mt-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">If it does not connect</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Custom connectors are missing.</span> ChatGPT requires a paid
              plan for custom connectors, and both apps hide them on some mobile builds. Use the web or desktop version.
            </p>
            <p>
              <span className="font-medium text-foreground">The URL is rejected.</span> Copy it with the button above so
              no stray spaces or line breaks sneak in.
            </p>
            <p>
              <span className="font-medium text-foreground">Sign-in loops.</span> Log in to Welile in the same browser
              first, then retry the connector so the approval screen can load your session.
            </p>
            <p>
              <span className="font-medium text-foreground">Tools return nothing.</span> Open the assistant's tool menu
              and confirm the Welile connector is switched on for that conversation.
            </p>
          </CardContent>
        </Card>
      </main>
    </>
  );
}