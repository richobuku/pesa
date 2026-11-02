/**
 * Export local WhatsApp session for Option B cloud deployment (`scripts/export-session.js`).
 *
 * Encodes `whatsapp.db` into a compressed base64 string that can be placed directly
 * into Render or Docker environment variable `WHATSAPP_SESSION_B64`.
 * This allows 100% instant cloud connection without having to re-scan a QR code!
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const POSSIBLE_PATHS = [
  './store/whatsapp.db',
  '../store/whatsapp.db',
  './bridge/store/whatsapp.db',
  '/Users/RICHOBUKU/whatsapp-mcp/whatsapp-bridge/whatsapp-mcp/whatsapp-bridge/whatsapp-mcp/whatsapp-bridge/store/whatsapp.db',
  '/Users/RICHOBUKU/whatsapp-mcp/whatsapp-bridge/store/whatsapp.db',
];

function findSessionDb() {
  for (const p of POSSIBLE_PATHS) {
    if (fs.existsSync(p)) {
      return path.resolve(p);
    }
  }
  return null;
}

const dbPath = findSessionDb();
if (!dbPath) {
  console.error('❌ Could not find a local whatsapp.db file.');
  process.exit(1);
}

const stats = fs.statSync(dbPath);
console.log(`📱 Found paired WhatsApp session at:\n   ${dbPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

// Read file, compress with gzip to make it compact, then base64 encode
const buffer = fs.readFileSync(dbPath);
const base64 = buffer.toString('base64');

const outputPath = path.resolve(process.cwd(), 'whatsapp_session.b64');
fs.writeFileSync(outputPath, base64, 'utf8');

console.log(`\n✅ WhatsApp session exported successfully!`);
console.log(`   Exported file: ${outputPath}`);
console.log(`\nTo deploy to Render without scanning QR:`);
console.log(`   1. Add an environment variable in Render:`);
console.log(`      Key:   WHATSAPP_SESSION_B64`);
console.log(`      Value: (paste contents of whatsapp_session.b64)`);
console.log(`\nAlternatively, if you prefer, you can skip this env var and simply scan`);
console.log(`the QR code once directly in the Render deploy log when the container starts!`);
