/**
 * `npm run ping -- daily|weekly` (`scripts/ping.js`)
 *
 * Triggered by Render cron jobs (20:30 daily check-in and Sunday 18:00 weekly review).
 * If `APP_URL` is configured, triggers the web service's `/cron/:kind` endpoint;
 * otherwise runs the scheduled check-in directly in-process.
 */

import dotenv from 'dotenv';
import { BudgetTrackerClient } from '../src/sheets.js';
import { runScheduledCheckin } from '../src/index.js';

dotenv.config();

async function main() {
  const kind = (process.argv[2] || 'daily').toLowerCase() === 'weekly' ? 'weekly' : 'daily';
  const appUrl = (process.env.APP_URL || '').trim();
  const cronSecret = process.env.CRON_SECRET || 'pesa-cron-secret';

  if (appUrl && appUrl.startsWith('http')) {
    const endpoint = `${appUrl.replace(/\/$/, '')}/cron/${kind}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Cron ping to ${endpoint} failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    console.log(`✅ Triggered ${kind} check-in via ${endpoint}:`, json);
    return;
  }

  const sheetsClient = new BudgetTrackerClient();
  const results = await runScheduledCheckin(kind, { sheetsClient });
  console.log(`✅ Completed ${kind} check-in directly:`, results);
}

main().catch((err) => {
  console.error('❌ Cron ping failed:', err.message);
  process.exit(1);
});

