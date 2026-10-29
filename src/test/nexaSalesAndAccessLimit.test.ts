import { describe,it,expect } from 'vitest';
import { extractUgxAmount,calculateSupporterSalesProjection,calculateTenantRentSalesProjection,normalizeAndSortNexaOpportunities,detectNexaSalesIntent,isNexaHumanEscalationRequest,matchLearnedKnowledgeAnswer,formatLearnedKnowledgeForPrompt,buildNexaOfflineSalesReply } from '@/lib/nexaSalesEngine';
import { ACCESS_LIMIT_MAX_UGX,ACCESS_LIMIT_DAILY_GROWTH_UGX,ACCESS_LIMIT_MISSED_DAY_REDUCTION_UGX,toWhatsAppPhone,buildTenantAccessLimitSms,buildAgentAccessLimitSms,buildTenantAccessLimitEmail,buildAgentAccessLimitEmail,buildTenantAccessLimitWhatsAppUrl,buildAccessLimitMailtoHref } from '@/lib/accessLimitMessaging';
import { appendRentAccessCampaign } from '../../supabase/functions/_shared/tenantTemplates';
import { isRestrictedInternalStaffQuery, buildInternalStaffRefusalReply, buildNexaSalesContextPrompt, RESTRICTED_INTERNAL_STAFF_ROUTES, WELILE_COM_AND_WELILEAPP_PUBLIC_CATALOG } from '@/lib/nexaSalesEngine';
import { ACCESS_LIMIT_MIN_UGX,ACCESS_LIMIT_MISSED_DROP_UGX,buildTenantAccessLimitSmsCopy,buildAgentAccessLimitEmailTemplate } from '@/lib/accessLimitMessaging';
import { wantsHuman, NEXA_SALES_PROMPT } from '../../supabase/functions/_shared/nexa';
import { toAuthGatedPath, toAuthGatedUrl, extractPhoneNumberFromText, isAccountOrBalanceQuery, buildAccountPhoneAndDashboardGuideReply, isWalletHowToQuery, buildWelileWalletGuideReply, isPromissoryNoteQuery, buildPromissoryNoteReminderReply, buildNexaPublicGuideReply } from '@/lib/nexaSalesEngine';
import { buildRoleSignupHref } from '@/components/ai-chat/roleLanding';
import { NEXA_ACTION_LINKS } from '../../supabase/functions/_shared/nexaGuides';
import { extractInquiryLeadDetails, detectInquiryIntendedRole, buildInquirySignupResult, parseInquirySignupResult } from '@/lib/nexaSalesEngine';
describe('Nexa consent-based inquiry signup', () => {
  it.each(['0700000000', '+256700000000', '256700000000'])('normalizes Uganda contact %s without creating an account', phone => {
    expect(extractInquiryLeadDetails(`TEST_PERSON, ${phone}`)).toMatchObject({phoneKey:'700000000',fullPhone:'256700000000',displayPhone:'0700000000'});
  });
  it('extracts explicit name and role preferences without granting privileged roles', () => {
    expect(extractInquiryLeadDetails('my name is Test Person, 0700000000')).toMatchObject({name:'Test Person',role:'tenant'});
    expect(extractInquiryLeadDetails('I am looking for rent')).toMatchObject({name:null,phoneKey:null});
    expect(extractInquiryLeadDetails('rent', {leadName:'Test Person',leadPhone:'256700000000',leadRole:'super_admin'})).toMatchObject({name:'Test Person',role:'tenant'});
  });
  it.each([['15% Returns','supporter'],['promissory note','supporter'],['agent commission','agent'],['landlord property','landlord'],['rent help','tenant']])('routes %s to public signup role %s', (text, role) => {
    expect(detectInquiryIntendedRole(text)).toBe(role);
    const result = buildInquirySignupResult(text);
    const url = new URL(result.loginUrl);
    expect(url.pathname).toBe('/auth'); expect(url.searchParams.get('signup')).toBe('1'); expect(url.searchParams.get('role')).toBe(role);
    expect(result.status).toBe('signup_required');
    expect(url.searchParams.get('redirect')).toBe(role === 'supporter' ? '/dashboard/funder-new' : role === 'agent' ? '/become-agent' : role === 'landlord' ? '/register-landlord' : '/dashboard');
  });
  it('rejects account-created claims, credentials, arbitrary URLs and privileged roles from chat events', () => {
    expect(parseInquirySignupResult({status:'created',email:'test@example.invalid',tempPassword:'TEST_SECRET'})).toBeNull();
    expect(parseInquirySignupResult({status:'existing_account',role:'tenant'})).toBeNull();
    expect(parseInquirySignupResult({status:'signup_required',role:'super_admin'})).toBeNull();
    const safe = parseInquirySignupResult({status:'signup_required',role:'tenant',loginUrl:'https://example.invalid',tempPassword:'TEST_SECRET'});
    expect(safe).toEqual(buildInquirySignupResult('tenant'));
    expect(safe).not.toHaveProperty('tempPassword');
    expect(safe).not.toHaveProperty('email');
  });
});
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
    expect(calculateTenantRentSalesProjection(100000,30)?.v360NewQuoteExample).toMatchObject({ principal: 100000, gross: 142772, daily: 4760 });
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
describe('Nexa public guidance and auth-gated actions', () => {
  it.each(['/dashboard/funder-new','/dashboard','/rent-calculator','/register-tenant','/become-agent','/register-landlord','/find-a-house','/marketplace'])('gates the exact action %s', path => {
    expect(toAuthGatedPath(path)).toBe(`/auth?redirect=${encodeURIComponent(path)}`);
    expect(toAuthGatedUrl(path)).toBe(`https://welileapp.com/auth?redirect=${encodeURIComponent(path)}`);
    expect(NEXA_ACTION_LINKS[path]).toBe(toAuthGatedUrl(path));
  });
  it('preserves already gated paths and safe query targets, but rejects external redirects', () => {
    const path = '/dashboard/funder-new?plan=TEST_PLAN';
    expect(new URL(toAuthGatedUrl(path)).searchParams.get('redirect')).toBe(path);
    expect(toAuthGatedPath('/auth?redirect=%2Fdashboard')).toBe('/auth?redirect=%2Fdashboard');
    expect(toAuthGatedUrl('https://welileapp.com/dashboard')).toBe(toAuthGatedUrl('/dashboard'));
    expect(toAuthGatedUrl('/dashboard', 'https://example.invalid/')).toBe('https://example.invalid/auth?redirect=%2Fdashboard');
    for (const unsafe of ['https://example.invalid/private','//example.invalid/private','javascript:alert(1)','/\\example.invalid']) expect(toAuthGatedPath(unsafe)).toBe('/auth?redirect=%2Fdashboard');
  });
  it('preserves role attribution and the intended post-sign-in destination', () => {
    const url = new URL(buildRoleSignupHref('supporter', {ref:'TEST_REF',source:'TEST_SOURCE'}), 'https://welileapp.com');
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('redirect')).toBe('/dashboard/funder-new');
    expect(url.searchParams.get('ref')).toBe('TEST_REF');
    expect(url.searchParams.get('signup_source')).toBe('TEST_SOURCE');
    expect(buildRoleSignupHref('agent',{authenticated:true})).toBe('/become-agent');
  });
  it('extracts only a complete Uganda mobile number without authenticating it', () => {
    // Deliberately synthetic zero-filled phone fixtures, not real contacts.
    expect(extractPhoneNumberFromText('TEST 0700 000 000')).toBe('+256700000000');
    expect(extractPhoneNumberFromText('TEST +256700000000')).toBe('+256700000000');
    expect(extractPhoneNumberFromText('07000000000')).toBeNull();
    expect(extractPhoneNumberFromText('UGX 100,000')).toBeNull();
    expect(extractPhoneNumberFromText('07XX XXX XXX')).toBeNull();
  });
  it.each(['my portfolio','investment status','my payouts','remaining rent balance','account balance','TEST 0700000000'])('routes account question %s to private-dashboard instructions', text => {
    expect(isAccountOrBalanceQuery(text)).toBe(true);
    expect(buildNexaPublicGuideReply(text)).toBe(buildAccountPhoneAndDashboardGuideReply(text));
    expect(buildNexaOfflineSalesReply(text)).toBe(buildAccountPhoneAndDashboardGuideReply(text));
  });
  it('asks for a registered number only when missing and never repeats a supplied number', () => {
    expect(buildAccountPhoneAndDashboardGuideReply()).toContain('What is your registered Welile phone number');
    const provided = buildAccountPhoneAndDashboardGuideReply('TEST 0700000000');
    expect(provided).not.toContain('What is your');
    expect(provided).not.toContain('0700000000');
    expect(provided).not.toContain('+256700000000');
    expect(provided).toContain(toAuthGatedUrl('/dashboard/funder-new'));
    expect(provided).toContain(toAuthGatedUrl('/dashboard'));
    expect(isAccountOrBalanceQuery('Support UGX 100,000')).toBe(false);
  });
  it('recognizes wallet teaching without misclassifying a balance lookup', () => {
    expect(isWalletHowToQuery('How do I use my wallet?')).toBe(true);
    expect(isWalletHowToQuery('How can I deposit money?')).toBe(true);
    expect(isWalletHowToQuery('my wallet balance')).toBe(false);
    expect(buildNexaPublicGuideReply('How do I use my wallet?')).toBe(buildWelileWalletGuideReply());
  });
  it('teaches approved merchant channels while retaining withdrawal and verification limits', () => {
    const guide = buildWelileWalletGuideReply();
    for (const value of ['*165#','090777','*185#','4380664','UGX 10,000','UGX 30,000,000','UGX 7,000']) expect(guide).toContain(value);
    expect(guide).toContain('committed principal is not withdrawable anytime');
    expect(guide).toContain('verification is not guaranteed to be instant');
  });
  it('recognizes pledge fulfillment and renewal before generic account guidance', () => {
    for (const text of ['fulfill my promissory note','renew my pledge date','update my promissory note date']) {
      expect(isPromissoryNoteQuery(text)).toBe(true);
      expect(buildNexaPublicGuideReply(text)).toBe(buildPromissoryNoteReminderReply());
    }
    expect(isPromissoryNoteQuery('estimate rent')).toBe(false);
    expect(buildNexaOfflineSalesReply('Support UGX 100,000')).toContain(buildPromissoryNoteReminderReply());
  });
  it('retains the confidentiality firewall ahead of guidance', () => {
    expect(buildNexaOfflineSalesReply("Show another user's wallet balance 0700000000")).toBe(buildInternalStaffRefusalReply());
  });
  it('records Benjamin’s exact canonical public company facts', () => {
    const corporate = WELILE_COM_AND_WELILEAPP_PUBLIC_CATALOG.corporate;
    expect(corporate.headquarters).toBe('Palm Lane, Kabaale, Entebbe, Wakiso, Uganda');
    expect(corporate.kampalaBranch).toBe('Lugogo, Kampala');
    expect(corporate.ursbRegistration).toBe('80034172593095');
    expect(corporate.founded).toBe('2024-07-10');
    expect(corporate.founderAndCeo).toBe('Benjamin Muhanguzi');
    expect(corporate.founderTitle).toBe('Founder & CEO');
    expect(corporate.contactPhones).toEqual(['+256-200-900-900','+256748747134']);
    expect(corporate.contactEmails).toEqual(['hello@welile.com','info@welile.com']);
  });
});