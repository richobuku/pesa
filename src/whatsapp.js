/**
 * WhatsApp messaging & media client (`src/whatsapp.js`).
 *
 * Supports:
 * 1. Meta WhatsApp Cloud API (`WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`):
 *    - Free-form text replies
 *    - Utility template fallback (`WEEKLY_TEMPLATE_NAME`) outside the 24-hour window
 *    - Media download by media ID
 *    - `X-Hub-Signature-256` HMAC-SHA256 webhook verification (`WHATSAPP_APP_SECRET`)
 * 2. Local whatsmeow Go bridge (`WHATSAPP_BRIDGE_URL`, default `http://localhost:8080`):
 *    - Sends messages via `POST /api/send`
 *    - Downloads voice notes / images / documents via `POST /api/download`
 */

import crypto from 'crypto';
import fs from 'fs';

/**
 * Verify Meta's `X-Hub-Signature-256` header (`sha256=<hex>`) against raw request body.
 */
export function verifyWebhookSignature(rawBody, signatureHeader, appSecret = process.env.WHATSAPP_APP_SECRET) {
  if (!appSecret) return true; // If no secret configured in local dev, allow
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;

  const [algo, sigHex] = signatureHeader.split('=');
  if (algo !== 'sha256' || !sigHex) return false;

  const expectedHex = crypto
    .createHmac('sha256', appSecret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(sigHex, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Check if a sender phone number is in `ALLOWED_NUMBERS`.
 */
export function isAllowedNumber(phone, allowedNumbersEnv = process.env.ALLOWED_NUMBERS) {
  const cleanSender = String(phone || '').replace(/\D/g, '');
  if (!cleanSender) return false;

  const rawList = String(allowedNumbersEnv || '').trim();
  if (!rawList) return false;

  const allowed = rawList
    .split(',')
    .map((n) => n.trim().replace(/\D/g, ''))
    .filter(Boolean);

  return allowed.includes(cleanSender);
}

/**
 * Send a text message via Meta Cloud API or local whatsmeow Go bridge.
 * If Meta Cloud API fails due to the 24-hour window (error code 131047) and `templateName` is set,
 * automatically falls back to sending the approved Utility template.
 */
export async function sendWhatsAppMessage(
  to,
  text,
  {
    token = process.env.WHATSAPP_TOKEN,
    phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID,
    bridgeUrl = process.env.WHATSAPP_BRIDGE_URL || 'http://localhost:8080',
    templateName = process.env.WEEKLY_TEMPLATE_NAME || '',
    fetchImpl = globalThis.fetch,
  } = {}
) {
  const cleanRecipient = String(to || '').replace(/\D/g, '') || String(to || '');

  // Mode A: Meta WhatsApp Cloud API
  if (token && phoneNumberId) {
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanRecipient,
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    });

    if (res.ok) {
      return await res.json();
    }

    const errData = await res.json().catch(() => ({}));
    const errCode = errData?.error?.code;

    // Outside 24-hour customer service window -> fall back to Utility template if configured
    if ((errCode === 131047 || res.status === 400) && templateName) {
      return await sendWhatsAppTemplate(cleanRecipient, templateName, [text], {
        token,
        phoneNumberId,
        fetchImpl,
      });
    }

    throw new Error(`WhatsApp Cloud API send failed (${res.status}): ${JSON.stringify(errData)}`);
  }

  // Mode B: Local whatsmeow Go bridge (`http://localhost:8080/api/send`)
  const bridgeRecipient = String(to || '').includes('@') ? String(to) : cleanRecipient;
  const res = await fetchImpl(`${bridgeUrl.replace(/\/$/, '')}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: bridgeRecipient,
      message: text,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`WhatsApp local bridge send failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Send a WhatsApp Utility template message via Meta Cloud API.
 */
export async function sendWhatsAppTemplate(
  to,
  templateName,
  bodyParams = [],
  {
    languageCode = 'en',
    token = process.env.WHATSAPP_TOKEN,
    phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID,
    fetchImpl = globalThis.fetch,
  } = {}
) {
  if (!token || !phoneNumberId) {
    throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required for template messages.');
  }

  const cleanRecipient = String(to || '').replace(/\D/g, '');
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  const components =
    bodyParams.length > 0
      ? [
          {
            type: 'body',
            parameters: bodyParams.map((p) => ({
              type: 'text',
              text: String(p).slice(0, 1024),
            })),
          },
        ]
      : [];

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: cleanRecipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`WhatsApp template send failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Download media (voice note, receipt image, or PDF) from either Meta Cloud API or the local whatsmeow bridge.
 */
export async function downloadWhatsAppMedia(
  mediaSpec,
  {
    token = process.env.WHATSAPP_TOKEN,
    bridgeUrl = process.env.WHATSAPP_BRIDGE_URL || 'http://localhost:8080',
    fetchImpl = globalThis.fetch,
  } = {}
) {
  // Local file path directly provided
  if (typeof mediaSpec === 'object' && mediaSpec.filePath && fs.existsSync(mediaSpec.filePath)) {
    return {
      buffer: await fs.promises.readFile(mediaSpec.filePath),
      mimeType: mediaSpec.mimeType || 'application/octet-stream',
      filename: mediaSpec.filename || 'media',
    };
  }

  // Local whatsmeow bridge download request ({ messageId, chatJid })
  if (typeof mediaSpec === 'object' && mediaSpec.messageId && mediaSpec.chatJid) {
    const res = await fetchImpl(`${bridgeUrl.replace(/\/$/, '')}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_id: mediaSpec.messageId,
        chat_jid: mediaSpec.chatJid,
      }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const errJson = await res.json();
        detail = errJson.message || '';
      } catch {
        detail = await res.text().catch(() => '');
      }
      throw new Error(`Bridge media download failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    const data = await res.json();
    if (!data.success || !data.path) {
      throw new Error(`Bridge media download error: ${data.message || 'unknown'}`);
    }
    const buffer = await fs.promises.readFile(data.path);
    return {
      buffer,
      mimeType: mediaSpec.mimeType || 'audio/ogg',
      filename: data.filename || 'media.ogg',
    };
  }

  // Meta Cloud API media ID download
  const mediaId = typeof mediaSpec === 'string' ? mediaSpec : mediaSpec?.id;
  if (!mediaId || !token) {
    throw new Error('Missing mediaId or WHATSAPP_TOKEN for Cloud API media download.');
  }

  const metaRes = await fetchImpl(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    throw new Error(`Meta media metadata lookup failed (${metaRes.status})`);
  }
  const metaJson = await metaRes.json();
  const downloadRes = await fetchImpl(metaJson.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!downloadRes.ok) {
    throw new Error(`Meta media binary download failed (${downloadRes.status})`);
  }
  const arrayBuf = await downloadRes.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuf),
    mimeType: metaJson.mime_type || 'application/octet-stream',
    filename: `media_${mediaId}`,
  };
}

