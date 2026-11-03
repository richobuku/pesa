/**
 * Local whatsmeow SQLite bridge watcher (`src/bridgePoller.js`).
 *
 * Watches the local whatsmeow `messages.db` SQLite database created by `whatsapp-bridge/main.go`
 * for new incoming messages (including self-chat / "Message Yourself" on `256774963756@s.whatsapp.net`)
 * and routes them through Pesa (`processIncomingWhatsAppMessage`).
 *
 * This lets you use Pesa immediately from your own WhatsApp app without needing a second SIM
 * or waiting for Meta Business Cloud API verification!
 */

import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { processIncomingWhatsAppMessage } from './index.js';

const execFileAsync = promisify(execFile);

const DEFAULT_DB_PATHS = [
  process.env.WHATSAPP_BRIDGE_DB_PATH,
  process.env.STORE_DIR ? `${process.env.STORE_DIR}/messages.db` : null,
  '/app/store/messages.db',
  'store/messages.db',
  './store/messages.db',
  'bridge/store/messages.db',
  './bridge/store/messages.db',
  '/Users/RICHOBUKU/whatsapp-mcp/whatsapp-bridge/whatsapp-mcp/whatsapp-bridge/whatsapp-mcp/whatsapp-bridge/store/messages.db',
  '/Users/RICHOBUKU/whatsapp-mcp/whatsapp-bridge/store/messages.db',
].filter(Boolean);

export function resolveBridgeDbPath(customPath = process.env.WHATSAPP_BRIDGE_DB_PATH) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  for (const p of DEFAULT_DB_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Start polling the local whatsmeow `messages.db` for new messages in allowed chats.
 */
export function startBridgePoller({
  sheetsClient,
  anthropicClient = null,
  dbPath = resolveBridgeDbPath(),
  intervalMs = 2000,
  allowedNumbers = process.env.ALLOWED_NUMBERS || '256774963756',
} = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return null;
  }

  const allowedList = String(allowedNumbers)
    .split(',')
    .map((n) => n.trim().replace(/\D/g, ''))
    .filter(Boolean);

  // Keep set of self identities (phone number, jid, and device lid)
  const selfIdentities = new Set(allowedList);
  const whatsappDbPath = dbPath.replace(/messages\.db$/, 'whatsapp.db');

  const refreshSelfIdentities = async () => {
    if (fs.existsSync(whatsappDbPath)) {
      try {
        const { stdout } = await execFileAsync('sqlite3', ['-json', whatsappDbPath, 'SELECT jid, lid FROM whatsmeow_device LIMIT 1;']);
        const rows = JSON.parse(stdout || '[]');
        for (const r of rows) {
          if (r.jid) selfIdentities.add(String(r.jid).split('@')[0].split(':')[0].replace(/\D/g, ''));
          if (r.lid) selfIdentities.add(String(r.lid).split('@')[0].split(':')[0].replace(/\D/g, ''));
        }
      } catch {}
    }
  };
  refreshSelfIdentities().catch(() => {});

  // Only process messages that arrive after Pesa starts
  let lastSeenTimestampIso = new Date(Date.now() - 30000).toISOString();
  const seenIds = new Set();
  const botSentSignatures = new Set();

  const pollOnce = async () => {
    try {
      await refreshSelfIdentities();
      const sql = `
        SELECT id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename
        FROM messages
        WHERE datetime(timestamp) >= datetime('${lastSeenTimestampIso}', '-30 seconds')
        ORDER BY datetime(timestamp) ASC
        LIMIT 20;
      `;
      const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql]);
      if (!stdout || !stdout.trim()) return;

      const rows = JSON.parse(stdout);
      for (const row of rows) {
        if (!row.id || seenIds.has(row.id)) continue;
        seenIds.add(row.id);

        if (row.timestamp && row.timestamp > lastSeenTimestampIso) {
          lastSeenTimestampIso = row.timestamp;
        }

        const chatUser = String(row.chat_jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
        const senderUser = String(row.sender || '').split('@')[0].split(':')[0].replace(/\D/g, '');

        // Respond if this message is in self-chat (chat or sender matches our phone/LID)
        const isSelfChat = selfIdentities.has(chatUser) || selfIdentities.has(senderUser);
        if (!isSelfChat) {
          continue;
        }

        const text = String(row.content || '').trim();
        // Skip Pesa's own replies
        if (
          text.startsWith('✅') ||
          text.startsWith('🎙️') ||
          text.startsWith('↩️') ||
          text.startsWith('Pesa ›') ||
          text.startsWith('**October') ||
          text.startsWith('**November') ||
          text.startsWith('👋') ||
          botSentSignatures.has(text)
        ) {
          continue;
        }

        let type = 'text';
        if (row.media_type === 'audio') type = 'audio';
        else if (row.media_type === 'image') type = 'image';
        else if (row.media_type === 'document') type = 'document';

        if (type === 'text' && !text) continue;

        const canonicalPhone = allowedList[0] || '256774963756';
        const cleanChatJid = row.chat_jid ? row.chat_jid.replace(/:\d+@/, '@') : `${canonicalPhone}@s.whatsapp.net`;
        const msg = {
          id: row.id,
          from: canonicalPhone,
          replyTo: cleanChatJid,
          chatJid: cleanChatJid,
          type,
          text,
          filename: row.filename || '',
        };

        console.log(`[bridgePoller] 📩 Processing self-message: "${text || type}" (chat: ${row.chat_jid})`);
        const res = await processIncomingWhatsAppMessage(msg, {
          sheetsClient,
          anthropicClient,
          allowedNumbers,
        });

        if (res && res.reply) {
          console.log(`[bridgePoller] 📤 Sent reply to ${msg.replyTo}: "${res.reply.slice(0, 60)}..."`);
          botSentSignatures.add(res.reply.trim());
          if (botSentSignatures.size > 100) {
            const first = botSentSignatures.values().next().value;
            botSentSignatures.delete(first);
          }
        }
      }
    } catch (err) {
      console.error('[bridgePoller error]', err);
    }
  };

  const timer = setInterval(pollOnce, intervalMs);
  console.log(`🔗 Local WhatsApp bridge watcher active on ${dbPath}`);
  return () => clearInterval(timer);
}

