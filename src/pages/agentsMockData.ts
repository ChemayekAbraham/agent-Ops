/** Design fixtures only; this module never accesses financial records. */
export interface MockTenant { id: number; name: string; area: string; expected: number; collected: number }
const names = ['Sarah Namusoke', 'David Ssekabira', 'Grace Nakato', 'Isaac Kato', 'Mary Nankya', 'Joseph Mugisha', 'Ruth Akello', 'Peter Ssemakula', 'Esther Nambi', 'Daniel Okello', 'Rebecca Auma', 'John Ssentongo', 'Agnes Nabirye', 'Samuel Kintu', 'Florence Atim', 'Michael Tumusiime', 'Diana Nansubuga', 'Paul Ochieng', 'Lydia Katusiime', 'Andrew Mutebi', 'Martha Achieng', 'Stephen Waiswa', 'Joan Namatovu', 'Emmanuel Otim'];
export const MOCK_TENANTS: MockTenant[] = names.map((name, index) => {
  const expected = [5000, 8000, 6500, 10000][index % 4];
  return { id: index + 1, name, area: ['Kira · Nsasa', 'Kampala · Ntinda', 'Wakiso · Kireka', 'Kampala · Kisaasi'][index % 4], expected, collected: index % 5 === 0 ? expected : index % 3 === 0 ? 2000 : 0 };
});
export const MOCK_TOTALS = MOCK_TENANTS.reduce((sum, t) => ({ expected: sum.expected + t.expected, collected: sum.collected + t.collected }), { expected: 0, collected: 0 });
/** Ten-record page contract for design; connect to an authorized RPC in a later stage. */
export async function loadMockTenantPage(offset: number): Promise<MockTenant[]> { return MOCK_TENANTS.slice(offset, offset + 10); }