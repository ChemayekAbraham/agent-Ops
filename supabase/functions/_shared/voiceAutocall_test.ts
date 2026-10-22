import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { fillVariables, renderFrom, resolveMenu, terminalStatus, type RenderContext, type Script } from './voiceAutocall.ts';

const script: Script = {
  voice: 'woman',
  start: 'confirm',
  steps: {
    confirm: {
      type: 'menu',
      say: 'Hello {first_name}, press 1.',
      options: { '1': { next: 'main' } },
      no_input: { outcome: 'unconfirmed', next: 'end' },
      invalid: { next: 'confirm' },
    },
    main: {
      type: 'menu',
      say: 'You owe {amount} shillings.',
      options: {
        '1': { outcome: 'promise_to_pay', next: 'thanks' },
        '3': { next: 'transfer' },
        '9': { outcome: 'opted_out', action: 'opt_out', next: 'end' },
      },
      no_input: { outcome: 'no_choice', next: 'end' },
    },
    thanks: { type: 'say', say: 'Thank you & goodbye <now>.', next: 'end' },
    transfer: { type: 'transfer', say: 'Hold on.', outcome: 'transferred', fallback_next: 'busy' },
    busy: { type: 'say', say: 'Team busy.', outcome: 'callback_requested', next: 'end' },
    end: { type: 'hangup', say: 'Bye.' },
  },
};

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  script,
  variables: { first_name: 'Sarah', amount: '50,000' },
  callbackUrl: (kind, step, tries) => `https://x/ivr?job=J&step=${step}&kind=${kind}&try=${tries}`,
  transferNumbers: '',
  recordTransfers: true,
  ...over,
});

Deno.test('menu renders GetDigits with callback and a no-input redirect', () => {
  const r = renderFrom('confirm', ctx());
  assertStringIncludes(r.xml, '<GetDigits timeout="10" numDigits="1" callbackUrl="https://x/ivr?job=J&amp;step=confirm&amp;kind=digits&amp;try=0">');
  assertStringIncludes(r.xml, 'Hello Sarah, press 1.');
  assertStringIncludes(r.xml, '<Redirect>https://x/ivr?job=J&amp;step=confirm&amp;kind=noinput&amp;try=0</Redirect>');
  assertEquals(r.step, 'confirm');
  assertEquals(r.ends, false);
});

Deno.test('say steps chain into the hangup and text is XML-escaped', () => {
  const r = renderFrom('thanks', ctx());
  assertStringIncludes(r.xml, 'Thank you &amp; goodbye &lt;now&gt;.');
  assert(r.xml.endsWith('<Say voice="woman" playBeep="false">Bye.</Say><Hangup/></Response>'));
  assertEquals(r.ends, true);
});

Deno.test('transfer without team numbers falls back and sets the fallback outcome', () => {
  const r = renderFrom('transfer', ctx());
  assertEquals(r.outcome, 'callback_requested');
  assertStringIncludes(r.xml, 'Team busy.');
  assertEquals(r.ends, true);
});

Deno.test('transfer with team numbers dials and records', () => {
  const r = renderFrom('transfer', ctx({ transferNumbers: '+256700000001,+256700000002' }));
  assertStringIncludes(r.xml, '<Dial phoneNumbers="+256700000001,+256700000002" sequential="true" record="true"/>');
  assertEquals(r.transfers, true);
  assertEquals(r.outcome, 'transferred');
});

Deno.test('whole-call recording only on the first response', () => {
  assert(renderFrom('confirm', ctx({ recordWholeCall: true }), 0, true).xml.includes('<Response><Record/>'));
  assert(!renderFrom('confirm', ctx({ recordWholeCall: true }), 0, false).xml.includes('<Record/>'));
});

Deno.test('menu resolution: option, opt-out, one retry on a wrong key, then no-input path', () => {
  assertEquals(resolveMenu(script.steps.main, '1', 0).outcome, 'promise_to_pay');
  assertEquals(resolveMenu(script.steps.main, '9', 0).action, 'opt_out');
  const wrong = resolveMenu(script.steps.confirm, '7', 0);
  assertEquals([wrong.next, wrong.tries, wrong.logged], ['confirm', 1, 'invalid']);
  const wrongAgain = resolveMenu(script.steps.confirm, '7', 1);
  assertEquals([wrongAgain.next, wrongAgain.outcome], ['end', 'unconfirmed']);
  const silent = resolveMenu(script.steps.confirm, null, 0);
  assertEquals([silent.next, silent.outcome, silent.logged], ['end', 'unconfirmed', 'no_input']);
});

Deno.test('unknown placeholders are dropped, not spoken', () => {
  assertEquals(fillVariables('Hi {first_name} {nope}!', { first_name: 'Ann' }), 'Hi Ann !');
});

Deno.test('a say loop with no exit hangs up instead of spinning', () => {
  const loop: Script = { start: 'a', steps: { a: { type: 'say', say: 'x', next: 'b' }, b: { type: 'say', say: 'y', next: 'a' } } };
  const r = renderFrom('a', ctx({ script: loop }));
  assert(r.xml.endsWith('<Hangup/></Response>'));
  assertEquals(r.ends, true);
});

Deno.test('terminal status', () => {
  assertEquals(terminalStatus('Completed', true, 0), 'completed');
  assertEquals(terminalStatus('NotAnswered', false, 0), 'no_answer');
  assertEquals(terminalStatus('Busy', false, 0), 'busy');
  assertEquals(terminalStatus('Failed', false, 0), 'failed');
});
