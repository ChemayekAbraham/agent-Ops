import { calculatePayslip } from './index';
import { PROVISIONAL_RULE, TEST_CASES } from './testCases';

const fmt = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);

export default function CalculatorSelfCheck() {
  const rows = TEST_CASES.map((testCase) => {
    const result = calculatePayslip(testCase.inputs, PROVISIONAL_RULE, testCase.lstMonthly, 0);
    const passed =
      result.paye === testCase.expected.paye &&
      result.nssfEmployee === testCase.expected.nssfEmployee &&
      result.nssfEmployer === testCase.expected.nssfEmployer &&
      result.net === testCase.expected.net &&
      result.employerCost === testCase.expected.employerCost;
    return { testCase, result, passed };
  });

  const passing = rows.filter((r) => r.passed).length;
  const allPass = passing === TEST_CASES.length;
  const caseEight = rows.find((r) => r.testCase.id === 8);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Payroll calculator self-check</h1>
        <p className="text-sm text-muted-foreground">
          Twelve synthetic cases. No real staff data on this screen.
        </p>
      </header>

      <p
        className={`text-lg font-semibold ${allPass ? 'text-green-600' : 'text-red-600'}`}
        data-testid="calculator-self-check-summary"
      >
        {passing} of {TEST_CASES.length} passing
      </p>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Case</th>
              <th className="px-3 py-2 text-right font-medium">Gross</th>
              <th className="px-3 py-2 text-right font-medium">PAYE expected</th>
              <th className="px-3 py-2 text-right font-medium">PAYE computed</th>
              <th className="px-3 py-2 text-right font-medium">Net expected</th>
              <th className="px-3 py-2 text-right font-medium">Net computed</th>
              <th className="px-3 py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ testCase, result, passed }) => (
              <tr
                key={testCase.id}
                className={`border-t border-border ${passed ? '' : 'bg-red-50 dark:bg-red-950/30'}`}
              >
                <td className="px-3 py-2">
                  {testCase.id}. {testCase.name}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(result.gross)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(testCase.expected.paye)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(result.paye)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(testCase.expected.net)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(result.net)}</td>
                <td
                  className={`px-3 py-2 font-semibold ${passed ? 'text-green-600' : 'text-red-600'}`}
                >
                  {passed ? 'PASS' : 'FAIL'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="rounded-lg border border-border p-4">
        <h2 className="mb-3 text-base font-semibold">Calculation trace, case 8</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          {(caseEight?.result.trace ?? []).map((sentence, index) => (
            <li key={index}>{sentence}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}