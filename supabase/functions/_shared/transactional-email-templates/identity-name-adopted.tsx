import * as React from 'npm:react@18.3.1'
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './types.ts'

interface Props {
  recipient_name?: string
  id_name?: string
  previous_name?: string
}

export function IdentityNameAdopted({
  recipient_name = 'there',
  id_name = '',
  previous_name = '',
}: Props) {
  const changed = !!previous_name && previous_name.toLowerCase() !== id_name.toLowerCase()
  return (
    <Html>
      <Head />
      <Preview>{`Your account name is now ${id_name}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Your account name matches your National ID</Heading>
          <Text style={text}>Hi {recipient_name},</Text>
          <Text style={text}>
            We read the name printed on the National ID you sent and used it as the name on your
            Welile account. This happened automatically — there is nothing for you to change.
          </Text>

          <Section style={box}>
            <Text style={boxLabel}>Name on your account now</Text>
            <Text style={boxValue}>{id_name}</Text>
            {changed ? <Text style={boxNote}>Before: {previous_name}</Text> : null}
          </Section>

          <Text style={text}>
            Keeping this name exactly as it appears on your National ID is what lets your money
            reach you without delays.
          </Text>

          <Hr style={hr} />
          <Text style={footer}>Welile · Trusted rent &amp; receipts for Uganda</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: IdentityNameAdopted,
  subject: 'Your account name now matches your National ID',
  displayName: 'National ID name applied',
  previewData: {
    recipient_name: 'Sarah',
    id_name: 'NAKATO SARAH',
    previous_name: 'Sarah N.',
  },
} satisfies TemplateEntry

const main: React.CSSProperties = {
  backgroundColor: '#ffffff',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
}
const container: React.CSSProperties = {
  margin: '0 auto',
  padding: '32px 24px',
  maxWidth: '560px',
  backgroundColor: '#ffffff',
  borderRadius: '12px',
}
const h1: React.CSSProperties = {
  color: '#0f172a',
  fontSize: '22px',
  fontWeight: 700,
  margin: '0 0 16px',
}
const text: React.CSSProperties = {
  color: '#334155',
  fontSize: '15px',
  lineHeight: '24px',
  margin: '0 0 12px',
}
const box: React.CSSProperties = {
  borderRadius: '10px',
  padding: '16px',
  margin: '8px 0 16px',
  backgroundColor: '#ecfdf5',
}
const boxLabel: React.CSSProperties = {
  color: '#047857',
  fontSize: '12px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  margin: '0 0 6px',
}
const boxValue: React.CSSProperties = {
  color: '#0f172a',
  fontSize: '18px',
  fontWeight: 700,
  margin: 0,
}
const boxNote: React.CSSProperties = {
  color: '#475569',
  fontSize: '13px',
  margin: '6px 0 0',
}
const hr: React.CSSProperties = {
  borderColor: '#e2e8f0',
  margin: '20px 0',
}
const footer: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: '12px',
  margin: 0,
}
