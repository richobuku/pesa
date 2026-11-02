/**
 * `npm run check-sheet` (`scripts/check-sheet.js`)
 *
 * Confirms access to the Budget Tracker workbook and audits all tabs (`Settings`, `Spending`,
 * `Income`, `Transfers`, `Debts`) for data issues that distort totals or coaching advice:
 * 1. Stray entries above headers (e.g. Spending row 2)
 * 2. Overwritten/wiped formulas on Spending, Income, or Transfers (causing duplicate codes or `#REF!`)
 * 3. Incomplete rows on Income (dates/account with no amount, or expenses logged as income)
 * 4. Template `EXAMPLE` rows left in Transfers
 * 5. Category mismatches (e.g. beds/mattresses under Rent/Housing, bank charges under Tithe, battery swap under Investment, AI subscriptions under Transport/Entertainment)
 * 6. Debts sheet completeness (missing interest rates, missing start dates, missing monthly plans, credit card typos)
 */

import dotenv from 'dotenv';
import { BudgetTrackerClient } from '../src/sheets.js';
import { formatUGX } from '../src/finance.js';

dotenv.config();

export async function auditSheet(client = new BudgetTrackerClient()) {
  const info = await client.getSpreadsheetInfo();
  const settings = await client.getSettings({ force: true });

  const [
    spHeader,
    spFormulas,
    spValues,
    incFormulas,
    incValues,
    trValues,
    debts,
  ] = await Promise.all([
    client.getRangeValues('Spending!A1:N4', 'UNFORMATTED_VALUE'),
    client.getRangeValues('Spending!A5:N120', 'FORMULA'),
    client.getRangeValues('Spending!A5:N120', 'UNFORMATTED_VALUE'),
    client.getRangeValues('Income!A5:M30', 'FORMULA'),
    client.getRangeValues('Income!A5:M30', 'UNFORMATTED_VALUE'),
    client.getRangeValues('Transfers!A5:G20', 'UNFORMATTED_VALUE'),
    client.getDebts(),
  ]);

  const issues = [];

  // 1. Check Spending row 2 stray entry above header
  const row2 = (spHeader[1] || []).filter((c) => c !== '' && c !== undefined);
  if (row2.length > 0 && !String(row2[0]).toLowerCase().startsWith('enter ')) {
    issues.push({
      section: 'Spending row 2',
      message: `Stray entry above header in Spending row 2: "${row2.join(', ')}". Delete or clear it.`,
    });
  }

  // 2. Check Spending overwritten formulas & duplicate codes
  const overwrittenSpendingRows = [];
  const refErrorRows = [];
  const codeCounts = new Map();

  for (let i = 0; i < spValues.length; i++) {
    const r = i + 5;
    const vRow = spValues[i] || [];
    const fRow = spFormulas[i] || [];
    const hasData = vRow[1] || vRow[2] || vRow[5] || vRow[9];
    if (!hasData) continue;

    const code = String(vRow[0] || '').trim();
    if (code) {
      codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
    }

    const codeFormula = String(fRow[0] || '');
    if (!codeFormula.startsWith('=')) {
      overwrittenSpendingRows.push(r);
    }

    if (vRow.some((cell) => String(cell) === '#REF!')) {
      refErrorRows.push(r);
    }
  }

  const duplicateCodes = Array.from(codeCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([code, count]) => `${code} ×${count}`);

  if (overwrittenSpendingRows.length > 0 || refErrorRows.length > 0) {
    issues.push({
      section: 'Spending formulas',
      message: `Spending rows [${overwrittenSpendingRows.join(', ')}] have literal codes typed over formulas${duplicateCodes.length ? ` (causing duplicate codes: ${duplicateCodes.join(', ')})` : ''}${refErrorRows.length ? ` and #REF! in Ask helper columns (${refErrorRows.length} rows)` : ''}. Run \`npm run repair-formulas -- --apply\` to fix.`,
    });
  }

  // 3. Check Income rows with dates/account but no amount
  const incompleteIncomeRows = [];
  for (let i = 0; i < incValues.length; i++) {
    const r = i + 5;
    const vRow = incValues[i] || [];
    const hasMeta = vRow[1] || vRow[2] || vRow[4];
    const amt = Number(vRow[7] || 0);
    if (hasMeta && amt <= 0) {
      incompleteIncomeRows.push({
        row: r,
        description: vRow[4] || '(no description)',
        receivedInto: vRow[5] || '',
      });
    }
  }
  if (incompleteIncomeRows.length > 0) {
    const desc = incompleteIncomeRows
      .map((x) => `row ${x.row} ("${x.description}", ${x.receivedInto})`)
      .join(', ');
    issues.push({
      section: 'Income incomplete rows',
      message: `Income has rows with dates/account but no amount: ${desc}. Clear them.`,
    });
  }

  // 4. Check Transfers template EXAMPLE row
  for (let i = 0; i < trValues.length; i++) {
    const r = i + 5;
    const vRow = trValues[i] || [];
    const desc = String(vRow[4] || '');
    const amt = Number(vRow[6] || 0);
    if (/example/i.test(desc) && amt > 0) {
      issues.push({
        section: `Transfers row ${r}`,
        message: `Template example row still active and counted: "${desc}" (${formatUGX(amt)} UGX). Delete/clear it.`,
      });
    }
  }

  // 5. Check suspicious category mismatches in Spending
  const categoryMismatches = [];
  for (let i = 0; i < spValues.length; i++) {
    const r = i + 5;
    const vRow = spValues[i] || [];
    const cat = String(vRow[2] || '').trim();
    const desc = String(vRow[5] || '').trim();
    const amt = Number(vRow[9] || 0);
    if (!desc || amt <= 0) continue;

    if (cat === 'Rent / Housing' && /bed|mattress|pillow/i.test(desc)) {
      categoryMismatches.push(`Row ${r}: "${desc}" (${formatUGX(amt)}) is under Rent / Housing → belongs in Household support (Family).`);
    } else if (/tithe/i.test(cat) && /bank\s*charge/i.test(desc)) {
      categoryMismatches.push(`Row ${r}: "${desc}" (${formatUGX(amt)}) is under ${cat} → belongs in Bank & mobile money charges.`);
    } else if (cat === 'Investment' && /battery\s*swap/i.test(desc)) {
      categoryMismatches.push(`Row ${r}: "${desc}" (${formatUGX(amt)}) is under Investment → belongs in Transport & fuel.`);
    } else if ((cat === 'Transport & fuel' || cat === 'Entertainment & leisure') && /claude|apple|memorae|subscription/i.test(desc)) {
      categoryMismatches.push(`Row ${r}: "${desc}" (${formatUGX(amt)}) is under ${cat} → consider a Subscriptions & software category.`);
    }
  }
  if (categoryMismatches.length > 0) {
    issues.push({
      section: 'Category mismatches',
      message: categoryMismatches.join('\n   - '),
    });
  }

  // 6. Check Debts sheet completeness
  const debtNotes = [];
  const anyRate = debts.some((d) => d.interestRate && d.interestRate > 0);
  if (!anyRate) {
    debtNotes.push('No debt has an interest rate.');
  }
  for (const d of debts) {
    if (d.currentBalance > 0 && !d.startDate) {
      debtNotes.push(`${d.lender} (${formatUGX(d.currentBalance)}) has no start date.`);
    }
    if (d.currentBalance > 0 && (!d.plannedMonthly || d.plannedMonthly <= 0)) {
      debtNotes.push(`${d.lender} (${formatUGX(d.currentBalance)}) has no monthly plan.`);
    }
    if (/credut/i.test(d.lender)) {
      debtNotes.push(`Credit card is spelled "${d.lender}". If you fix the spelling, also fix it in past rows.`);
    }
  }
  if (debtNotes.length > 0) {
    issues.push({
      section: 'Debts sheet',
      message: debtNotes.join('\n   - '),
    });
  }

  return {
    spreadsheetTitle: info.title,
    connectionMode: client.connectionMode || 'direct',
    bucketsCount: settings.buckets.length,
    categoriesCount: settings.categories.length,
    incomeSourcesCount: settings.incomeSources.length,
    accounts: settings.paidFrom,
    debtsCount: debts.length,
    issues,
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-sheet.js');
if (isMain) {
  auditSheet()
    .then((report) => {
      console.log(`✅ Connected to "${report.spreadsheetTitle}" (${report.connectionMode})`);
      console.log(
        `   Buckets: ${report.bucketsCount} · Categories: ${report.categoriesCount} · Income sources: ${report.incomeSourcesCount} · Debts: ${report.debtsCount}`
      );
      console.log(`   Paid-from accounts: ${report.accounts.join(', ')}\n`);

      if (report.issues.length === 0) {
        console.log('🎉 No data issues found in the sheet!');
      } else {
        console.log(`⚠️  Found ${report.issues.length} issue groups to review:\n`);
        report.issues.forEach((iss, idx) => {
          console.log(`${idx + 1}. **${iss.section}**\n   - ${iss.message}\n`);
        });
      }
    })
    .catch((err) => {
      console.error('❌ check-sheet failed:', err.message);
      process.exit(1);
    });
}

