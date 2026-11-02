/**
 * Pure finance and arithmetic functions for Pesa.
 * All arithmetic happens in code so the LLM never adds up numbers in its head.
 */

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_MAP = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parse shorthand UGX amounts:
 * "20k" -> 20000, "1.5m" -> 1500000, "UGX 56,800" -> 56800, 3000 -> 3000
 */
export function parseAmount(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input) : null;
  }
  if (!input || typeof input !== 'string') return null;

  let s = input
    .trim()
    .toLowerCase()
    .replace(/^(ugx|ush|shs|shillings?)\s*/i, '')
    .replace(/\s*(ugx|ush|shs|shillings?)$/i, '')
    .replace(/,/g, '')
    .trim();

  const match = s.match(/^([+-]?\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?$/i);
  if (!match) return null;

  const num = parseFloat(match[1]);
  if (!Number.isFinite(num)) return null;

  const suffix = (match[2] || '').toLowerCase();
  let multiplier = 1;
  if (suffix === 'k' || suffix === 'thousand') multiplier = 1_000;
  else if (suffix === 'm' || suffix === 'million') multiplier = 1_000_000;
  else if (suffix === 'b' || suffix === 'billion') multiplier = 1_000_000_000;

  return Math.round(num * multiplier);
}

/**
 * Format UGX integer with thousands separators, e.g. 56800 -> "56,800"
 */
export function formatUGX(amount) {
  const n = Math.round(Number(amount) || 0);
  return n.toLocaleString('en-US');
}

/**
 * Convert Excel/Sheets serial date (e.g. 46298) or string ("2026-10-15", "03-Oct-2026", "yesterday")
 * into ISO "YYYY-MM-DD".
 */
export function parseDate(input, now = new Date()) {
  const ref = now instanceof Date ? now : new Date(now);

  if (!input && input !== 0) {
    return toISODate(ref);
  }

  // Excel serial date number (e.g. 46266 -> 2026-09-01)
  if (typeof input === 'number' || (typeof input === 'string' && /^\d{5}(?:\.\d+)?$/.test(input.trim()))) {
    const serial = parseFloat(input);
    if (serial > 25000 && serial < 80000) {
      // Excel epoch is 1899-12-30
      const utcMs = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400 * 1000;
      return toISODate(new Date(utcMs));
    }
  }

  if (input instanceof Date) {
    return toISODate(input);
  }

  const s = String(input).trim();
  const lower = s.toLowerCase();

  if (lower === 'today' || lower === 'now') {
    return toISODate(ref);
  }
  if (lower === 'yesterday') {
    const d = new Date(ref);
    d.setUTCDate(d.getUTCDate() - 1);
    return toISODate(d);
  }
  const daysAgoMatch = lower.match(/^(\d+)\s+days?\s+ago$/);
  if (daysAgoMatch) {
    const d = new Date(ref);
    d.setUTCDate(d.getUTCDate() - parseInt(daysAgoMatch[1], 10));
    return toISODate(d);
  }

  // YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // DD-MMM-YYYY or DD MMM YYYY (e.g. "03-Oct-2026", "31 Oct 2026", "31 Oct")
  const dmyText = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]+)[\s\-/]?(\d{2,4})?$/);
  if (dmyText) {
    const day = parseInt(dmyText[1], 10);
    const monIdx = MONTHS_MAP[dmyText[2].toLowerCase()];
    let year = dmyText[3] ? parseInt(dmyText[3], 10) : ref.getUTCFullYear();
    if (year < 100) year += 2000;
    if (monIdx !== undefined) {
      return `${year}-${String(monIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // DD/MM/YYYY
  const dmySlash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (dmySlash) {
    const day = parseInt(dmySlash[1], 10);
    const month = parseInt(dmySlash[2], 10);
    let year = parseInt(dmySlash[3], 10);
    if (year < 100) year += 2000;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return toISODate(parsed);
  }

  return toISODate(ref);
}

export function toISODate(d) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format ISO date "2026-10-03" -> "2026-10-03" (or Sheet-friendly date)
 */
export function toMonthKey(dateInput) {
  const iso = parseDate(dateInput);
  return iso ? iso.slice(0, 7) : '';
}

/**
 * Normalize a month query like "October", "2026-10", "oct 2026", "this month", "last month"
 * into "YYYY-MM".
 */
export function resolveMonthKey(monthQuery, now = new Date()) {
  const ref = now instanceof Date ? now : new Date(now);
  if (!monthQuery) {
    return toISODate(ref).slice(0, 7);
  }
  const s = String(monthQuery).trim().toLowerCase();
  if (s === 'this month' || s === 'current') {
    return toISODate(ref).slice(0, 7);
  }
  if (s === 'last month' || s === 'previous') {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1));
    return toISODate(d).slice(0, 7);
  }
  const ym = s.match(/^(\d{4})-(\d{1,2})$/);
  if (ym) {
    return `${ym[1]}-${String(parseInt(ym[2], 10)).padStart(2, '0')}`;
  }
  const mName = s.match(/^([a-z]+)(?:\s+(\d{4}))?$/);
  if (mName && MONTHS_MAP[mName[1]] !== undefined) {
    const year = mName[2] ? parseInt(mName[2], 10) : ref.getUTCFullYear();
    const mon = String(MONTHS_MAP[mName[1]] + 1).padStart(2, '0');
    return `${year}-${mon}`;
  }
  return toISODate(ref).slice(0, 7);
}

/**
 * Compute comprehensive month overview:
 * - Total income & breakdown by source
 * - Total spending & net cashflow
 * - Bucket status (allocated from income vs spent vs remaining/over)
 * - Category breakdown sorted by spend
 * - Account breakdown
 * - Small recurring spends ("leaks": items <= leakThreshold occurring >= 3 times)
 * - Largest single expenses
 */
export function computeMonthOverview({
  month,
  spending = [],
  income = [],
  settings = {},
  leakThreshold = 25000,
  now = new Date(),
}) {
  const monthKey = resolveMonthKey(month, now);
  const bucketsConfig = settings.buckets || [
    { name: 'Tithe (Maaser)', share: 0.1 },
    { name: 'Savings', share: 0.2 },
    { name: 'Personal Use', share: 0.3 },
    { name: 'Family', share: 0.3 },
    { name: 'Generosity', share: 0.1 },
  ];
  const categoryToBucket = new Map();
  for (const cat of settings.categories || []) {
    categoryToBucket.set(cat.name.toLowerCase(), cat.bucket);
  }

  const monthIncome = income.filter(
    (r) => r.amount > 0 && r.date && toMonthKey(r.date) === monthKey
  );
  const monthSpending = spending.filter(
    (r) => r.amount > 0 && r.date && toMonthKey(r.date) === monthKey
  );

  const totalIncome = monthIncome.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const totalSpending = monthSpending.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const netCashflow = totalIncome - totalSpending;

  // Bucket status
  const bucketMap = new Map();
  for (const b of bucketsConfig) {
    const share = Number(b.share || 0);
    bucketMap.set(b.name, {
      bucket: b.name,
      share,
      allocated: Math.round(totalIncome * share),
      spent: 0,
      remaining: Math.round(totalIncome * share),
      status: 'under',
    });
  }

  // Category & Account totals
  const byCategoryMap = new Map();
  const byAccountMap = new Map();

  for (const tx of monthSpending) {
    const amt = Number(tx.amount || 0);
    const cat = tx.category || 'Uncategorized';
    const bucketName =
      tx.bucket && tx.bucket !== 'Unknown category'
        ? tx.bucket
        : categoryToBucket.get(cat.toLowerCase()) || 'Personal Use';

    if (!bucketMap.has(bucketName)) {
      bucketMap.set(bucketName, {
        bucket: bucketName,
        share: 0,
        allocated: 0,
        spent: 0,
        remaining: 0,
        status: 'over',
      });
    }
    const bEntry = bucketMap.get(bucketName);
    bEntry.spent += amt;
    bEntry.remaining = bEntry.allocated - bEntry.spent;
    bEntry.status = bEntry.remaining < 0 ? 'over' : 'ok';

    const catPrev = byCategoryMap.get(cat) || { category: cat, bucket: bucketName, total: 0, count: 0 };
    catPrev.total += amt;
    catPrev.count += 1;
    byCategoryMap.set(cat, catPrev);

    const acct = tx.paidFrom || 'Unspecified';
    const acctPrev = byAccountMap.get(acct) || { account: acct, total: 0, count: 0 };
    acctPrev.total += amt;
    acctPrev.count += 1;
    byAccountMap.set(acct, acctPrev);
  }

  const byIncomeSourceMap = new Map();
  for (const inc of monthIncome) {
    const src = inc.source || 'Unspecified';
    const prev = byIncomeSourceMap.get(src) || { source: src, total: 0, count: 0 };
    prev.total += Number(inc.amount || 0);
    prev.count += 1;
    byIncomeSourceMap.set(src, prev);
  }

  const leaks = findRecurringLeaks(monthSpending, { maxItemAmount: leakThreshold, minCount: 2 });

  const largestItems = [...monthSpending]
    .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))
    .slice(0, 5)
    .map((r) => ({
      code: r.code,
      date: parseDate(r.date),
      category: r.category,
      description: r.description,
      paidTo: r.paidTo,
      amount: Number(r.amount || 0),
    }));

  return {
    month: monthKey,
    totalIncome,
    totalSpending,
    netCashflow,
    incomeCount: monthIncome.length,
    spendingCount: monthSpending.length,
    buckets: Array.from(bucketMap.values()),
    byCategory: Array.from(byCategoryMap.values()).sort((a, b) => b.total - a.total),
    byAccount: Array.from(byAccountMap.values()).sort((a, b) => b.total - a.total),
    byIncomeSource: Array.from(byIncomeSourceMap.values()).sort((a, b) => b.total - a.total),
    leaks,
    largestItems,
  };
}

/**
 * Identify small recurring spends ("leaks") that add up over time.
 * Groups by normalized keyword/payee (e.g. "boda", "battery swap", "airtime", "lunch").
 */
export function findRecurringLeaks(spending = [], { maxItemAmount = 25000, minCount = 3 } = {}) {
  const groups = new Map();

  for (const tx of spending) {
    const amt = Number(tx.amount || 0);
    if (amt <= 0 || amt > maxItemAmount) continue;

    const key = normalizeLeakKey(tx);
    if (!key) continue;

    const g = groups.get(key) || { label: key, count: 0, total: 0, average: 0 };
    g.count += 1;
    g.total += amt;
    g.average = Math.round(g.total / g.count);
    groups.set(key, g);
  }

  return Array.from(groups.values())
    .filter((g) => g.count >= minCount)
    .sort((a, b) => b.total - a.total);
}

function normalizeLeakKey(tx) {
  const desc = String(tx.description || '').toLowerCase();
  const paidTo = String(tx.paidTo || '').toLowerCase();
  const combined = `${desc} ${paidTo}`.trim();

  if (/\bboda\b/.test(combined)) return 'Boda boda';
  if (/battery\s*swap|spiro|agm\s*solutions/.test(combined)) return 'Spiro battery swap';
  if (/airtime|data|momo\s*card/.test(combined)) return 'Airtime & data';
  if (/lunch|breakfast|dinner|meal|rolex|juice|lemonade|pizza|cake/.test(combined)) return 'Snacks & quick meals';
  if (paidTo && paidTo !== 'local vendor' && paidTo !== 'personal') {
    return tx.paidTo.trim();
  }
  if (tx.category) return tx.category.trim();
  return 'Small spend';
}

/**
 * Compute multi-month cashflow trend and realistic monthly debt-payoff capacity.
 */
export function computeCashflowTrend({
  spending = [],
  income = [],
  transfers = [],
  settings = {},
  monthsCount = 3,
}) {
  const monthSet = new Set();
  for (const r of income) {
    if (r.amount > 0 && r.date) monthSet.add(toMonthKey(r.date));
  }
  for (const r of spending) {
    if (r.amount > 0 && r.date) monthSet.add(toMonthKey(r.date));
  }

  const sortedMonths = Array.from(monthSet).filter(Boolean).sort();
  const recentMonths = sortedMonths.slice(-Math.max(1, monthsCount));

  const months = recentMonths.map((m) => {
    const ov = computeMonthOverview({ month: m, spending, income, settings });
    const debtRepayments = spending
      .filter((r) => r.amount > 0 && r.date && toMonthKey(r.date) === m && (r.category === 'Loan repayment' || r.debtPaid))
      .reduce((s, r) => s + Number(r.amount || 0), 0);

    return {
      month: m,
      income: ov.totalIncome,
      spending: ov.totalSpending,
      spendingExDebt: ov.totalSpending - debtRepayments,
      debtRepayments,
      net: ov.netCashflow,
      surplusBeforeDebt: ov.totalIncome - (ov.totalSpending - debtRepayments),
    };
  });

  // Cumulative bucket drift across all tracked months
  const totalAllIncome = income
    .filter((r) => r.amount > 0 && r.date)
    .reduce((s, r) => s + Number(r.amount || 0), 0);

  const bucketsConfig = settings.buckets || [
    { name: 'Tithe (Maaser)', share: 0.1 },
    { name: 'Savings', share: 0.2 },
    { name: 'Personal Use', share: 0.3 },
    { name: 'Family', share: 0.3 },
    { name: 'Generosity', share: 0.1 },
  ];

  const cumulativeBuckets = bucketsConfig.map((b) => {
    const allocated = Math.round(totalAllIncome * Number(b.share || 0));
    const spent = spending
      .filter((r) => r.amount > 0 && r.date && (r.bucket || '') === b.name)
      .reduce((s, r) => s + Number(r.amount || 0), 0);
    return {
      bucket: b.name,
      allocated,
      spent,
      variance: allocated - spent,
    };
  });

  const avgIncome =
    months.length > 0
      ? Math.round(months.reduce((s, m) => s + m.income, 0) / months.length)
      : 0;
  const avgSpendingExDebt =
    months.length > 0
      ? Math.round(months.reduce((s, m) => s + m.spendingExDebt, 0) / months.length)
      : 0;
  const realisticDebtCapacity = Math.max(0, avgIncome - avgSpendingExDebt);

  return {
    months,
    averageIncome: avgIncome,
    averageSpendingExDebt: avgSpendingExDebt,
    realisticMonthlyDebtCapacity: realisticDebtCapacity,
    cumulativeBuckets,
  };
}

/**
 * Filter transactions across Spending, Income, and Transfers.
 */
export function filterTransactions(
  { spending = [], income = [], transfers = [] },
  { type = 'all', startDate, endDate, category, bucket, paidFrom, query, code, limit = 25 } = {}
) {
  let pool = [];
  if (type === 'all' || type === 'expense' || type === 'spending') {
    pool.push(...spending.map((r) => ({ ...r, kind: 'expense' })));
  }
  if (type === 'all' || type === 'income') {
    pool.push(
      ...income.map((r) => ({
        ...r,
        kind: 'income',
        category: r.source,
        paidFrom: r.receivedInto,
      }))
    );
  }
  if (type === 'all' || type === 'transfer') {
    pool.push(
      ...transfers.map((r) => ({
        ...r,
        kind: 'transfer',
        category: `${r.fromAccount} -> ${r.toAccount}`,
        paidFrom: r.fromAccount,
      }))
    );
  }

  pool = pool.filter((r) => Number(r.amount || 0) > 0);

  if (code) {
    const qCode = String(code).trim().toUpperCase();
    pool = pool.filter((r) => String(r.code || '').toUpperCase() === qCode);
  }
  if (startDate) {
    const sIso = parseDate(startDate);
    pool = pool.filter((r) => r.date && parseDate(r.date) >= sIso);
  }
  if (endDate) {
    const eIso = parseDate(endDate);
    pool = pool.filter((r) => r.date && parseDate(r.date) <= eIso);
  }
  if (category) {
    const qCat = String(category).trim().toLowerCase();
    pool = pool.filter((r) => String(r.category || '').toLowerCase().includes(qCat));
  }
  if (bucket) {
    const qBucket = String(bucket).trim().toLowerCase();
    pool = pool.filter((r) => String(r.bucket || '').toLowerCase().includes(qBucket));
  }
  if (paidFrom) {
    const qAcct = String(paidFrom).trim().toLowerCase();
    pool = pool.filter((r) => String(r.paidFrom || '').toLowerCase().includes(qAcct));
  }
  if (query) {
    const q = String(query).trim().toLowerCase();
    pool = pool.filter((r) => {
      const hay = `${r.code || ''} ${r.description || ''} ${r.paidTo || ''} ${r.category || ''} ${r.reference || ''} ${r.debtPaid || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const totalAmount = pool.reduce((s, r) => s + Number(r.amount || 0), 0);
  const sorted = [...pool].sort((a, b) => {
    const da = parseDate(a.date || '');
    const db = parseDate(b.date || '');
    if (da !== db) return db.localeCompare(da);
    return (b.row || 0) - (a.row || 0);
  });

  return {
    count: pool.length,
    totalAmount,
    items: sorted.slice(0, limit),
  };
}

/**
 * Snowball vs Avalanche debt payoff simulator.
 * Supports:
 * - monthlyBudget: total UGX/month put towards debts
 * - strategy: 'snowball' | 'avalanche' | 'both'
 * - interestOverrides: { "ABSA Bank Credut Card": 24, "Shona Capital": 18 } (% per year)
 * - lumpSums: [{ monthOffset: 1, amount: 1500000, note: "Per diem" }] or single number
 * - excludeLenders: ["Shona Capital"] (leave a loan out of the simulation)
 * - startDate: reference date for payoff calendar month calculation
 */
export function simulateDebtPayoff({
  debts = [],
  monthlyBudget = 0,
  strategy = 'both',
  interestOverrides = {},
  lumpSums = [],
  excludeLenders = [],
  startDate = new Date(),
}) {
  const excludedSet = new Set(
    (excludeLenders || []).map((l) => String(l).trim().toLowerCase())
  );

  const activeDebts = debts
    .filter((d) => {
      const bal = Number(d.currentBalance ?? d.balance ?? 0);
      if (bal <= 0) return false;
      const lenderKey = String(d.lender || '').trim().toLowerCase();
      for (const ex of excludedSet) {
        if (ex && lenderKey.includes(ex)) return false;
      }
      return true;
    })
    .map((d) => {
      let rate = Number(d.interestRate || 0);
      for (const [k, v] of Object.entries(interestOverrides || {})) {
        if (String(d.lender || '').toLowerCase().includes(k.toLowerCase()) || String(d.code || '').toLowerCase() === k.toLowerCase()) {
          rate = Number(v);
        }
      }
      return {
        code: d.code,
        lender: d.lender,
        type: d.type || 'Loan',
        balance: Math.round(Number(d.currentBalance ?? d.balance ?? 0)),
        annualRatePct: rate,
        plannedMonthly: Math.round(Number(d.plannedMonthly || 0)),
      };
    });

  const totalStartingDebt = activeDebts.reduce((s, d) => s + d.balance, 0);
  const budget = Math.round(Number(monthlyBudget || 0));

  if (activeDebts.length === 0) {
    return {
      totalStartingDebt: 0,
      monthlyBudget: budget,
      snowball: { months: 0, totalInterest: 0, totalPaid: 0, payoffOrder: [] },
      avalanche: { months: 0, totalInterest: 0, totalPaid: 0, payoffOrder: [] },
    };
  }

  const normalizedLumps = Array.isArray(lumpSums)
    ? lumpSums.map((l) =>
        typeof l === 'number'
          ? { monthOffset: 1, amount: Math.round(l) }
          : { monthOffset: Math.max(1, parseInt(l.monthOffset || 1, 10)), amount: Math.round(Number(l.amount || 0)), note: l.note }
      )
    : typeof lumpSums === 'number' && lumpSums > 0
      ? [{ monthOffset: 1, amount: Math.round(lumpSums) }]
      : [];

  const runStrategy = (mode) => {
    const simDebts = activeDebts.map((d) => ({
      ...d,
      remaining: d.balance,
      interestAccrued: 0,
      paidOffMonth: null,
      paidOffDate: null,
    }));

    let month = 0;
    let totalInterest = 0;
    let totalPaid = 0;
    const maxMonths = 600; // 50 years cap

    while (simDebts.some((d) => d.remaining > 0) && month < maxMonths) {
      month += 1;

      // 1. Accrue monthly interest
      for (const d of simDebts) {
        if (d.remaining <= 0) continue;
        if (d.annualRatePct > 0) {
          const monthlyInterest = Math.round(d.remaining * (d.annualRatePct / 100 / 12));
          d.remaining += monthlyInterest;
          d.interestAccrued += monthlyInterest;
          totalInterest += monthlyInterest;
        }
      }

      // 2. Determine available cash this month (monthly budget + any lump sum in this month)
      const lumpThisMonth = normalizedLumps
        .filter((l) => l.monthOffset === month)
        .reduce((s, l) => s + l.amount, 0);
      let available = budget + lumpThisMonth;

      if (available <= 0) {
        break;
      }

      // 3. Order debts by strategy:
      // Snowball: smallest remaining balance first
      // Avalanche: highest annual interest rate first (tie-break: smallest balance)
      const ordered = simDebts
        .filter((d) => d.remaining > 0)
        .sort((a, b) => {
          if (mode === 'avalanche') {
            if (b.annualRatePct !== a.annualRatePct) {
              return b.annualRatePct - a.annualRatePct;
            }
          }
          return a.remaining - b.remaining;
        });

      for (const d of ordered) {
        if (available <= 0) break;
        const payment = Math.min(d.remaining, available);
        d.remaining -= payment;
        available -= payment;
        totalPaid += payment;

        if (d.remaining === 0 && d.paidOffMonth === null) {
          d.paidOffMonth = month;
          d.paidOffDate = addMonthsFormatted(startDate, month);
        }
      }
    }

    const payoffOrder = simDebts
      .slice()
      .sort((a, b) => (a.paidOffMonth ?? 9999) - (b.paidOffMonth ?? 9999))
      .map((d) => ({
        code: d.code,
        lender: d.lender,
        startingBalance: d.balance,
        annualRatePct: d.annualRatePct,
        interestPaid: d.interestAccrued,
        monthsToPayoff: d.paidOffMonth,
        payoffDate: d.paidOffDate,
        remainingBalance: d.remaining,
      }));

    const allCleared = simDebts.every((d) => d.remaining === 0);
    return {
      strategy: mode,
      completed: allCleared,
      months: allCleared ? month : null,
      debtFreeDate: allCleared ? addMonthsFormatted(startDate, month) : null,
      totalInterest,
      totalPaid,
      payoffOrder,
    };
  };

  const snowball = strategy === 'avalanche' ? null : runStrategy('snowball');
  const avalanche = strategy === 'snowball' ? null : runStrategy('avalanche');

  return {
    totalStartingDebt,
    monthlyBudget: budget,
    includedDebtsCount: activeDebts.length,
    excludedLenders: excludeLenders,
    lumpSums: normalizedLumps,
    snowball,
    avalanche,
    interestSavedByAvalanche:
      snowball && avalanche ? Math.max(0, snowball.totalInterest - avalanche.totalInterest) : 0,
  };
}

function addMonthsFormatted(startDate, monthsToAdd) {
  const ref = startDate instanceof Date ? startDate : new Date(startDate);
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + monthsToAdd, 1));
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

