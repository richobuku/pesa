/**
 * Claude tool-use loop and short chat memory (`src/agent.js`).
 *
 * - Primary engine: Anthropic Claude (`@anthropic-ai/sdk`) with prompt caching (`cache_control: { type: 'ephemeral' }`)
 *   and support for text, voice transcripts, image receipts, and PDF documents.
 * - Automatic fallback: If `ANTHROPIC_API_KEY` is not yet set, transparently uses Groq (`llama-3.3-70b-versatile`
 *   / `meta-llama/llama-4-scout-17b-16e-instruct` for images) with the exact same tools and system prompt.
 */

import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from './prompt.js';
import { buildToolDefinitions, executeToolCall } from './tools.js';

const MAX_HISTORY_MESSAGES = 12; // 6 user/assistant turns
const MAX_TOOL_ITERATIONS = 8;

const chatHistoryByUser = new Map(); // userKey -> [{ role, content }]

function getHistoryFilePath() {
  const storeDir = process.env.STORE_DIR || (fs.existsSync('/app/store') ? '/app/store' : null);
  if (storeDir && fs.existsSync(storeDir)) {
    return path.join(storeDir, 'chat_history.json');
  }
  return null;
}

let historyLoaded = false;
function ensureHistoryLoaded() {
  if (historyLoaded) return;
  historyLoaded = true;
  const filePath = getHistoryFilePath();
  if (filePath && fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v)) chatHistoryByUser.set(k, v);
      }
    } catch {}
  }
}

function persistHistoryToDisk() {
  const filePath = getHistoryFilePath();
  if (filePath) {
    try {
      const obj = Object.fromEntries(chatHistoryByUser.entries());
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch {}
  }
}

export function getChatHistory(userKey = 'default') {
  ensureHistoryLoaded();
  return chatHistoryByUser.get(userKey) || [];
}

export function clearChatHistory(userKey = 'default') {
  ensureHistoryLoaded();
  chatHistoryByUser.delete(userKey);
  persistHistoryToDisk();
}

function appendChatHistory(userKey, userText, assistantText) {
  ensureHistoryLoaded();
  const history = chatHistoryByUser.get(userKey) || [];
  history.push({ role: 'user', content: userText || '[media]' });
  history.push({ role: 'assistant', content: assistantText });
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }
  chatHistoryByUser.set(userKey, history);
  persistHistoryToDisk();
}

/**
 * Run a single user turn through Pesa's tool-use loop.
 *
 * @param {object} params
 * @param {string} params.userKey Phone number or session ID
 * @param {string} [params.text] User text message (or transcribed voice note)
 * @param {string} [params.voiceTranscript] If this came from a voice note, the raw transcript
 * @param {object} [params.media] Optional receipt image or PDF `{ buffer, mimeType, filename }`
 * @param {import('./sheets.js').BudgetTrackerClient} params.sheetsClient
 * @param {object} [params.anthropicClient] Optional injected Anthropic client (for tests)
 * @param {Date} [params.now] Reference date
 */
export async function runAgentTurn({
  userKey = 'default',
  text = '',
  voiceTranscript = null,
  media = null,
  sheetsClient,
  anthropicClient = null,
  now = new Date(),
}) {
  const settings = await sheetsClient.getSettings();
  const systemPrompt = buildSystemPrompt({ settings, now, voiceTranscript });
  const tools = buildToolDefinitions(settings);
  const priorHistory = getChatHistory(userKey);

  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
  const groqKey = process.env.TRANSCRIBE_API_KEY || process.env.GROQ_API_KEY || '';

  let replyText = '';
  const toolCallsExecuted = [];

  if (anthropicClient || anthropicKey) {
    try {
      const client = anthropicClient || new Anthropic({ apiKey: anthropicKey });
      replyText = await runAnthropicLoop({
        client,
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
        systemPrompt,
        tools,
        priorHistory,
        text,
        media,
        sheetsClient,
        userKey,
        now,
        toolCallsExecuted,
      });
    } catch (err) {
      const isCreditOrAuthError =
        err.status === 400 ||
        err.status === 402 ||
        err.status === 401 ||
        String(err.message || '').toLowerCase().includes('credit') ||
        String(err.message || '').toLowerCase().includes('balance');

      if (groqKey && isCreditOrAuthError) {
        console.warn(`[agent] Anthropic API failed (${err.message}). Falling back to Groq Llama 3.3...`);
        replyText = await runGroqFallbackLoop({
          apiKey: groqKey,
          systemPrompt,
          tools,
          priorHistory,
          text,
          media,
          sheetsClient,
          userKey,
          now,
          toolCallsExecuted,
        });
      } else {
        throw err;
      }
    }
  } else if (groqKey) {
    replyText = await runGroqFallbackLoop({
      apiKey: groqKey,
      systemPrompt,
      tools,
      priorHistory,
      text,
      media,
      sheetsClient,
      userKey,
      now,
      toolCallsExecuted,
    });
  } else {
    throw new Error('Neither ANTHROPIC_API_KEY nor TRANSCRIBE_API_KEY/GROQ_API_KEY is configured.');
  }

  // Ensure voice transcript header is always shown first if not already included by the model
  if (voiceTranscript && !replyText.includes('🎙️')) {
    replyText = `🎙️ "${voiceTranscript}"\n${replyText}`;
  }

  appendChatHistory(userKey, voiceTranscript || text, replyText);

  return {
    reply: replyText.trim(),
    toolCalls: toolCallsExecuted,
  };
}

/**
 * Primary Anthropic Claude tool-use loop with ephemeral prompt caching.
 */
async function runAnthropicLoop({
  client,
  model,
  systemPrompt,
  tools,
  priorHistory,
  text,
  media,
  sheetsClient,
  userKey,
  now,
  toolCallsExecuted,
}) {
  const userContent = [];

  if (media && media.buffer) {
    const base64Data = Buffer.from(media.buffer).toString('base64');
    if (media.mimeType === 'application/pdf') {
      userContent.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: base64Data,
        },
      });
    } else if (String(media.mimeType).startsWith('image/')) {
      userContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: media.mimeType,
          data: base64Data,
        },
      });
    }
  }

  userContent.push({
    type: 'text',
    text: text || (media ? 'Please read this receipt and log any expenses (including any transaction fee as a separate expense).' : ''),
  });

  const messages = [
    ...priorHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  // Add cache_control to the last tool and system prompt for prompt caching
  const cachedTools = tools.map((t, idx) =>
    idx === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
  );

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await client.messages.create({
      model,
      max_tokens: 1500,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: cachedTools,
      messages,
    });

    messages.push({
      role: 'assistant',
      content: response.content,
    });

    const toolUseBlocks = (response.content || []).filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0 || response.stop_reason !== 'tool_use') {
      const textBlocks = (response.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text);
      return textBlocks.join('\n').trim();
    }

    const toolResults = [];
    for (const block of toolUseBlocks) {
      let result;
      try {
        result = await executeToolCall(block.name, block.input || {}, {
          sheetsClient,
          userKey,
          now,
        });
      } catch (err) {
        result = { error: err.message || String(err) };
      }
      toolCallsExecuted.push({ name: block.name, input: block.input, result });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({
      role: 'user',
      content: toolResults,
    });
  }

  return 'Done.';
}

function formatEntryConfirmationLine(res) {
  const e = res.entry;
  if (e.kind === 'expense') {
    const refSuffix = e.reference ? ` · ref ${e.reference}` : '';
    if (e.debtPaid) {
      let line = `✅ ${e.code} · ${e.formattedAmount} · ${e.category} → ${e.debtPaid} · ${e.paidFrom}${refSuffix}`;
      if (res.debtUpdate) {
        const bal = Number(res.debtUpdate.newBalance || 0).toLocaleString('en-US');
        const paymentsInfo =
          res.debtUpdate.donePayments !== null && res.debtUpdate.totalPayments
            ? ` That's ${res.debtUpdate.donePayments} of ${res.debtUpdate.totalPayments} payments done.`
            : '';
        line += `\nBalance now ${bal}.${paymentsInfo}`;
      }
      return line;
    }
    return `✅ ${e.code} · ${e.formattedAmount} · ${e.category} · ${e.paidFrom}${refSuffix}`;
  }
  if (e.kind === 'income') {
    return `✅ ${e.code} · ${e.formattedAmount} · ${e.source} · ${e.receivedInto}`;
  }
  if (e.kind === 'transfer') {
    return `✅ ${e.code} · ${e.formattedAmount} · ${e.fromAccount} → ${e.toAccount}`;
  }
  return `✅ ${e.code} · ${e.formattedAmount}`;
}

function compactToolResultForGroq(result) {
  if (!result || typeof result !== 'object') return JSON.stringify(result);
  const slim = { ...result };
  if (Array.isArray(slim.byCategory) && slim.byCategory.length > 8) {
    slim.byCategory = slim.byCategory.slice(0, 8);
  }
  if (Array.isArray(slim.items) && slim.items.length > 10) {
    slim.items = slim.items.slice(0, 10);
  }
  return JSON.stringify(slim);
}

/**
 * Normalize JSON Schema for OpenAI-compatible providers (like Groq) that do not support
 * array `type: ['number', 'string']` in function parameter definitions.
 */
function normalizeSchemaForOpenAi(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const copy = { ...schema };
  if (Array.isArray(copy.type)) {
    copy.type = copy.type.includes('string') ? 'string' : copy.type[0];
  }
  if (copy.properties && typeof copy.properties === 'object') {
    const props = {};
    for (const [k, v] of Object.entries(copy.properties)) {
      props[k] = normalizeSchemaForOpenAi(v);
    }
    copy.properties = props;
  }
  if (copy.items) {
    copy.items = normalizeSchemaForOpenAi(copy.items);
  }
  return copy;
}

async function getAvailableGroqChatModels(apiKey) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const data = await res.json();
      const allIds = (data.data || []).map((m) => m.id);
      return allIds.filter(
        (id) =>
          !id.includes('whisper') &&
          !id.includes('orpheus') &&
          !id.includes('guard') &&
          !id.includes('safeguard')
      );
    }
  } catch (err) {
    console.warn('[agent] Failed to query Groq models:', err.message);
  }
  return [];
}

/**
 * OpenAI-compatible Groq tool-use loop fallback when `ANTHROPIC_API_KEY` is not yet configured.
 */
async function runGroqFallbackLoop({
  apiKey,
  systemPrompt,
  tools,
  priorHistory,
  text,
  media,
  sheetsClient,
  userKey,
  now,
  toolCallsExecuted,
}) {
  const openAiTools = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: normalizeSchemaForOpenAi(t.input_schema),
    },
  }));

  let userMessageContent = text || 'Please log this receipt.';

  if (media && media.buffer && String(media.mimeType).startsWith('image/')) {
    const b64 = Buffer.from(media.buffer).toString('base64');
    userMessageContent = [
      {
        type: 'text',
        text: text || 'Read this receipt or MoMo screenshot and log the expense(s). Log any transaction fee separately under Bank & mobile money charges.',
      },
      {
        type: 'image_url',
        image_url: { url: `data:${media.mimeType};base64,${b64}` },
      },
    ];
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...priorHistory.map((m) => ({ role: m.role, content: String(m.content) })),
    { role: 'user', content: userMessageContent },
  ];

  const availableModels = await getAvailableGroqChatModels(apiKey);
  if (availableModels.length > 0) {
    console.log(`[agent] Active Groq models on account:`, availableModels.join(', '));
  }

  const preferred = [
    process.env.GROQ_MODEL,
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'llama-3.3-70b-versatile',
  ].filter(Boolean);

  const candidateModels = [];
  for (const p of preferred) {
    if (availableModels.length === 0 || availableModels.includes(p)) {
      if (!candidateModels.includes(p)) candidateModels.push(p);
    }
  }
  for (const m of availableModels) {
    if (!candidateModels.includes(m)) candidateModels.push(m);
  }
  if (candidateModels.length === 0) {
    candidateModels.push('llama-3.1-8b-instant');
  }

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let data = null;
    let lastErrText = '';
    let lastStatus = 500;

    for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
      const activeModel = candidateModels[mIdx];
      console.log(`[agent] Trying Groq model (${mIdx + 1}/${candidateModels.length}): ${activeModel}...`);

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: activeModel,
          messages,
          tools: openAiTools,
          tool_choice: 'auto',
          temperature: 0.1,
        }),
      });

      if (res.ok) {
        data = await res.json();
        break;
      }

      lastStatus = res.status;
      lastErrText = await res.text().catch(() => '');
      console.warn(`[agent] Groq model ${activeModel} failed (${lastStatus}): ${lastErrText}`);

      // On 429 rate-limit, wait for reset window and retry
      if (res.status === 429) {
        const waitMatch = lastErrText.match(/try again in ([0-9.]+)s/i);
        const waitMs = waitMatch ? Math.min(20000, Math.ceil(parseFloat(waitMatch[1]) * 1000) + 300) : 2000;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // On 404 model_not_found or 400 schema error, try next candidate model immediately
      if (res.status === 404 || res.status === 400) {
        continue;
      }
      break;
    }

    if (!data) {
      throw new Error(`LLM request failed (${lastStatus}): ${lastErrText}`);
    }
    const choice = data.choices?.[0]?.message;
    if (!choice) break;

    messages.push(choice);

    const toolCalls = choice.tool_calls || [];
    if (toolCalls.length === 0) {
      return String(choice.content || '').trim();
    }

    const loggedConfirmations = [];
    let allSimpleLogs = true;

    for (const tc of toolCalls) {
      const fnName = tc.function?.name;
      if (!['log_expense', 'log_income', 'log_transfer', 'undo_last', 'edit_entry'].includes(fnName)) {
        allSimpleLogs = false;
      }

      let fnArgs = {};
      try {
        fnArgs = JSON.parse(tc.function?.arguments || '{}');
      } catch {}

      let result;
      try {
        result = await executeToolCall(fnName, fnArgs, {
          sheetsClient,
          userKey,
          now,
        });
      } catch (err) {
        result = { error: err.message || String(err) };
      }

      if (result?.ok && Array.isArray(result?.entries)) {
        for (const sub of result.entries) {
          loggedConfirmations.push(formatEntryConfirmationLine(sub));
        }
      } else if (result?.ok && result?.entry) {
        loggedConfirmations.push(formatEntryConfirmationLine(result));
      } else if (result?.ok && result?.undone) {
        loggedConfirmations.push(`↩️ Undid ${result.undone.code} · ${Number(result.undone.amount || 0).toLocaleString('en-US')} · ${result.undone.description || result.undone.category}`);
      } else {
        allSimpleLogs = false;
      }

      toolCallsExecuted.push({ name: fnName, input: fnArgs, result });
      if (tc.function?.arguments) {
        tc.function.arguments = String(tc.function.arguments);
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: fnName,
        content: compactToolResultForGroq(result),
      });
    }

    if (allSimpleLogs && loggedConfirmations.length > 0) {
      return loggedConfirmations.join('\n');
    }
  }

  return 'Done.';
}

