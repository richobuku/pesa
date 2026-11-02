/**
 * `npm run transcribe -- note.ogg` (`scripts/transcribe.js`)
 *
 * CLI utility to test voice-note transcription with the dynamic vocabulary hint
 * built from the Budget Tracker's `Debts` and recent 90-day `Spending` payees.
 */

import path from 'path';
import dotenv from 'dotenv';
import { BudgetTrackerClient } from '../src/sheets.js';
import { transcribeAudio } from '../src/transcribe.js';

dotenv.config();

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: npm run transcribe -- <path-to-audio.ogg>');
    process.exit(1);
  }

  const resolvedPath = path.resolve(fileArg);
  const sheetsClient = new BudgetTrackerClient();
  const vocabulary = await sheetsClient.getVocabularyHints().catch(() => ({}));

  const transcript = await transcribeAudio(resolvedPath, {
    filename: path.basename(resolvedPath),
    vocabulary,
  });

  console.log(`🎙️ "${transcript}"`);
}

main().catch((err) => {
  console.error('❌ Transcription failed:', err.message);
  process.exit(1);
});

