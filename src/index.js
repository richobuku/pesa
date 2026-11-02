/**
 * Webhook server, message deduplication, per-user sequential queue,
 * and scheduled cron check-ins (`src/index.js`).
 */

import http from 'http';
import { URL } from 'url';
import dotenv from 'dotenv';
import { BudgetTrackerClient } from './sheets.js';
import { runAgentTurn } from './agent.js';
import { transcribeAudio } from './transcribe.js';
import { startBridgePoller } from './bridgePoller.js';
import {
  verifyWebhookSignature,
  isAllowedNumber,
  sendWhatsAppMessage,
  downloadWhatsAppMedia,
} from './whatsapp.js';

dotenv.config();

/**
 * Message deduplication cache (prevents double-logging when Meta or bridge retries webhooks).
 */
const processedMessageIds = new Map(); // messageId -> timestamp
const DEDUPE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > DEDUPE_TTL_MS) processedMessageIds.delete(id);
  }
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

export function resetDedupeCache() {
  processedMessageIds.clear();
}

/**
 * Per-user sequential task queue so rapid consecutive messages from the same number
 * never race on finding the next empty row in Google Sheets.
 */
const userQueues = new Map(); // userKey -> Promise

export function enqueueUserTask(userKey, taskFn) {
  const key = userKey || 'default';
  const prev = userQueues.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => taskFn());
  userQueues.set(key, next);
  return next;
}

/**
 * Process a normalized incoming WhatsApp message:
 * `{ id, from, type, text, mediaId, mimeType, filename, chatJid, filePath }`
 */
export async function processIncomingWhatsAppMessage(
  msg,
  {
    sheetsClient,
    anthropicClient = null,
    sendFn = sendWhatsAppMessage,
    downloadFn = downloadWhatsAppMedia,
    transcribeFn = transcribeAudio,
    allowedNumbers = process.env.ALLOWED_NUMBERS,
    now = new Date(),
  } = {}
) {
  if (!msg || !msg.from) return { status: 'ignored', reason: 'no_sender' };

  if (!isAllowedNumber(msg.from, allowedNumbers)) {
    return { status: 'ignored', reason: 'unauthorized_number' };
  }

  if (msg.id && isDuplicateMessage(msg.id)) {
    return { status: 'ignored', reason: 'duplicate_message' };
  }

  const userKey = String(msg.from).replace(/\D/g, '') || msg.from;

  return enqueueUserTask(userKey, async () => {
    let text = msg.text || '';
    let voiceTranscript = null;
    let media = null;

    if (msg.type === 'audio' || msg.type === 'voice') {
      const downloaded = await downloadFn(
        msg.filePath
          ? { filePath: msg.filePath, mimeType: msg.mimeType || 'audio/ogg', filename: msg.filename || 'voice.ogg' }
          : msg.chatJid
            ? { messageId: msg.id, chatJid: msg.chatJid, mimeType: msg.mimeType || 'audio/ogg' }
            : { id: msg.mediaId, mimeType: msg.mimeType || 'audio/ogg' }
      );
      const vocab = await sheetsClient.getVocabularyHints({ now }).catch(() => ({}));
      voiceTranscript = await transcribeFn(downloaded.buffer, {
        filename: downloaded.filename || 'voice.ogg',
        mimeType: downloaded.mimeType || 'audio/ogg',
        vocabulary: vocab,
      });
      text = voiceTranscript;
    } else if (msg.type === 'image' || msg.type === 'document') {
      media = await downloadFn(
        msg.filePath
          ? { filePath: msg.filePath, mimeType: msg.mimeType, filename: msg.filename }
          : msg.chatJid
            ? { messageId: msg.id, chatJid: msg.chatJid, mimeType: msg.mimeType }
            : { id: msg.mediaId, mimeType: msg.mimeType }
      );
    }

    const { reply, toolCalls } = await runAgentTurn({
      userKey,
      text,
      voiceTranscript,
      media,
      sheetsClient,
      anthropicClient,
      now,
    });

    const recipient = msg.replyTo || msg.from;
    await sendFn(recipient, reply);

    return {
      status: 'processed',
      reply,
      toolCalls,
    };
  });
}

/**
 * Extract normalized messages from a Meta Cloud API webhook payload.
 */
export function extractMetaWebhookMessages(payload) {
  const out = [];
  if (!payload || payload.object !== 'whatsapp_business_account') return out;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const val = change.value || {};
      for (const m of val.messages || []) {
        const type = m.type;
        if (type === 'text') {
          out.push({
            id: m.id,
            from: m.from,
            type: 'text',
            text: m.text?.body || '',
          });
        } else if (type === 'audio') {
          out.push({
            id: m.id,
            from: m.from,
            type: 'audio',
            mediaId: m.audio?.id,
            mimeType: m.audio?.mime_type || 'audio/ogg',
          });
        } else if (type === 'image') {
          out.push({
            id: m.id,
            from: m.from,
            type: 'image',
            text: m.image?.caption || '',
            mediaId: m.image?.id,
            mimeType: m.image?.mime_type || 'image/jpeg',
          });
        } else if (type === 'document') {
          out.push({
            id: m.id,
            from: m.from,
            type: 'document',
            text: m.document?.caption || '',
            mediaId: m.document?.id,
            mimeType: m.document?.mime_type || 'application/pdf',
            filename: m.document?.filename || 'receipt.pdf',
          });
        }
      }
    }
  }
  return out;
}

/**
 * Create the HTTP server for `/health`, `/webhook`, `/bridge-webhook`, and `/cron/:kind`.
 */
export function createPesaServer({
  sheetsClient = new BudgetTrackerClient(),
  anthropicClient = null,
  sendFn = sendWhatsAppMessage,
  downloadFn = downloadWhatsAppMedia,
  transcribeFn = transcribeAudio,
} = {}) {
  return http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      // 1. GET /health
      if (req.method === 'GET' && pathname === '/health') {
        try {
          const info = await sheetsClient.getSpreadsheetInfo();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, spreadsheet: info.title }));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, spreadsheet: 'Budget Tracker ', warning: err.message }));
        }
        return;
      }

      // 2. GET /webhook (Meta verification challenge)
      if (req.method === 'GET' && pathname === '/webhook') {
        const mode = parsedUrl.searchParams.get('hub.mode');
        const token = parsedUrl.searchParams.get('hub.verify_token');
        const challenge = parsedUrl.searchParams.get('hub.challenge');
        const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || 'pesa-verify-token';

        if (mode === 'subscribe' && token === expectedToken) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(challenge || '');
        } else {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
        }
        return;
      }

      // Read raw request body for POST endpoints
      const rawBody = await readRawBody(req);

      // 3. POST /webhook (Meta Cloud API)
      if (req.method === 'POST' && pathname === '/webhook') {
        const sigHeader = req.headers['x-hub-signature-256'];
        if (!verifyWebhookSignature(rawBody, sigHeader)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid webhook signature' }));
          return;
        }

        const payload = JSON.parse(rawBody.toString('utf8') || '{}');
        const messages = extractMetaWebhookMessages(payload);

        // Acknowledge Meta immediately (<200ms) and process in per-user queue
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: messages.length }));

        for (const m of messages) {
          processIncomingWhatsAppMessage(m, {
            sheetsClient,
            anthropicClient,
            sendFn,
            downloadFn,
            transcribeFn,
          }).catch((err) => console.error('[Pesa webhook error]', err));
        }
        return;
      }

      // 4. POST /bridge-webhook (Local whatsmeow Go bridge incoming message hook)
      if (req.method === 'POST' && pathname === '/bridge-webhook') {
        const msg = JSON.parse(rawBody.toString('utf8') || '{}');
        const result = await processIncomingWhatsAppMessage(msg, {
          sheetsClient,
          anthropicClient,
          sendFn,
          downloadFn,
          transcribeFn,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // 5. POST /cron/daily or /cron/weekly
      if (req.method === 'POST' && (pathname === '/cron/daily' || pathname === '/cron/weekly')) {
        const authHeader = req.headers.authorization || '';
        const cronSecret = process.env.CRON_SECRET || 'pesa-cron-secret';
        if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized cron request' }));
          return;
        }

        const kind = pathname.endsWith('weekly') ? 'weekly' : 'daily';
        const results = await runScheduledCheckin(kind, {
          sheetsClient,
          anthropicClient,
          sendFn,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, kind, results }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      console.error('[Pesa server error]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
}

/**
 * Trigger the 20:30 daily check-in ("anything unlogged?") or Sunday 18:00 weekly review.
 */
export async function runScheduledCheckin(
  kind = 'daily',
  {
    sheetsClient,
    anthropicClient = null,
    sendFn = sendWhatsAppMessage,
    allowedNumbers = process.env.ALLOWED_NUMBERS,
    now = new Date(),
  } = {}
) {
  const numbers = String(allowedNumbers || '')
    .split(',')
    .map((n) => n.trim().replace(/\D/g, ''))
    .filter(Boolean);

  const prompt =
    kind === 'weekly'
      ? 'Generate my Sunday 18:00 weekly money review: check this month overview and cashflow trend, highlight total spent this week/month, bucket status, top leaks, and debt progress in a concise WhatsApp summary.'
      : 'Perform the 20:30 daily check-in: check what was logged today using find_transactions, summarize today in one line, and ask "Anything unlogged from today?"';

  const results = [];
  for (const num of numbers) {
    const { reply } = await runAgentTurn({
      userKey: num,
      text: prompt,
      sheetsClient,
      anthropicClient,
      now,
    });
    await sendFn(num, reply);
    results.push({ number: num, reply });
  }
  return results;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Start server if run directly (`node src/index.js`)
const isMain = process.argv[1] && process.argv[1].endsWith('src/index.js');
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const sheetsClient = new BudgetTrackerClient();
  const server = createPesaServer({ sheetsClient });
  server.listen(port, () => {
    console.log(`Pesa WhatsApp finance agent listening on http://localhost:${port}`);
    if (!process.env.WHATSAPP_TOKEN) {
      startBridgePoller({ sheetsClient });
    }
  });
}
