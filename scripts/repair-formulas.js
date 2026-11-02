/**
 * `npm run repair-formulas` (`scripts/repair-formulas.js`)
 *
 * Scans `Spending`, `Income`, and `Transfers` for cells where formula columns
 * (`A,D,E,L,M,N` on Spending; `A,D,I..M` on Income; `A` on Transfers) were overwritten
 * with literal values or broken (`#REF!`).
 *
 * Dry run by default; pass `--apply` (`npm run repair-formulas -- --apply`) to write the fixes.
 */

import dotenv from 'dotenv';
import { BudgetTrackerClient } from '../src/sheets.js';

dotenv.config();

const apply = process.argv.includes('--apply');

async function main() {
  const client = new BudgetTrackerClient();
  const result = await client.scanAndRepairFormulas({
    apply,
    maxSpendingRow: 120,
    maxIncomeRow: 30,
    maxTransferRow: 20,
  });

  if (result.repairsCount === 0) {
    console.log('✅ All formula columns on Spending, Income, and Transfers are intact!');
    return;
  }

  console.log(
    `${apply ? '🔧 Repaired' : '🔍 [DRY RUN] Would repair'} ${result.cellsCount} formula cells across ${result.repairsCount} rows:\n`
  );

  for (const r of result.repairs) {
    console.log(
      ` - ${r.sheet} row ${r.row}: columns [${r.columns.join(', ')}]${r.description ? ` ("${r.description}")` : ''}`
    );
  }

  if (!apply) {
    console.log('\nRun `npm run repair-formulas -- --apply` to write these formulas back to the sheet.');
  }
}

main().catch((err) => {
  console.error('❌ repair-formulas failed:', err.message);
  process.exit(1);
});

