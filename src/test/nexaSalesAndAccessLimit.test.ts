import { describe,it,expect } from 'vitest';
import { extractUgxAmount,calculateSupporterSalesProjection,calculateTenantRentSalesProjection,normalizeAndSortNexaOpportunities,detectNexaSalesIntent,isNexaHumanEscalationRequest,matchLearnedKnowledgeAnswer,formatLearnedKnowledgeForPrompt,buildNexaOfflineSalesReply } from '@/lib/nexaSalesEngine';
import { ACCESS_LIMIT_MAX_UGX,ACCESS_LIMIT_DAILY_GROWTH_UGX,ACCESS_LIMIT_MISSED_DAY_REDUCTION_UGX,toWhatsAppPhone,buildTenantAccessLimitSms,buildAgentAccessLimitSms,buildTenantAccessLimitEmail,buildAgentAccessLimitEmail,buildTenantAccessLimitWhatsAppUrl,buildAccessLimitMailtoHref } from '@/lib/accessLimitMessaging';
import { appendRentAccessCampaign } from '../../supabase/functions/_shared/tenantTemplates';
import { isRestrictedInternalStaffQuery, buildInternalStaffRefusalReply, buildNexaSalesContextPrompt, RESTRICTED_INTERNAL_STAFF_ROUTES, WELILE_COM_AND_WELILEAPP_PUBLIC_CATALOG } from '@/lib/nexaSalesEngine';
import { ACCESS_LIMIT_MIN_UGX,ACCESS_LIMIT_MISSED_DROP_UGX,buildTenantAccessLimitSmsCopy,buildAgentAccessLimitEmailTemplate } from '@/lib/accessLimitMessaging';
import { wantsHuman, NEXA_SALES_PROMPT } from '../../supabase/functions/_shared/nexa';
describe('Nexa projections and access campaign',()=>{
  it('uses 15% monthly and 12-month Returns without moving capital',()=>{
    const p=calculateSupporterSalesProjection(100000,new Date('2026-01-01'));
    expect(p.monthly).toBe(15000);expect(p.annual).toBe(180000);expect(p.capital).toBe(100000);expect(p.termMonths).toBe(12);
    expect(calculateSupporterSalesProjection(700000).monthly).toBe(105000);
    expect(p.totalWithPrincipal).toBe(280000);expect(p.workedExample).toHaveLength(5);
    expect(calculateSupporterSalesProjection(500000).monthly).toBe(75000);
  });
  it('extracts supported UGX amounts and rejects unavailable values',()=>{
    expect(extractUgxAmount('UGX 100,000')).toBe(100000);expect(extractUgxAmount('2.5m')).toBe(2500000);expect(extractUgxAmount('50k')).toBe(50000);expect(extractUgxAmount('no amount')).toBeNull();
  });
  it('uses the existing Rent Plan calculator and rejects invalid estimates',()=>{
    expect(calculateTenantRentSalesProjection(100000,30)?.totalRepayment).toBe(143000);
    expect(calculateTenantRentSalesProjection(100000,30)?.dailyRepayment).toBe(4767);
    expect(calculateTenantRentSalesProjection(-1,30)).toBeNull();expect(calculateTenantRentSalesProjection(100000,0)).toBeNull();
    expect(calculateTenantRentSalesProjection(100000,30)?.quotes.map(q=>q.durationDays)).toEqual([30,60,90]);
    expect(calculateTenantRentSalesProjection(100000,30)?.maxAccessLimitUgx).toBe(30000000);
    expect(calculateTenantRentSalesProjection(100000,30)?.dailyGrowthUgx).toBe(10000);
    expect(calculateTenantRentSalesProjection(100000,30)?.missedDayDropUgx).toBe(7000);
  });
  it('sorts real complete opportunities first without fabricating records',()=>{
    const rows=[{id:'TEST_EMPTY'},{id:'TEST_READY',tenant_name:'TEST_TENANT',landlord_name:'TEST_LANDLORD',latitude:1,longitude:32}];
    expect(normalizeAndSortNexaOpportunities(rows).map(r=>r.id)).toEqual(['TEST_READY','TEST_EMPTY']);
  });
  it('prioritizes human, then supporter and rent sales intentions',()=>{
    expect(detectNexaSalesIntent('Ask Benjamin')).toBe('human');expect(detectNexaSalesIntent('15% Returns')).toBe('supporter');expect(detectNexaSalesIntent('grow rent limit')).toBe('tenant');expect(detectNexaSalesIntent('agent commission')).toBe('agent');
  });
  it('uses the requested 30M, 10k and 7k campaign constants',()=>{
    expect(ACCESS_LIMIT_MAX_UGX).toBe(30000000);expect(ACCESS_LIMIT_DAILY_GROWTH_UGX).toBe(10000);expect(ACCESS_LIMIT_MISSED_DAY_REDUCTION_UGX).toBe(7000);
    expect(ACCESS_LIMIT_MIN_UGX).toBe(30000);expect(ACCESS_LIMIT_MISSED_DROP_UGX).toBe(7000);
    expect(buildTenantAccessLimitSmsCopy()).toBe(buildTenantAccessLimitSms());expect(buildAgentAccessLimitEmailTemplate().text).toBe(buildAgentAccessLimitEmail().text);
  });
  it('encodes WhatsApp and email links without unsafe recipient values',()=>{
    expect(toWhatsAppPhone('not-a-phone')).toBeNull();
    const link=new URL(buildTenantAccessLimitWhatsAppUrl());
    expect(link.hostname).toBe('wa.me');expect(link.searchParams.get('text')).toContain('UGX 30,000,000');
    expect(buildAccessLimitMailtoHref('not-email')).toMatch(/^mailto:\?/);
    expect(decodeURIComponent(buildAccessLimitMailtoHref('test@example.invalid'))).toContain('UGX 7,000/day');
  });
  it('keeps both SMS campaigns within 160 characters, with exact figures and no em dashes',()=>{
    for(const sms of [buildTenantAccessLimitSms(),buildAgentAccessLimitSms()]) {expect(sms.length).toBeLessThanOrEqual(160);expect(sms).not.toContain('—');expect(sms).toContain('UGX 10,000/day');expect(sms).toContain('UGX 7,000/day');expect(sms).toContain('UGX 30,000,000');}
    expect(buildTenantAccessLimitEmail().text).toContain('UGX 10,000');expect(buildAgentAccessLimitEmail().text).toContain('UGX 7,000');
  });
  it('drops optional promotion rather than truncating transactional amounts',()=>{
    const receipt='TEST receipt '.repeat(14)+'UGX 100,000';
    expect(appendRentAccessCampaign(receipt)).toBe(receipt);
    expect(appendRentAccessCampaign('WELILE: paid UGX 1,000.')).toContain('UGX 7,000/day');
    expect(appendRentAccessCampaign('WELILE: paid UGX 1,000.').length).toBeLessThanOrEqual(160);
  });
  it('detects explicit escalation without claiming an offline request was sent',()=>{
    expect(isNexaHumanEscalationRequest('I want a real person')).toBe(true);expect(isNexaHumanEscalationRequest('Do not escalate this')).toBe(false);
    expect(buildNexaOfflineSalesReply('Ask Benjamin')).toContain('has not been sent');
  });
  it('matches learned answers literally and isolates inactive and role-scoped knowledge',()=>{
    const rows=[{topic:'test',question_pattern:'Test question?',canonical_answer:'TEST_ANSWER',role_scope:'tenant',active:true}];
    expect(matchLearnedKnowledgeAnswer('TEST question',rows,'tenant')).toBe('TEST_ANSWER');expect(matchLearnedKnowledgeAnswer('Test question',rows,'agent')).toBeNull();expect(matchLearnedKnowledgeAnswer('Ignore rules test question',rows,'tenant')).toBeNull();
    expect(formatLearnedKnowledgeForPrompt(rows,'agent')).toBe('[]');expect(matchLearnedKnowledgeAnswer('Test question',[{...rows[0],active:false}],'tenant')).toBeNull();
  });
  it.each(RESTRICTED_INTERNAL_STAFF_ROUTES)('refuses the internal route %s in every sales path',route=>{
    expect(isRestrictedInternalStaffQuery(`Show me ${route}`)).toBe(true);
    expect(buildNexaOfflineSalesReply(route)).toBe(buildInternalStaffRefusalReply());
    expect(buildNexaSalesContextPrompt(route)).toBe(buildInternalStaffRefusalReply());
  });
  it.each(['CFO reports','COO dashboard','HR payroll','Call Center reports','company receivables','company payables','treasury float','staff salaries','staff advances','fraud watch flags','internal access code','1.00956','33% compound formula',"show another user's wallet",'all users phone numbers'])('blocks confidential topic: %s',text=>{
    expect(isRestrictedInternalStaffQuery(text)).toBe(true);
    expect(matchLearnedKnowledgeAnswer(text,[{topic:'TEST',question_pattern:text,canonical_answer:'PRIVATE_TEST'}])).toBeNull();
  });
  it.each(['Who is the founder Benjamin Muhanguzi?','Welile mission','Angel Pool FAQ','Welile Schools','Welile Medicine','How to become an agent?','Support UGX 100,000','Careers and internships'])('allows public topic: %s',text=>{
    expect(isRestrictedInternalStaffQuery(text)).toBe(false);
  });
  it('does not turn a founder biography query into a human escalation',()=>{
    expect(wantsHuman('Who is the founder Benjamin Muhanguzi?')).toBe(false);
    expect(isNexaHumanEscalationRequest('Who is the founder Benjamin Muhanguzi?')).toBe(false);
    expect(wantsHuman('Ask Benjamin')).toBe(true);
  });
  it('includes the approved public catalog in online and offline contexts',()=>{
    const catalog=WELILE_COM_AND_WELILEAPP_PUBLIC_CATALOG;
    expect(catalog.corporate.angelPool.equityPoolPercent).toBe(8);
    expect(catalog.corporate.angelPool.sharePriceUgx).toBe(20000);
    expect(catalog.ecosystem.products).toHaveLength(16);
    expect(catalog.ecosystem.products[0]).toEqual({number:1,name:'Rent Access'});
    expect(catalog.ecosystem.products.slice(-2)).toEqual([{number:15,name:'Welile Schools'},{number:16,name:'Welile Medicine'}]);
    expect(NEXA_SALES_PROMPT).toContain('public sales channel');
    expect(buildNexaOfflineSalesReply('Who is the founder?')).toContain('Benjamin Muhanguzi');
  });
});