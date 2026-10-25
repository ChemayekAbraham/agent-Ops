import { describe,it,expect } from 'vitest';
import { extractUgxAmount,calculateSupporterSalesProjection,calculateTenantRentSalesProjection,normalizeAndSortNexaOpportunities,detectNexaSalesIntent,isNexaHumanEscalationRequest,matchLearnedKnowledgeAnswer,formatLearnedKnowledgeForPrompt,buildNexaOfflineSalesReply } from '@/lib/nexaSalesEngine';
import { ACCESS_LIMIT_MAX_UGX,ACCESS_LIMIT_DAILY_GROWTH_UGX,ACCESS_LIMIT_MISSED_DAY_REDUCTION_UGX,toWhatsAppPhone,buildTenantAccessLimitSms,buildAgentAccessLimitSms,buildTenantAccessLimitEmail,buildAgentAccessLimitEmail,buildTenantAccessLimitWhatsAppUrl,buildAccessLimitMailtoHref } from '@/lib/accessLimitMessaging';
import { appendRentAccessCampaign } from '../../supabase/functions/_shared/tenantTemplates';
describe('Nexa projections and access campaign',()=>{
  it('uses 15% monthly and 12-month Returns without moving capital',()=>{
    const p=calculateSupporterSalesProjection(100000,new Date('2026-01-01'));
    expect(p.monthly).toBe(15000);expect(p.annual).toBe(180000);expect(p.capital).toBe(100000);expect(p.termMonths).toBe(12);
    expect(calculateSupporterSalesProjection(700000).monthly).toBe(105000);
  });
  it('extracts supported UGX amounts and rejects unavailable values',()=>{
    expect(extractUgxAmount('UGX 100,000')).toBe(100000);expect(extractUgxAmount('2.5m')).toBe(2500000);expect(extractUgxAmount('50k')).toBe(50000);expect(extractUgxAmount('no amount')).toBeNull();
  });
  it('uses the existing Rent Plan calculator and rejects invalid estimates',()=>{
    expect(calculateTenantRentSalesProjection(100000,30)?.totalRepayment).toBe(143000);
    expect(calculateTenantRentSalesProjection(100000,30)?.dailyRepayment).toBe(4767);
    expect(calculateTenantRentSalesProjection(-1,30)).toBeNull();expect(calculateTenantRentSalesProjection(100000,0)).toBeNull();
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
});