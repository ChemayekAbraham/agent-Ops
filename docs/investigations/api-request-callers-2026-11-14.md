# Exact API request caller trace

Source-only changes; no permissions, migrations, buckets, publication, or function deployments.

| Reported request | Current source evidence and action |
| --- | --- |
| user_roles embedding profiles:user_id | Frontend: `src/components/cfo/ProxyAgentManager.tsx`, bulk partner pool. Replaced with paged role IDs followed by batched profiles.id reads. |
| staff_profiles selecting full_name, phone, role, status | No matching caller in frontend or edge-function source. Current staff reads use supported columns or `*`; no invented replacement caller. |
| wallet_transactions selecting user_id/type/reference/status or filtering wallet_id | No matching read in frontend or edge-function source. Current frontend transfer reads use sender_id/recipient_id and valid columns. |
| partner_agreements OR including user_id | No matching caller in frontend or edge-function source. Current agreement reads use partner_id (and id for specific records). |
| nexa_learned_knowledge with role_scope and created_at sorting | Edge function: `welile-ai-chat`. Removed missing-table read, using empty learned knowledge; role checks, tools and public/internal privacy gates preserved. |
| nexa_learned_knowledge public scope | Edge function: `whatsapp-webhook`. Removed missing-table read, using empty learned knowledge; signature checks, public guides and delivery behavior preserved. |
| email_suppressions bulk email lookup | Edge function: `coo-broadcast-partners`. Verified `suppressed_emails(email)` via live column metadata and existing unsubscribe/queue code. Uses that real source, aborting on lookup errors rather than bypassing suppression. |
| proxy_agent_identities, partner_profiles, agent_profiles | No table callers in current frontend or edge-function source. Similar RPC names are not these tables and were left untouched. |
| resolve_short_link singular-response 406 | Frontend: `ResolveRLink`, `TrackedRedirect`, `SelfPortfolioFundingCard`. All already used maybeSingle; now request ordinary arrays with limit(1), consuming the first row, so zero rows do not use the singular media type. |

Unmatched production requests require their originating page/client version or deployed function source; request URLs alone do not prove frontend versus edge provenance. The three named edge functions have source fixes only and have not been deployed. Authenticated production flow/error reduction remains unverified.