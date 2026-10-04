import * as React from 'npm:react@18.3.1'
import { renderAsync } from 'npm:@react-email/components@0.0.22'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { TEMPLATES } from '../_shared/transactional-email-templates/registry.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const adminClient = createClient(supabaseUrl, serviceKey)

    const authHeader =
      req.headers.get('authorization') || req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await adminClient.auth.getUser(token)
    if (authError || !user) return json({ error: 'Unauthorized' }, 401)

    const { data: roles } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .in('role', ['cto', 'super_admin', 'manager'])
    if (!roles || roles.length === 0) {
      return json({ error: 'Insufficient permissions' }, 403)
    }

    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return json({ error: 'id is required' }, 400)

    const { data: row, error: rowErr } = await adminClient
      .from('email_send_log')
      .select('id, message_id, template_name, recipient_email, status, error_message, created_at, metadata')
      .eq('id', id)
      .maybeSingle()
    if (rowErr) return json({ error: rowErr.message }, 500)
    if (!row) return json({ error: 'Email not found' }, 404)

    let metadata = (row.metadata ?? {}) as Record<string, unknown>

    // Fallback: 'sent'/'failed' rows historically don't carry metadata —
    // it lives on the sibling 'pending' row written by send-transactional-email.
    // Look it up by message_id when the current row is missing template_data.
    const hasTemplateData =
      metadata.template_data && typeof metadata.template_data === 'object'
    if (!hasTemplateData) {
      // message_id column on email_send_log links the lifecycle rows
      const { data: sibling } = await adminClient
        .from('email_send_log')
        .select('metadata')
        .eq('message_id', (row as any).message_id ?? '')
        .not('metadata', 'is', null)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (sibling?.metadata && typeof sibling.metadata === 'object') {
        metadata = sibling.metadata as Record<string, unknown>
      }
    }

    const storedSubject = typeof metadata.subject === 'string' ? metadata.subject : null
    const templateData =
      metadata.template_data && typeof metadata.template_data === 'object'
        ? (metadata.template_data as Record<string, unknown>)
        : null

    const template = TEMPLATES[row.template_name as string]

    let html: string | null = null
    let subject: string | null = storedSubject
    let renderError: string | null = null

    if (!template) {
      renderError = `Template "${row.template_name}" is not in the current registry.`
    } else if (!templateData) {
      renderError =
        'No template data was archived for this email (sent before body archiving was enabled).'
    } else {
      try {
        html = await renderAsync(
          React.createElement(template.component, templateData),
        )
        if (!subject) {
          subject =
            typeof template.subject === 'function'
              ? template.subject(templateData)
              : template.subject
        }
      } catch (e) {
        renderError = e instanceof Error ? e.message : 'Failed to render template.'
      }
    }

    return json(
      {
        id: row.id,
        templateName: row.template_name,
        recipientEmail: row.recipient_email,
        status: row.status,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        subject,
        html,
        renderError,
      },
      200,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return json({ error: message }, 500)
  }
})