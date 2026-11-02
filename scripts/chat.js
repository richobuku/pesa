/**
 * `npm run chat` (`scripts/chat.js`)
 *
 * Interactive terminal REPL to talk directly to Pesa using the same brain (`src/agent.js`)
 * and the same Budget Tracker Google Sheet (`src/sheets.js`).
 */

import readline from 'readline';
import dotenv from 'dotenv';
import { BudgetTrackerClient } from '../src/sheets.js';
import { runAgentTurn } from '../src/agent.js';

dotenv.config();

async function main() {
  const sheetsClient = new BudgetTrackerClient();
  const info = await sheetsClient.getSpreadsheetInfo();
  console.log(`💬 Pesa terminal chat connected to "${info.title}". Type "exit" to quit.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you   ›  ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'quit') {
      rl.close();
      return;
    }

    try {
      const { reply } = await runAgentTurn({
        userKey: 'terminal-user',
        text,
        sheetsClient,
      });
      const lines = reply.split('\n');
      console.log(`Pesa  ›  ${lines[0]}`);
      for (let i = 1; i < lines.length; i++) {
        console.log(`         ${lines[i]}`);
      }
      console.log();
    } catch (err) {
      console.error(`Error ›  ${err.message}\n`);
    }

    rl.prompt();
  });
}

main().catch((err) => {
  console.error('❌ Failed to start chat:', err.message);
  process.exit(1);
});

