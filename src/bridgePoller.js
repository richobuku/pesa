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
import { sendWhatsAppMessage } from './whatsapp.js';

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
  const allowedList = String(allowedNumbers)
    .split(',')
    .map((n) => n.trim().replace(/\D/g, ''))
    .filter(Boolean);

  const canonicalPhone = allowedList[0] || '256774963756';

  // Keep set of self identities (phone number, jid, and device lid)
  const selfIdentities = new Set(allowedList);

  let activeDbPath = dbPath;
  let lastSeenRowId = 0;
  let initializedRowId = false;
  const seenIds = new Set();
  const botSentSignatures = new Set();

  const refreshSelfIdentities = async (currentDbPath) => {
    const whatsappDbPath = currentDbPath.replace(/messages\.db$/, 'whatsapp.db');
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

  const pollOnce = async () => {
    try {
      if (!activeDbPath || !fs.existsSync(activeDbPath)) {
        activeDbPath = resolveBridgeDbPath();
        if (!activeDbPath || !fs.existsSync(activeDbPath)) {
          return;
        }
        console.log(`🔗 Local WhatsApp bridge watcher connected to database: ${activeDbPath}`);
      }

      await refreshSelfIdentities(activeDbPath);

      // On first run with active db, initialize lastSeenRowId to current max rowid
      // to avoid re-processing historical messages on container restart
      if (!initializedRowId) {
        try {
          const { stdout } = await execFileAsync('sqlite3', ['-json', activeDbPath, 'SELECT MAX(rowid) as max_id FROM messages;']);
          const parsed = JSON.parse(stdout || '[]');
          if (parsed[0] && typeof parsed[0].max_id === 'number') {
            lastSeenRowId = parsed[0].max_id;
          }
          initializedRowId = true;
          console.log(`[bridgePoller] Initialized cursor at rowid=${lastSeenRowId}`);
        } catch {
          // If query fails (e.g. table not populated yet), retry next turn
          return;
        }
      }

      const sql = `
        SELECT rowid, id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename
        FROM messages
        WHERE rowid > ${lastSeenRowId}
        ORDER BY rowid ASC
        LIMIT 50;
      `;
      const { stdout } = await execFileAsync('sqlite3', ['-json', activeDbPath, sql]);
      if (!stdout || !stdout.trim()) return;

      const rows = JSON.parse(stdout);
      for (const row of rows) {
        if (row.rowid && row.rowid > lastSeenRowId) {
          lastSeenRowId = row.rowid;
        }

        if (!row.id || seenIds.has(row.id)) continue;
        seenIds.add(row.id);

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

        // In self-chat, ALWAYS reply to the canonical personal phone JID (e.g. 256774963756@s.whatsapp.net).
        // Sending directly to a naked @lid causes WhatsApp error 479/463.
        const cleanChatJid = isSelfChat
          ? `${canonicalPhone}@s.whatsapp.net`
          : (row.chat_jid ? row.chat_jid.replace(/:\d+@/, '@') : `${canonicalPhone}@s.whatsapp.net`);

        const msg = {
          id: row.id,
          from: canonicalPhone,
          replyTo: cleanChatJid,
          chatJid: cleanChatJid,
          type,
          text,
          filename: row.filename || '',
        };

        console.log(`[bridgePoller] 📩 Processing self-message #${row.rowid}: "${text || type}" (chat: ${row.chat_jid})`);
        try {
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
        } catch (turnErr) {
          console.error(`[bridgePoller] Turn execution error:`, turnErr);
          const errStr = String(turnErr.message || turnErr);
          let userMsg = `⚠️ Pesa encountered an error: ${errStr.slice(0, 140)}`;
          if (errStr.includes('credit balance is too low')) {
            userMsg = '⚠️ Anthropic credit balance is too low. Please top up at console.anthropic.com or configure GROQ_API_KEY in Render.';
          }
          await sendWhatsAppMessage(cleanChatJid, userMsg).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[bridgePoller error]', err);
    }
  };

  const timer = setInterval(pollOnce, intervalMs);
  if (activeDbPath && fs.existsSync(activeDbPath)) {
    console.log(`🔗 Local WhatsApp bridge watcher active on ${activeDbPath}`);
  } else {
    console.log(`⏳ Local WhatsApp bridge watcher waiting for messages.db to be created...`);
  }
  return () => clearInterval(timer);
}

