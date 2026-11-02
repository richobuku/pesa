/**
 * 25 offline tests for Pesa (`test/pesa.test.js`) using a fake Sheets API
 * laid out identically to the user's Budget Tracker workbook (`Settings`, `Spending`,
 * `Income`, `Transfers`, `Debts`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  parseAmount,
  parseDate,
  formatUGX,
  computeMonthOverview,
  findRecurringLeaks,
  computeCashflowTrend,
  filterTransactions,
  simulateDebtPayoff,
} from '../src/finance.js';

import {
  BudgetTrackerClient,
  spendingFormulasForRow,
  incomeFormulasForRow,
  transfersFormulasForRow,
} from '../src/sheets.js';

import { createWorkbookSheetsApi } from '../src/liveAdapter.js';
import { executeToolCall, recordUserEntry } from '../src/tools.js';
import { buildVocabularyPrompt, transcribeAudio } from '../src/transcribe.js';
import { verifyWebhookSignature, isAllowedNumber, sendWhatsAppMessage } from '../src/whatsapp.js';
import {
  isDuplicateMessage,
  resetDedupeCache,
  enqueueUserTask,
  extractMetaWebhookMessages,
  processIncomingWhatsAppMessage,
} from '../src/index.js';
import { auditSheet } from '../scripts/check-sheet.js';

/**
 * Build a fake Budget Tracker workbook matching the exact layout of `1K3g7mHvba2-AdwjvASYUwW7AvpFwyGXBqtKcIqJmrv0`.
 */
function buildFakeBudgetTrackerWorkbook() {
  const settingsValues = Array.from({ length: 60 }, () => []);
  // Buckets B10:D14 (0-indexed rows 9..13)
  settingsValues[9] = ['', 'Tithe (Maaser)', 0.1, 'The first tenth'];
  settingsValues[10] = ['', 'Savings', 0.2, 'Pay yourself next'];
  settingsValues[11] = ['', 'Personal Use', 0.3, 'Living costs'];
  settingsValues[12] = ['', 'Family', 0.3, 'Support for household'];
  settingsValues[13] = ['', 'Generosity', 0.1, 'Giving beyond tithe'];

  // Categories B19:D41 + Sources F19:G26 + Accounts I19:J21 + Paid-from L19:L22
  const cats = [
    ['T01', 'Tithe / Church offering', 'Tithe (Maaser)', 'I01', 'Salary', 'Cash', 0, 'Cash'],
    ['S01', 'Savings deposit', 'Savings', 'I02', 'Business income', 'Mobile Money', 0, 'Mobile Money'],
    ['S02', 'Emergency fund', 'Savings', 'I03', 'Consultancy / fees', 'Bank', 0, 'Bank'],
    ['S03', 'Investment', 'Savings', 'I04', 'Farm sales', '', '', 'ABSA Bank Credut Card'],
    ['P01', 'Rent / Housing', 'Personal Use', 'I05', 'Dividends / interest'],
    ['P02', 'Food & groceries', 'Personal Use', 'I06', 'Rental income'],
    ['P03', 'Transport & fuel', 'Personal Use', 'I07', 'Gift received'],
    ['P04', 'Utilities (power, water)', 'Personal Use', 'I99', 'Other income'],
    ['P05', 'Airtime & data', 'Personal Use'],
    ['P06', 'Health & medical', 'Personal Use'],
    ['P07', 'Clothing & personal care', 'Personal Use'],
    ['P08', 'Entertainment & leisure', 'Personal Use'],
    ['P09', 'Loan repayment', 'Personal Use'],
    ['P10', 'Bank & mobile money charges', 'Personal Use'],
    ['P11', 'Interest & charges on debt', 'Personal Use'],
    ['F01', 'School fees', 'Family'],
    ['F02', 'Household support', 'Family'],
    ['F03', 'Support to parents & relatives', 'Family'],
    ['F04', 'Family events & gifts', 'Family'],
    ['G01', 'Charity / tzedakah', 'Generosity'],
    ['G02', 'Helping someone in need', 'Generosity'],
    ['G03', 'Community contributions', 'Generosity'],
    ['P99', 'Other', 'Personal Use'],
  ];

  cats.forEach((c, idx) => {
    const r = 18 + idx;
    settingsValues[r] = [
      '',
      c[0],
      c[1],
      c[2],
      '',
      c[3] || '',
      c[4] || '',
      '',
      c[5] || '',
      c[6] ?? '',
      '',
      c[7] || '',
    ];
  });

  // Spending rows
  const spendingValues = Array.from({ length: 20 }, () => []);
  const spendingFormulas = Array.from({ length: 20 }, () => []);
  spendingValues[0] = ['Spending Log'];
  spendingValues[3] = [
    'Code (auto)',
    'Date',
    'Category',
    'Cat. code',
    'Bucket (auto)',
    'Description',
    'Paid to',
    'Paid from',
    'Reference / receipt no.',
    'Amount (UGX)',
    'Debt paid',
    'Ask match',
    'Ask count',
    'Ask amount',
  ];

  // Pre-populate rows 5..15 with valid formulas
  for (let r = 5; r <= 15; r++) {
    const f = spendingFormulasForRow(r);
    spendingFormulas[r - 1] = [f.A, '', '', f.D, f.E, '', '', '', '', '', '', f.L, f.M, f.N];
    spendingValues[r - 1] = ['', '', '', '', '', '', '', '', '', '', '', 0, 0, ''];
  }

  // Row 5 existing expense
  spendingValues[4] = [
    'EX-2610-0001',
    '2026-10-05',
    'Transport & fuel',
    'P03',
    'Personal Use',
    'Boda to town',
    'Boda',
    'Cash',
    '',
    3000,
    '',
    1,
    1,
    3000,
  ];
  spendingFormulas[4][1] = '2026-10-05';
  spendingFormulas[4][2] = 'Transport & fuel';
  spendingFormulas[4][5] = 'Boda to town';
  spendingFormulas[4][6] = 'Boda';
  spendingFormulas[4][7] = 'Cash';
  spendingFormulas[4][9] = 3000;

  // Income rows
  const incomeValues = Array.from({ length: 15 }, () => []);
  const incomeFormulas = Array.from({ length: 15 }, () => []);
  for (let r = 5; r <= 12; r++) {
    const f = incomeFormulasForRow(r);
    incomeFormulas[r - 1] = [f.A, '', '', f.D, '', '', '', '', f.I, f.J, f.K, f.L, f.M];
    incomeValues[r - 1] = ['', '', '', '', '', '', '', '', '', '', '', '', ''];
  }
  incomeValues[4] = [
    'IN-2610-0001',
    '2026-10-25',
    'Salary',
    'I01',
    'Salary — October',
    'Bank',
    'BNK-10',
    3835000,
    383500,
    767000,
    1150500,
    1150500,
    383500,
  ];

  // Transfers rows
  const transfersValues = Array.from({ length: 10 }, () => []);
  const transfersFormulas = Array.from({ length: 10 }, () => []);
  for (let r = 5; r <= 9; r++) {
    const f = transfersFormulasForRow(r);
    transfersFormulas[r - 1] = [f.A, '', '', '', '', '', ''];
    transfersValues[r - 1] = ['', '', '', '', '', '', ''];
  }

  // Debts rows (rows 6..12 -> indices 5..11)
  const debtsValues = Array.from({ length: 15 }, () => []);
  debtsValues[5] = ['D01', 'Patrick Olango Okot', 'Personal loan', 25000000, 25000000, '2026-09-01', 0, 1000000, 500000, 0, 24500000, 0.02, 0, 25, '2028-10-01', 'Not paid this month'];
  debtsValues[6] = ['D02', 'ABSA Bank Credut Card', 'Credit card', 3500000, 3500000, '2026-09-02', '', 1000000, 500000, 0, 3000000, 0.1428, 0, 3, '2026-11-01', 'Not paid this month'];
  debtsValues[7] = ['D03', "Catherine Akidi's Family", 'Personal loan', 150000, 150000, '2026-09-03', '', 1000000, 0, 0, 150000, 0, 0, 1, '2026-09-01', 'Not paid this month'];
  debtsValues[8] = ['D04', 'Grain Pulse Ltd', 'Other', 22500000, 22500000, '2026-09-04', '', 500000, 0, 0, 22500000, 0, 0, 45, '2030-05-01', 'Not paid this month'];
  debtsValues[9] = ['D05', 'Shona Capital', 'Bank loan', 165000000, 165000000, '', '', '', 0, 0, 165000000, 0, 0, 'No plan', '', 'No plan'];
  debtsValues[10] = ['D06', 'Jos Van Den Niuewelaar', 'Personal loan', 63000000, 63000000, '', '', 500000, 0, 0, 63000000, 0, 0, 126, '2037-02-01', 'Not paid this month'];
  debtsValues[11] = ['D07', 'Smartvet Africa', 'Personal loan', 2000000, 2000000, '2026-09-29', '', 2000000, 2000000, 0, 0, 1, 2000000, 0, 'Done', 'Paid off'];

  const state = {
    title: 'Budget Tracker ',
    sheets: {
      Settings: { values: settingsValues, formulas: settingsValues },
      Spending: { values: spendingValues, formulas: spendingFormulas },
      Income: { values: incomeValues, formulas: incomeFormulas },
      Transfers: { values: transfersValues, formulas: transfersFormulas },
      Debts: { values: debtsValues, formulas: debtsValues },
    },
  };

  const sheetsApi = createWorkbookSheetsApi(state);
  return {
    state,
    sheetsApi,
    client: new BudgetTrackerClient({ sheetsApi }),
  };
}

// ---------------------------------------------------------------------------
// 1–4: Amount & Date Parsing (`src/finance.js`)
// ---------------------------------------------------------------------------

test('1. parseAmount handles shorthand k, m, commas, and UGX prefixes', () => {
  assert.equal(parseAmount('3k'), 3_000);
  assert.equal(parseAmount('13k'), 13_000);
  assert.equal(parseAmount('1.5m'), 1_500_000);
  assert.equal(parseAmount('UGX 56,800'), 56_800);
  assert.equal(parseAmount('2,500 shs'), 2_500);
  assert.equal(parseAmount(500000), 500_000);
  assert.equal(parseAmount('invalid'), null);
});

test('2. formatUGX formats numbers with commas', () => {
  assert.equal(formatUGX(3000), '3,000');
  assert.equal(formatUGX(24000000), '24,000,000');
});

test('3. parseDate handles ISO, relative words ("today", "yesterday"), and DD-MMM-YYYY', () => {
  const ref = new Date('2026-11-02T10:00:00Z');
  assert.equal(parseDate('today', ref), '2026-11-02');
  assert.equal(parseDate('yesterday', ref), '2026-11-01');
  assert.equal(parseDate('2 days ago', ref), '2026-10-31');
  assert.equal(parseDate('03-Oct-2026', ref), '2026-10-03');
  assert.equal(parseDate('31 Oct', ref), '2026-10-31');
});

test('4. parseDate converts Excel serial date numbers accurately', () => {
  // 46266 in Excel serial is 2026-09-01, 46298 is 2026-10-03
  assert.equal(parseDate(46266), '2026-09-01');
  assert.equal(parseDate('46298.0'), '2026-10-03');
});

// ---------------------------------------------------------------------------
// 5–10: Pure Finance & Debt Simulator (`src/finance.js`)
// ---------------------------------------------------------------------------

test('5. computeMonthOverview calculates bucket splits, spent vs allocated, and net cashflow', () => {
  const overview = computeMonthOverview({
    month: '2026-10',
    income: [{ date: '2026-10-25', source: 'Salary', amount: 1_000_000 }],
    spending: [
      { code: 'EX-2610-0001', date: '2026-10-05', category: 'Transport & fuel', bucket: 'Personal Use', paidFrom: 'Cash', amount: 350_000 },
      { code: 'EX-2610-0002', date: '2026-10-06', category: 'School fees', bucket: 'Family', paidFrom: 'Mobile Money', amount: 100_000 },
    ],
  });

  assert.equal(overview.totalIncome, 1_000_000);
  assert.equal(overview.totalSpending, 450_000);
  assert.equal(overview.netCashflow, 550_000);

  const personalBucket = overview.buckets.find((b) => b.bucket === 'Personal Use');
  assert.equal(personalBucket.allocated, 300_000);
  assert.equal(personalBucket.spent, 350_000);
  assert.equal(personalBucket.remaining, -50_000);
  assert.equal(personalBucket.status, 'over');
});

test('6. findRecurringLeaks identifies small frequent spends (boda, Spiro battery swaps)', () => {
  const spending = [
    { description: 'Boda to town', paidTo: 'Boda', amount: 3000 },
    { description: 'boda boda to Layibi', paidTo: 'Boda', amount: 4000 },
    { description: 'Transport - Boda', paidTo: 'Fred Boda', amount: 5000 },
    { description: 'Spiro battery swap', paidTo: 'AGM Solutions', amount: 7056 },
    { description: 'Battery swap', paidTo: 'AGM Solutions', amount: 7476 },
    { description: 'Battery swap', paidTo: 'AGM Solutions', amount: 6804 },
    { description: 'Bed for children', paidTo: 'Carpentry', amount: 700000 },
  ];

  const leaks = findRecurringLeaks(spending, { maxItemAmount: 25000, minCount: 3 });
  assert.equal(leaks.length, 2);
  assert.equal(leaks[0].label, 'Spiro battery swap');
  assert.equal(leaks[0].total, 21336);
  assert.equal(leaks[1].label, 'Boda boda');
  assert.equal(leaks[1].total, 12000);
});

test('7. computeCashflowTrend computes multi-month net and realistic debt capacity', () => {
  const trend = computeCashflowTrend({
    income: [
      { date: '2026-09-01', amount: 4_000_000 },
      { date: '2026-10-01', amount: 5_000_000 },
    ],
    spending: [
      { date: '2026-09-10', category: 'Food & groceries', bucket: 'Personal Use', amount: 2_000_000 },
      { date: '2026-09-15', category: 'Loan repayment', bucket: 'Personal Use', amount: 1_000_000, debtPaid: 'Smartvet Africa' },
      { date: '2026-10-10', category: 'Food & groceries', bucket: 'Personal Use', amount: 2_000_000 },
    ],
  });

  assert.equal(trend.months.length, 2);
  assert.equal(trend.averageIncome, 4_500_000);
  assert.equal(trend.averageSpendingExDebt, 2_000_000);
  assert.equal(trend.realisticMonthlyDebtCapacity, 2_500_000);
});

test('8. simulateDebtPayoff compares Snowball vs Avalanche with interest rate overrides', () => {
  const debts = [
    { code: 'D01', lender: 'Small Zero Interest Loan', currentBalance: 1_000_000, interestRate: 0 },
    { code: 'D02', lender: 'High Interest Card', currentBalance: 3_000_000, interestRate: 0 },
  ];

  const sim = simulateDebtPayoff({
    debts,
    monthlyBudget: 1_000_000,
    interestOverrides: { 'High Interest Card': 24 },
    startDate: '2026-11-01',
  });

  // Snowball pays Small Zero Interest Loan first; Avalanche pays High Interest Card first and saves interest
  assert.equal(sim.snowball.payoffOrder[0].lender, 'Small Zero Interest Loan');
  assert.equal(sim.avalanche.payoffOrder[0].lender, 'High Interest Card');
  assert.ok(sim.avalanche.totalInterest < sim.snowball.totalInterest);
  assert.ok(sim.interestSavedByAvalanche > 0);
});

test('9. simulateDebtPayoff supports lump sums and excluding specific lenders', () => {
  const debts = [
    { code: 'D01', lender: 'Patrick Olango Okot', currentBalance: 4_000_000, interestRate: 0 },
    { code: 'D05', lender: 'Shona Capital', currentBalance: 165_000_000, interestRate: 0 },
  ];

  const sim = simulateDebtPayoff({
    debts,
    monthlyBudget: 1_000_000,
    lumpSums: [{ monthOffset: 1, amount: 2_000_000, note: 'Per diem' }],
    excludeLenders: ['Shona Capital'],
    startDate: '2026-11-01',
  });

  assert.equal(sim.includedDebtsCount, 1);
  assert.equal(sim.totalStartingDebt, 4_000_000);
  // Month 1 pays 1m + 2m lump sum = 3m; Month 2 pays remaining 1m -> 2 months total!
  assert.equal(sim.snowball.months, 2);
});

test('10. filterTransactions filters by keyword, category, account, and date range', () => {
  const res = filterTransactions(
    {
      spending: [
        { code: 'EX-2610-0001', date: '2026-10-05', category: 'Transport & fuel', paidFrom: 'Cash', description: 'Boda to town', amount: 3000 },
        { code: 'EX-2610-0002', date: '2026-10-15', category: 'Food & groceries', paidFrom: 'Mobile Money', description: 'Lunch at Elephante', amount: 15000 },
      ],
    },
    { query: 'elephante' }
  );

  assert.equal(res.count, 1);
  assert.equal(res.totalAmount, 15000);
  assert.equal(res.items[0].code, 'EX-2610-0002');
});

// ---------------------------------------------------------------------------
// 11–17: Workbook Layout, Safe Row-Finding, Formula Preservation (`src/sheets.js`)
// ---------------------------------------------------------------------------

test('11. getSettings reads live buckets, categories, income sources, accounts, and lenders', async () => {
  const { client } = buildFakeBudgetTrackerWorkbook();
  const settings = await client.getSettings();

  assert.equal(settings.buckets.length, 5);
  assert.equal(settings.categories.length, 23);
  assert.equal(settings.incomeSources.length, 8);
  assert.ok(settings.paidFrom.includes('Cash'));
  assert.ok(settings.paidFrom.includes('Mobile Money'));
  assert.ok(settings.paidFrom.includes('ABSA Bank Credut Card'));
  assert.ok(settings.lenders.includes('Patrick Olango Okot'));
});

test('12. findNextEmptySpendingRow skips populated row 5 and returns row 6 without using append', async () => {
  const { client } = buildFakeBudgetTrackerWorkbook();
  const nextRow = await client.findNextEmptySpendingRow();
  assert.equal(nextRow, 6);
});

test('13. logExpense writes only yellow input columns (B, C, F..K) and preserves formula columns (A, D, E, L, M, N)', async () => {
  const { client } = buildFakeBudgetTrackerWorkbook();
  const logged = await client.logExpense({
    date: '2026-11-02',
    category: 'Food & groceries',
    description: 'Lunch',
    paidTo: 'Local cafe',
    paidFrom: 'Cash',
    amount: 13000,
  });

  assert.equal(logged.row, 6);
  assert.equal(logged.code, 'EX-2611-0002');

  const formulasRow6 = (await client.getRangeValues('Spending!A6:N6', 'FORMULA'))[0];
  assert.ok(formulasRow6[0].startsWith('=IF(')); // Col A formula preserved
  assert.ok(formulasRow6[3].startsWith('=IF(')); // Col D formula preserved
  assert.ok(formulasRow6[4].startsWith('=IF(')); // Col E formula preserved
  assert.ok(formulasRow6[11].startsWith('=IF(')); // Col L formula preserved
  assert.equal(formulasRow6[12], '=M5+L6'); // Col M formula preserved
  assert.ok(formulasRow6[13].startsWith('=IF(')); // Col N formula preserved
});

test('14. logExpense automatically restores wiped formulas on a row when writing to it', async () => {
  const { client, state } = buildFakeBudgetTrackerWorkbook();
  // Simulate wiped formulas on row 6
  state.sheets.Spending.formulas[5] = ['WIPED_CODE', '', '', 'WIPED_D', 'WIPED_E', '', '', '', '', '', '', '', '#REF!', ''];

  const logged = await client.logExpense({
    date: '2026-11-02',
    category: 'Airtime & data',
    description: 'Airtime',
    paidFrom: 'Mobile Money',
    amount: 5000,
  });

  assert.equal(logged.row, 6);
  const formulasRow6 = (await client.getRangeValues('Spending!A6:N6', 'FORMULA'))[0];
  assert.equal(formulasRow6[0], spendingFormulasForRow(6).A);
  assert.equal(formulasRow6[3], spendingFormulasForRow(6).D);
  assert.equal(formulasRow6[4], spendingFormulasForRow(6).E);
  assert.equal(formulasRow6[12], spendingFormulasForRow(6).M);
});

test('15. logIncome writes yellow columns (B, C, E..H) and keeps bucket split formulas (I..M) intact', async () => {
  const { client } = buildFakeBudgetTrackerWorkbook();
  const logged = await client.logIncome({
    date: '2026-11-02',
    source: 'Consultancy / fees',
    description: 'Judging fee',
    receivedInto: 'Cash',
    amount: 450000,
  });

  assert.equal(logged.row, 6);
  assert.equal(logged.code, 'IN-2611-0002');
  const formulasRow6 = (await client.getRangeValues('Income!A6:M6', 'FORMULA'))[0];
  assert.equal(formulasRow6[0], incomeFormulasForRow(6).A);
  assert.equal(formulasRow6[8], incomeFormulasForRow(6).I);
  assert.equal(formulasRow6[12], incomeFormulasForRow(6).M);
});

test('16. logTransfer writes yellow columns (B..G) and keeps code formula (A) intact', async () => {
  const { client } = buildFakeBudgetTrackerWorkbook();
  const logged = await client.logTransfer({
    date: '2026-11-02',
    fromAccount: 'Bank',
    toAccount: 'Cash',
    description: 'ATM withdrawal',
    amount: 600000,
  });

  assert.equal(logged.row, 5);
  assert.equal(logged.code, 'TR-2611-0001');
  const formulasRow5 = (await client.getRangeValues('Transfers!A5:G5', 'FORMULA'))[0];
  assert.equal(formulasRow5[0], transfersFormulasForRow(5).A);
});

test('17. scanAndRepairFormulas detects and repairs overwritten formulas across Spending and Income', async () => {
  const { client, state } = buildFakeBudgetTrackerWorkbook();
  // Corrupt row 5 formulas on Spending (like rows 17-34 in the real workbook)
  state.sheets.Spending.formulas[4][0] = 'EX-2610-0019';
  state.sheets.Spending.formulas[4][3] = 'P03';
  state.sheets.Spending.formulas[4][4] = 'Personal Use';
  state.sheets.Spending.values[4][12] = '#REF!';

  const dryRun = await client.scanAndRepairFormulas({ apply: false, maxSpendingRow: 10, maxIncomeRow: 8, maxTransferRow: 6 });
  assert.ok(dryRun.repairsCount >= 1);
  assert.equal(state.sheets.Spending.formulas[4][0], 'EX-2610-0019'); // unchanged in dry run

  const applied = await client.scanAndRepairFormulas({ apply: true, maxSpendingRow: 10, maxIncomeRow: 8, maxTransferRow: 6 });
  assert.equal(applied.applied, true);
  assert.equal(state.sheets.Spending.formulas[4][0], spendingFormulasForRow(5).A);
  assert.equal(state.sheets.Spending.formulas[4][3], spendingFormulasForRow(5).D);
});

// ---------------------------------------------------------------------------
// 18–21: Tools Validation, Loan Repayments, Undo/Edit/Delete (`src/tools.js`)
// ---------------------------------------------------------------------------

test('18. executeToolCall validates categories and resolves aliases ("boda" -> Transport & fuel, "momo" -> Mobile Money)', async () => {
  const { client } = buildFakeBudgetTrackerWorkbook();
  const res = await executeToolCall(
    'log_expense',
    {
      amount: '3k',
      category: 'boda',
      description: 'Boda to town',
      paid_from: 'momo',
      date: '2026-11-02',
    },
    { sheetsClient: client, userKey: 'u1' }
  );

  assert.equal(res.ok, true);
  assert.equal(res.entry.category, 'Transport & fuel');
  assert.equal(res.entry.paidFrom, 'Mobile Money');
  assert.equal(res.entry.amount, 3000);

  const badRes = await executeToolCall(
    'log_expense',
    {
      amount: '10k',
      category: 'Spaceship fuel',
      description: 'Invalid category test',
    },
    { sheetsClient: client, userKey: 'u1' }
  );
  assert.ok(badRes.error.includes('Unknown category'));
});

test('19. executeToolCall handles loan repayment and returns updated lender balance', async () => {
  const { client } = buildFakeBudgetTrackerWorkbook();
  const res = await executeToolCall(
    'log_expense',
    {
      amount: '500k',
      category: 'Loan repayment',
      description: 'Paid Patrick',
      paid_from: 'Bank',
      debt_paid: 'Patrick',
      date: '2026-11-02',
    },
    { sheetsClient: client, userKey: 'u1' }
  );

  assert.equal(res.ok, true);
  assert.equal(res.entry.debtPaid, 'Patrick Olango Okot');
  assert.ok(res.debtUpdate);
  assert.equal(res.debtUpdate.lender, 'Patrick Olango Okot');
});

test('20. executeToolCall supports edit_entry ("last" or by code) and undo_last', async () => {
  const { client } = buildFakeBudgetTrackerWorkbook();
  const logged = await executeToolCall(
    'log_expense',
    {
      amount: '13k',
      category: 'Food & groceries',
      description: 'Lunch',
      paid_from: 'Cash',
      date: '2026-11-02',
    },
    { sheetsClient: client, userKey: 'u2' }
  );
  assert.equal(logged.entry.code, 'EX-2611-0002');

  const edited = await executeToolCall(
    'edit_entry',
    { code: 'last', paid_from: 'momo', amount: '15k' },
    { sheetsClient: client, userKey: 'u2' }
  );
  assert.equal(edited.ok, true);
  assert.equal(edited.entry.paidFrom, 'Mobile Money');
  assert.equal(edited.entry.amount, 15000);

  const undone = await executeToolCall('undo_last', {}, { sheetsClient: client, userKey: 'u2' });
  assert.equal(undone.ok, true);
  assert.equal(undone.undone.code, 'EX-2611-0002');

  // Verify row 6 is now empty again and formulas are still intact
  const nextRow = await client.findNextEmptySpendingRow();
  assert.equal(nextRow, 6);
});

test('21. delete_entry requires confirmation before deleting an older entry', async () => {
  const { client } = buildFakeBudgetTrackerWorkbook();
  const unconfirmed = await executeToolCall(
    'delete_entry',
    { code: 'EX-2610-0001', confirmed: false },
    { sheetsClient: client, userKey: 'u3' }
  );
  assert.equal(unconfirmed.requiresConfirmation, true);

  const confirmed = await executeToolCall(
    'delete_entry',
    { code: 'EX-2610-0001', confirmed: true },
    { sheetsClient: client, userKey: 'u3' }
  );
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.deleted.code, 'EX-2610-0001');
});

// ---------------------------------------------------------------------------
// 22–25: Voice Transcription Fallback, Webhook Security, Dedupe & Queue, Audit
// ---------------------------------------------------------------------------

test('22. transcribeAudio retries with ffmpeg MP3 conversion when provider rejects OGG', async () => {
  let attempts = 0;
  let convertedCalled = false;

  const fakeFetch = async (url, opts) => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => 'Unsupported audio format',
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ text: 'Boda three thousand cash' }),
    };
  };

  const fakeConvert = async (buf) => {
    convertedCalled = true;
    return Buffer.from('FAKE_MP3');
  };

  const text = await transcribeAudio(Buffer.from('FAKE_OGG'), {
    apiKey: 'test-key',
    vocabulary: { lenders: ['Patrick Olango Okot'], payees: ['AGM Solutions', 'Elephante'] },
    fetchImpl: fakeFetch,
    convertFn: fakeConvert,
  });

  assert.equal(attempts, 2);
  assert.equal(convertedCalled, true);
  assert.equal(text, 'Boda three thousand cash');
});

test('23. verifyWebhookSignature and isAllowedNumber enforce privacy & HMAC security', () => {
  const secret = 'my-app-secret';
  const body = JSON.stringify({ object: 'whatsapp_business_account' });
  const validSig =
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifyWebhookSignature(body, validSig, secret), true);
  assert.equal(verifyWebhookSignature(body, 'sha256=deadbeef', secret), false);

  assert.equal(isAllowedNumber('+256 774 963756', '256774963756,256700000000'), true);
  assert.equal(isAllowedNumber('256799999999', '256774963756'), false);
});

test('24. sendWhatsAppMessage falls back to approved Utility template when outside 24-hour window', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (calls.length === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 131047, message: 'Re-engagement message' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.template1' }] }),
    };
  };

  await sendWhatsAppMessage('256774963756', 'Weekly summary text', {
    token: 'tok',
    phoneNumberId: '12345',
    templateName: 'weekly_review',
    fetchImpl: fakeFetch,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'text');
  assert.equal(calls[1].type, 'template');
  assert.equal(calls[1].template.name, 'weekly_review');
});

test('25. processIncomingWhatsAppMessage deduplicates message IDs and serializes per-user queue', async () => {
  resetDedupeCache();
  const { client } = buildFakeBudgetTrackerWorkbook();

  const fakeAnthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '✅ EX-2611-0002 · 3,000 · Transport & fuel · Cash' }],
      }),
    },
  };

  const sent = [];
  const sendFn = async (to, text) => sent.push({ to, text });

  const first = await processIncomingWhatsAppMessage(
    { id: 'wamid.100', from: '256774963756', type: 'text', text: 'boda 3k' },
    {
      sheetsClient: client,
      anthropicClient: fakeAnthropic,
      sendFn,
      allowedNumbers: '256774963756',
    }
  );
  assert.equal(first.status, 'processed');
  assert.equal(sent.length, 1);

  // Duplicate webhook delivery with same message id is ignored
  const second = await processIncomingWhatsAppMessage(
    { id: 'wamid.100', from: '256774963756', type: 'text', text: 'boda 3k' },
    {
      sheetsClient: client,
      anthropicClient: fakeAnthropic,
      sendFn,
      allowedNumbers: '256774963756',
    }
  );
  assert.equal(second.status, 'ignored');
  assert.equal(second.reason, 'duplicate_message');
  assert.equal(sent.length, 1);
});

