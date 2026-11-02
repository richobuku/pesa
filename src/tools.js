/**
 * Tool definitions and handlers (`src/tools.js`) for Pesa.
 *
 * Tools:
 * - log_expense
 * - log_income
 * - log_transfer
 * - undo_last
 * - edit_entry
 * - delete_entry
 * - month_overview
 * - cashflow_trend
 * - find_transactions
 * - get_debts
 * - plan_debt_payoff
 */

import {
  parseAmount,
  parseDate,
  formatUGX,
  computeMonthOverview,
  computeCashflowTrend,
  filterTransactions,
  simulateDebtPayoff,
  toISODate,
} from './finance.js';

/**
 * Per-user stack of recently logged codes in this session so `undo_last` works reliably.
 */
const recentUserEntries = new Map(); // userKey -> [{ code, kind, row, amount, description, timestamp }]

export function recordUserEntry(userKey, entry) {
  const key = userKey || 'default';
  const list = recentUserEntries.get(key) || [];
  list.push({ ...entry, timestamp: Date.now() });
  if (list.length > 25) list.shift();
  recentUserEntries.set(key, list);
}

export function getLastUserEntry(userKey) {
  const key = userKey || 'default';
  const list = recentUserEntries.get(key) || [];
  return list.length > 0 ? list[list.length - 1] : null;
}

export function popLastUserEntry(userKey) {
  const key = userKey || 'default';
  const list = recentUserEntries.get(key) || [];
  return list.pop() || null;
}

/**
 * Fuzzy-match a user-supplied category, account, source, or lender against live Settings/Debts.
 */
export function resolveCategory(input, categories = []) {
  if (!input) return null;
  const q = String(input).trim().toLowerCase();

  // 1. Exact match by name or code
  for (const c of categories) {
    if (c.name.toLowerCase() === q || c.code.toLowerCase() === q) return c;
  }

  // 2. Common Uganda / Budget Tracker aliases
  const aliasMap = {
    boda: 'Transport & fuel',
    transport: 'Transport & fuel',
    fuel: 'Transport & fuel',
    spiro: 'Transport & fuel',
    food: 'Food & groceries',
    groceries: 'Food & groceries',
    lunch: 'Food & groceries',
    breakfast: 'Food & groceries',
    dinner: 'Food & groceries',
    airtime: 'Airtime & data',
    data: 'Airtime & data',
    internet: 'Airtime & data',
    rent: 'Rent / Housing',
    housing: 'Rent / Housing',
    utilities: 'Utilities (power, water)',
    power: 'Utilities (power, water)',
    water: 'Utilities (power, water)',
    electricity: 'Utilities (power, water)',
    medical: 'Health & medical',
    health: 'Health & medical',
    clothes: 'Clothing & personal care',
    clothing: 'Clothing & personal care',
    haircut: 'Clothing & personal care',
    entertainment: 'Entertainment & leisure',
    leisure: 'Entertainment & leisure',
    loan: 'Loan repayment',
    'loan repayment': 'Loan repayment',
    debt: 'Loan repayment',
    charges: 'Bank & mobile money charges',
    'momo charges': 'Bank & mobile money charges',
    'momo fee': 'Bank & mobile money charges',
    'bank charges': 'Bank & mobile money charges',
    interest: 'Interest & charges on debt',
    school: 'School fees',
    'school fees': 'School fees',
    household: 'Household support',
    home: 'Household support',
    parents: 'Support to parents & relatives',
    relatives: 'Support to parents & relatives',
    gifts: 'Family events & gifts',
    tithe: 'Tithe / Church offering',
    offering: 'Tithe / Church offering',
    church: 'Tithe / Church offering',
    savings: 'Savings deposit',
    emergency: 'Emergency fund',
    investment: 'Investment',
    charity: 'Charity / tzedakah',
    helping: 'Helping someone in need',
    community: 'Community contributions',
    other: 'Other',
  };

  if (aliasMap[q]) {
    const mapped = categories.find((c) => c.name.toLowerCase() === aliasMap[q].toLowerCase());
    if (mapped) return mapped;
  }

  // 3. Substring match
  for (const c of categories) {
    if (c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase())) {
      return c;
    }
  }

  return null;
}

export function resolveAccount(input, paidFromList = ['Cash', 'Mobile Money', 'Bank']) {
  if (!input) return 'Cash';
  const q = String(input).trim().toLowerCase();

  for (const a of paidFromList) {
    if (a.toLowerCase() === q) return a;
  }

  if (q === 'momo' || q === 'mm' || q === 'mobile' || q === 'mtn' || q === 'airtel' || q === 'mobile money') {
    return paidFromList.find((a) => a.toLowerCase() === 'mobile money') || 'Mobile Money';
  }
  if (q === 'cash') {
    return paidFromList.find((a) => a.toLowerCase() === 'cash') || 'Cash';
  }
  if (q === 'bank' || q === 'eft' || q === 'transfer') {
    return paidFromList.find((a) => a.toLowerCase() === 'bank') || 'Bank';
  }
  if (q.includes('absa') || q.includes('card') || q.includes('credit')) {
    const card = paidFromList.find((a) => a.toLowerCase().includes('card') || a.toLowerCase().includes('absa'));
    if (card) return card;
  }

  for (const a of paidFromList) {
    if (a.toLowerCase().includes(q) || q.includes(a.toLowerCase())) return a;
  }

  return null;
}

export function resolveIncomeSource(input, incomeSources = []) {
  if (!input) return null;
  const q = String(input).trim().toLowerCase();

  for (const s of incomeSources) {
    if (s.name.toLowerCase() === q || s.code.toLowerCase() === q) return s;
  }

  if (q.includes('salary') || q.includes('wage')) {
    return incomeSources.find((s) => s.name.toLowerCase().includes('salary')) || { name: 'Salary', code: 'I01' };
  }
  if (q.includes('consult') || q.includes('fee') || q.includes('per diem') || q.includes('allowance')) {
    return incomeSources.find((s) => s.name.toLowerCase().includes('consultancy')) || { name: 'Consultancy / fees', code: 'I03' };
  }
  if (q.includes('business')) {
    return incomeSources.find((s) => s.name.toLowerCase().includes('business')) || { name: 'Business income', code: 'I02' };
  }
  if (q.includes('farm')) {
    return incomeSources.find((s) => s.name.toLowerCase().includes('farm')) || { name: 'Farm sales', code: 'I04' };
  }
  if (q.includes('gift')) {
    return incomeSources.find((s) => s.name.toLowerCase().includes('gift')) || { name: 'Gift received', code: 'I07' };
  }
  if (q.includes('rent')) {
    return incomeSources.find((s) => s.name.toLowerCase().includes('rental')) || { name: 'Rental income', code: 'I06' };
  }
  if (q.includes('dividend') || q.includes('interest')) {
    return incomeSources.find((s) => s.name.toLowerCase().includes('dividend')) || { name: 'Dividends / interest', code: 'I05' };
  }

  for (const s of incomeSources) {
    if (s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase())) return s;
  }

  return incomeSources.find((s) => s.name.toLowerCase() === 'other income') || null;
}

export function resolveLender(input, debts = []) {
  if (!input) return null;
  const q = String(input).trim().toLowerCase();

  for (const d of debts) {
    if (d.lender.toLowerCase() === q || (d.code && d.code.toLowerCase() === q)) return d;
  }
  for (const d of debts) {
    if (d.lender.toLowerCase().includes(q) || q.includes(d.lender.toLowerCase())) return d;
  }
  return null;
}

/**
 * Anthropic Claude tool definitions.
 */
export function buildToolDefinitions(settings = {}) {
  const categoryNames = (settings.categories || []).map((c) => c.name);
  const incomeSourceNames = (settings.incomeSources || []).map((s) => s.name);
  const paidFromNames = settings.paidFrom || ['Cash', 'Mobile Money', 'Bank'];
  const lenderNames = settings.lenders || [];

  return [
    {
      name: 'log_expense',
      description:
        'Log one or more expenses to the Spending sheet in the Budget Tracker. Writes only yellow input columns and preserves all formulas. For loan repayments, set category to "Loan repayment" and debt_paid to the lender name. If the user message has multiple expenses, either pass them in `items` or call `log_expense` for each item.',
      input_schema: {
        type: 'object',
        properties: {
          amount: {
            type: ['number', 'string'],
            description: 'Amount in UGX (e.g. 3000, "13k", "1.5m").',
          },
          category: {
            type: 'string',
            description: `Spending category from Settings: ${categoryNames.join(', ')}`,
          },
          description: {
            type: 'string',
            description: 'Short description of the expense (e.g. "Boda to town", "Lunch").',
          },
          paid_to: {
            type: 'string',
            description: 'Vendor, person, or merchant paid (e.g. "AGM Solutions", "Khiver", "Church").',
          },
          paid_from: {
            type: 'string',
            description: `Account or card paid from: ${paidFromNames.join(', ')}. Defaults to "Cash".`,
          },
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD (or "today", "yesterday"). Defaults to today.',
          },
          reference: {
            type: 'string',
            description: 'Optional receipt or MoMo transaction ID (e.g. "44248098564").',
          },
          debt_paid: {
            type: 'string',
            description: `If category is "Loan repayment", specify the exact lender from Debts: ${lenderNames.join(', ')}`,
          },
          items: {
            type: 'array',
            description: 'Optional array of multiple expense items to log in one batch.',
            items: {
              type: 'object',
              properties: {
                amount: { type: ['number', 'string'] },
                category: { type: 'string' },
                description: { type: 'string' },
                paid_to: { type: 'string' },
                paid_from: { type: 'string' },
                date: { type: 'string' },
                reference: { type: 'string' },
                debt_paid: { type: 'string' },
              },
              required: ['amount', 'category', 'description'],
            },
          },
        },
      },
    },
    {
      name: 'log_income',
      description:
        'Log income received to the Income sheet in the Budget Tracker. The workbook automatically splits it across the 5 buckets.',
      input_schema: {
        type: 'object',
        properties: {
          amount: {
            type: ['number', 'string'],
            description: 'Gross income amount in UGX (e.g. 3835000, "450k").',
          },
          source: {
            type: 'string',
            description: `Income source from Settings: ${incomeSourceNames.join(', ')}`,
          },
          description: {
            type: 'string',
            description: 'Short description (e.g. "October Salary", "Per diem Lira").',
          },
          received_into: {
            type: 'string',
            description: `Account received into: ${paidFromNames.join(', ')}. Defaults to "Bank".`,
          },
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD. Defaults to today.',
          },
          reference: {
            type: 'string',
            description: 'Optional reference or receipt number.',
          },
        },
        required: ['amount', 'source', 'description'],
      },
    },
    {
      name: 'log_transfer',
      description:
        'Log money moved between your own accounts (e.g. Bank to Cash ATM withdrawal, or paying off a credit card from Bank/Mobile Money) on the Transfers sheet.',
      input_schema: {
        type: 'object',
        properties: {
          amount: {
            type: ['number', 'string'],
            description: 'Amount transferred in UGX.',
          },
          from_account: {
            type: 'string',
            description: `Source account: ${paidFromNames.join(', ')}`,
          },
          to_account: {
            type: 'string',
            description: `Destination account or credit card: ${paidFromNames.join(', ')}`,
          },
          description: {
            type: 'string',
            description: 'Description (e.g. "ATM withdrawal", "Credit card payment").',
          },
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD. Defaults to today.',
          },
          reference: {
            type: 'string',
            description: 'Optional reference number.',
          },
        },
        required: ['amount', 'from_account', 'to_account'],
      },
    },
    {
      name: 'undo_last',
      description: 'Undo the most recently logged transaction in this chat session by clearing its input cells.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'edit_entry',
      description:
        'Modify an existing transaction by its code (e.g. "EX-2611-0105") or "last" for the most recently logged entry.',
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Transaction code (e.g. "EX-2611-0105", "IN-2610-0005") or "last".',
          },
          amount: { type: ['number', 'string'], description: 'New amount in UGX.' },
          category: { type: 'string', description: 'New spending category (for expenses).' },
          source: { type: 'string', description: 'New income source (for income).' },
          description: { type: 'string', description: 'New description.' },
          paid_to: { type: 'string', description: 'New payee.' },
          paid_from: { type: 'string', description: 'New account paid from.' },
          received_into: { type: 'string', description: 'New account received into.' },
          date: { type: 'string', description: 'New date (YYYY-MM-DD).' },
          reference: { type: 'string', description: 'New reference.' },
          debt_paid: { type: 'string', description: 'New lender name (for loan repayments).' },
        },
        required: ['code'],
      },
    },
    {
      name: 'delete_entry',
      description:
        'Delete (clear) a transaction by its code. Deleting an older entry requires explicit user confirmation (`confirmed: true`).',
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Transaction code to delete (e.g. "EX-2610-0015").',
          },
          confirmed: {
            type: 'boolean',
            description: 'Must be true only after the user explicitly confirmed deleting this older entry.',
          },
        },
        required: ['code'],
      },
    },
    {
      name: 'month_overview',
      description:
        'Get the complete arithmetic overview for a month: total income, total spending, net cashflow, bucket allocations vs actuals, category breakdown, small recurring spends (leaks), and largest single expenses.',
      input_schema: {
        type: 'object',
        properties: {
          month: {
            type: 'string',
            description: 'Month to analyze (e.g. "2026-10", "October", "this month", "last month"). Defaults to current month.',
          },
        },
      },
    },
    {
      name: 'cashflow_trend',
      description:
        'Analyze cash-flow trends across recent months, cumulative bucket drift across all tracked months, and calculate realistic monthly debt-payoff capacity.',
      input_schema: {
        type: 'object',
        properties: {
          months_count: {
            type: 'number',
            description: 'Number of recent months to compare (default 3).',
          },
        },
      },
    },
    {
      name: 'find_transactions',
      description:
        'Search and filter transactions across Spending, Income, and Transfers by date range, category, bucket, account, keyword, or transaction code.',
      input_schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['all', 'expense', 'income', 'transfer'],
            description: 'Filter by transaction type.',
          },
          start_date: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
          end_date: { type: 'string', description: 'End date (YYYY-MM-DD).' },
          category: { type: 'string', description: 'Category or source name filter.' },
          bucket: { type: 'string', description: 'Bucket name filter.' },
          paid_from: { type: 'string', description: 'Account filter (e.g. "Cash", "Mobile Money", "Bank").' },
          query: { type: 'string', description: 'Keyword search across description, payee, reference, or code.' },
          code: { type: 'string', description: 'Exact transaction code to trace.' },
          limit: { type: 'number', description: 'Max items to return (default 25).' },
        },
      },
    },
    {
      name: 'get_debts',
      description: 'Read all loans and credit cards from the Debts sheet with current balances, payments, and status.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'plan_debt_payoff',
      description:
        'Simulate Snowball vs Avalanche debt payoff with current balances from the Debts sheet, supporting what-if scenarios for monthly budget, interest rates, lump sums, and excluding specific lenders.',
      input_schema: {
        type: 'object',
        properties: {
          monthly_budget: {
            type: ['number', 'string'],
            description: 'Total monthly UGX dedicated to debt payoff (e.g. "2m", 2000000).',
          },
          strategy: {
            type: 'string',
            enum: ['both', 'snowball', 'avalanche'],
            description: 'Comparison mode (default "both").',
          },
          interest_overrides: {
            type: 'object',
            description: 'Optional map of lender name or debt code to annual interest rate % (e.g. {"ABSA": 24, "Shona": 18}).',
          },
          lump_sums: {
            type: 'array',
            description: 'Optional one-off lump sums (e.g. [{"monthOffset": 1, "amount": 1500000, "note": "Per diem"}]).',
            items: {
              type: 'object',
              properties: {
                monthOffset: { type: 'number' },
                amount: { type: 'number' },
                note: { type: 'string' },
              },
            },
          },
          exclude_lenders: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of lenders to leave out of the payoff simulation (e.g. ["Shona Capital"]).',
          },
        },
        required: ['monthly_budget'],
      },
    },
  ];
}

/**
 * Execute a tool call against `BudgetTrackerClient`.
 */
export async function executeToolCall(toolName, rawArgs = {}, { sheetsClient, userKey = 'default', now = new Date() } = {}) {
  const settings = await sheetsClient.getSettings();

  switch (toolName) {
    case 'log_expense': {
      if (Array.isArray(rawArgs.items) && rawArgs.items.length > 0) {
        const entries = [];
        for (const item of rawArgs.items) {
          const singleRes = await executeToolCall('log_expense', item, { sheetsClient, userKey, now });
          if (singleRes.error) return singleRes;
          entries.push(singleRes);
        }
        return {
          ok: true,
          entries,
          entry: entries[entries.length - 1]?.entry,
        };
      }

      const amount = parseAmount(rawArgs.amount);
      if (!amount || amount <= 0) {
        return { error: `Invalid amount: ${rawArgs.amount}. Please provide a positive UGX amount.` };
      }

      const matchedCat = resolveCategory(rawArgs.category, settings.categories);
      if (!matchedCat) {
        const valid = settings.categories.map((c) => c.name).join(', ');
        return {
          error: `Unknown category "${rawArgs.category}". Valid categories in Settings are: ${valid}`,
        };
      }

      const paidFrom = resolveAccount(rawArgs.paid_from || 'Cash', settings.paidFrom);
      if (!paidFrom) {
        return {
          error: `Unknown account "${rawArgs.paid_from}". Valid Paid-from options are: ${settings.paidFrom.join(', ')}`,
        };
      }

      let debtPaid = '';
      let lenderSnapshot = null;
      if (rawArgs.debt_paid || matchedCat.name === 'Loan repayment') {
        const matchedLender = resolveLender(rawArgs.debt_paid || rawArgs.paid_to || rawArgs.description, settings.debts);
        if (!matchedLender && matchedCat.name === 'Loan repayment') {
          return {
            error: `Loan repayment requires a valid lender from Debts (${settings.lenders.join(', ')}).`,
          };
        }
        if (matchedLender) {
          debtPaid = matchedLender.lender;
          lenderSnapshot = matchedLender;
        }
      }

      const dateIso = parseDate(rawArgs.date, now);
      const logged = await sheetsClient.logExpense({
        date: dateIso,
        category: matchedCat.name,
        description: rawArgs.description || '',
        paidTo: rawArgs.paid_to || debtPaid || '',
        paidFrom,
        reference: rawArgs.reference || '',
        amount,
        debtPaid,
      });

      recordUserEntry(userKey, logged);

      let debtUpdate = null;
      if (lenderSnapshot) {
        const refreshedDebts = await sheetsClient.getDebts();
        const updatedLender = refreshedDebts.find((d) => d.lender === lenderSnapshot.lender) || {
          ...lenderSnapshot,
          repaidToDate: (lenderSnapshot.repaidToDate || 0) + amount,
          currentBalance: Math.max(0, (lenderSnapshot.currentBalance || 0) - amount),
        };
        const totalPayments =
          updatedLender.plannedMonthly > 0
            ? Math.ceil(updatedLender.startingBalance / updatedLender.plannedMonthly)
            : null;
        const donePayments =
          updatedLender.plannedMonthly > 0
            ? Math.floor(updatedLender.repaidToDate / updatedLender.plannedMonthly)
            : null;
        debtUpdate = {
          lender: updatedLender.lender,
          newBalance: updatedLender.currentBalance,
          repaidToDate: updatedLender.repaidToDate,
          plannedMonthly: updatedLender.plannedMonthly,
          donePayments,
          totalPayments,
        };
      }

      return {
        ok: true,
        entry: {
          ...logged,
          formattedAmount: formatUGX(logged.amount),
          bucket: matchedCat.bucket,
          catCode: matchedCat.code,
        },
        debtUpdate,
      };
    }

    case 'log_income': {
      const amount = parseAmount(rawArgs.amount);
      if (!amount || amount <= 0) {
        return { error: `Invalid income amount: ${rawArgs.amount}` };
      }

      const matchedSource = resolveIncomeSource(rawArgs.source, settings.incomeSources);
      if (!matchedSource) {
        const valid = settings.incomeSources.map((s) => s.name).join(', ');
        return { error: `Unknown income source "${rawArgs.source}". Valid sources are: ${valid}` };
      }

      const receivedInto = resolveAccount(rawArgs.received_into || 'Bank', settings.paidFrom);
      if (!receivedInto) {
        return { error: `Unknown account "${rawArgs.received_into}". Valid accounts: ${settings.paidFrom.join(', ')}` };
      }

      const dateIso = parseDate(rawArgs.date, now);
      const logged = await sheetsClient.logIncome({
        date: dateIso,
        source: matchedSource.name,
        description: rawArgs.description || '',
        receivedInto,
        reference: rawArgs.reference || '',
        amount,
      });

      recordUserEntry(userKey, logged);

      const splits = (settings.buckets || []).map((b) => ({
        bucket: b.name,
        amount: Math.round(amount * Number(b.share || 0)),
      }));

      return {
        ok: true,
        entry: {
          ...logged,
          formattedAmount: formatUGX(logged.amount),
          sourceCode: matchedSource.code,
        },
        bucketSplits: splits,
      };
    }

    case 'log_transfer': {
      const amount = parseAmount(rawArgs.amount);
      if (!amount || amount <= 0) {
        return { error: `Invalid transfer amount: ${rawArgs.amount}` };
      }

      const fromAccount = resolveAccount(rawArgs.from_account, settings.paidFrom);
      const toAccount = resolveAccount(rawArgs.to_account, settings.paidFrom);
      if (!fromAccount || !toAccount) {
        return {
          error: `Both from_account and to_account must be valid (${settings.paidFrom.join(', ')}).`,
        };
      }
      if (fromAccount === toAccount) {
        return { error: `from_account and to_account cannot be the same (${fromAccount}).` };
      }

      const dateIso = parseDate(rawArgs.date, now);
      const logged = await sheetsClient.logTransfer({
        date: dateIso,
        fromAccount,
        toAccount,
        description: rawArgs.description || `Transfer ${fromAccount} to ${toAccount}`,
        reference: rawArgs.reference || '',
        amount,
      });

      recordUserEntry(userKey, logged);

      return {
        ok: true,
        entry: {
          ...logged,
          formattedAmount: formatUGX(logged.amount),
        },
      };
    }

    case 'undo_last': {
      const last = popLastUserEntry(userKey);
      if (!last) {
        return { error: 'No recent entry in this session to undo. Specify a transaction code to delete.' };
      }
      const cleared = await sheetsClient.clearEntryByCode(last.code);
      return {
        ok: true,
        undone: cleared,
      };
    }

    case 'edit_entry': {
      let targetCode = rawArgs.code;
      if (!targetCode || String(targetCode).toLowerCase() === 'last') {
        const last = getLastUserEntry(userKey);
        if (!last) {
          return { error: 'No recent entry found in this session. Please provide the transaction code (e.g. EX-2611-0105).' };
        }
        targetCode = last.code;
      }

      const patch = {};
      if (rawArgs.amount !== undefined) {
        const a = parseAmount(rawArgs.amount);
        if (!a || a <= 0) return { error: `Invalid amount: ${rawArgs.amount}` };
        patch.amount = a;
      }
      if (rawArgs.category !== undefined) {
        const c = resolveCategory(rawArgs.category, settings.categories);
        if (!c) return { error: `Unknown category: ${rawArgs.category}` };
        patch.category = c.name;
      }
      if (rawArgs.source !== undefined) {
        const s = resolveIncomeSource(rawArgs.source, settings.incomeSources);
        if (!s) return { error: `Unknown income source: ${rawArgs.source}` };
        patch.source = s.name;
      }
      if (rawArgs.paid_from !== undefined) {
        const pf = resolveAccount(rawArgs.paid_from, settings.paidFrom);
        if (!pf) return { error: `Unknown account: ${rawArgs.paid_from}` };
        patch.paidFrom = pf;
      }
      if (rawArgs.received_into !== undefined) {
        const ri = resolveAccount(rawArgs.received_into, settings.paidFrom);
        if (!ri) return { error: `Unknown account: ${rawArgs.received_into}` };
        patch.receivedInto = ri;
      }
      if (rawArgs.description !== undefined) patch.description = rawArgs.description;
      if (rawArgs.paid_to !== undefined) patch.paidTo = rawArgs.paid_to;
      if (rawArgs.date !== undefined) patch.date = parseDate(rawArgs.date, now);
      if (rawArgs.reference !== undefined) patch.reference = rawArgs.reference;
      if (rawArgs.debt_paid !== undefined) {
        const l = resolveLender(rawArgs.debt_paid, settings.debts);
        patch.debtPaid = l ? l.lender : rawArgs.debt_paid;
      }

      const updated = await sheetsClient.updateEntryByCode(targetCode, patch);
      return {
        ok: true,
        entry: {
          ...updated,
          formattedAmount: formatUGX(updated.amount),
        },
      };
    }

    case 'delete_entry': {
      const code = String(rawArgs.code || '').trim().toUpperCase();
      if (!code) return { error: 'Transaction code is required.' };

      const last = getLastUserEntry(userKey);
      const isJustLogged = last && String(last.code).toUpperCase() === code;

      if (!isJustLogged && !rawArgs.confirmed) {
        const target = await sheetsClient.findByCode(code);
        if (!target) return { error: `Transaction ${code} not found.` };
        return {
          requiresConfirmation: true,
          message: `Deleting an older entry (${target.code} · ${formatUGX(target.amount)} · ${target.description || target.category} on ${target.date}) requires confirmation. Ask the user to confirm first.`,
          entry: target,
        };
      }

      const cleared = await sheetsClient.clearEntryByCode(code);
      return {
        ok: true,
        deleted: cleared,
      };
    }

    case 'month_overview': {
      const [spending, income] = await Promise.all([
        sheetsClient.getSpending({ maxRow: 1504 }),
        sheetsClient.getIncome({ maxRow: 604 }),
      ]);
      return computeMonthOverview({
        month: rawArgs.month,
        spending,
        income,
        settings,
        now,
      });
    }

    case 'cashflow_trend': {
      const [spending, income, transfers] = await Promise.all([
        sheetsClient.getSpending({ maxRow: 1504 }),
        sheetsClient.getIncome({ maxRow: 604 }),
        sheetsClient.getTransfers({ maxRow: 304 }),
      ]);
      return computeCashflowTrend({
        spending,
        income,
        transfers,
        settings,
        monthsCount: rawArgs.months_count || 3,
      });
    }

    case 'find_transactions': {
      const [spending, income, transfers] = await Promise.all([
        sheetsClient.getSpending({ maxRow: 1504 }),
        sheetsClient.getIncome({ maxRow: 604 }),
        sheetsClient.getTransfers({ maxRow: 304 }),
      ]);
      return filterTransactions(
        { spending, income, transfers },
        {
          type: rawArgs.type || 'all',
          startDate: rawArgs.start_date,
          endDate: rawArgs.end_date,
          category: rawArgs.category,
          bucket: rawArgs.bucket,
          paidFrom: rawArgs.paid_from,
          query: rawArgs.query,
          code: rawArgs.code,
          limit: rawArgs.limit || 25,
        }
      );
    }

    case 'get_debts': {
      const debts = await sheetsClient.getDebts();
      const totalCurrentBalance = debts.reduce((s, d) => s + Number(d.currentBalance || 0), 0);
      const totalPlannedMonthly = debts.reduce((s, d) => s + Number(d.plannedMonthly || 0), 0);
      return {
        totalCurrentBalance,
        totalPlannedMonthly,
        debts,
      };
    }

    case 'plan_debt_payoff': {
      const debts = await sheetsClient.getDebts();
      const budget = parseAmount(rawArgs.monthly_budget);
      if (!budget || budget <= 0) {
        return { error: `Invalid monthly_budget: ${rawArgs.monthly_budget}` };
      }
      return simulateDebtPayoff({
        debts,
        monthlyBudget: budget,
        strategy: rawArgs.strategy || 'both',
        interestOverrides: rawArgs.interest_overrides || {},
        lumpSums: rawArgs.lump_sums || [],
        excludeLenders: rawArgs.exclude_lenders || [],
        startDate: toISODate(now),
      });
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

