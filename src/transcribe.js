/**
 * Voice-note transcription (`src/transcribe.js`) via Groq Whisper or OpenAI,
 * with dynamic vocabulary prompt (lenders + recent 90-day payees) and an
 * ffmpeg `.ogg` -> `.mp3` convert-and-retry fallback.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

/**
 * Build a concise Whisper prompt string from lenders and recent payees so names like
 * "AGM Solutions", "Elephante", "Khiver", "Spiro", "Josiah", "Jerry", "Olango" are spelled right.
 */
export function buildVocabularyPrompt({ lenders = [], payees = [] } = {}) {
  const defaultTerms = [
    'UGX',
    'boda',
    'boda boda',
    'MoMo',
    'Mobile Money',
    'Airtel Money',
    'Spiro',
    'AGM Solutions',
    'Elephante',
    'Khiver',
    'Josiah',
    'Jerry',
    'Maaser',
    'tithe',
  ];
  const merged = Array.from(new Set([...defaultTerms, ...lenders, ...payees])).filter(Boolean);
  return `Uganda Shillings (UGX) financial log. Terms and names: ${merged.slice(0, 45).join(', ')}.`;
}

/**
 * Convert an audio buffer (e.g. WhatsApp .ogg / opus) to MP3 using bundled ffmpeg-static.
 */
export async function convertAudioToMp3(inputBuffer, inputExt = '.ogg') {
  const bin = ffmpegPath || 'ffmpeg';
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pesa-audio-'));
  const inFile = path.join(tmpDir, `input${inputExt.startsWith('.') ? inputExt : `.${inputExt}`}`);
  const outFile = path.join(tmpDir, 'output.mp3');

  try {
    await fs.promises.writeFile(inFile, inputBuffer);
    await execFileAsync(bin, ['-y', '-i', inFile, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', outFile]);
    return await fs.promises.readFile(outFile);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Transcribe an audio Buffer or file path using Groq Whisper (`whisper-large-v3-turbo`) or OpenAI.
 */
export async function transcribeAudio(
  audioInput,
  {
    provider = process.env.TRANSCRIBE_PROVIDER || 'groq',
    apiKey = process.env.TRANSCRIBE_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || '',
    model = process.env.TRANSCRIBE_MODEL || '',
    language = process.env.TRANSCRIBE_LANGUAGE !== undefined ? process.env.TRANSCRIBE_LANGUAGE : 'en',
    filename = 'voice.ogg',
    mimeType = 'audio/ogg',
    vocabulary = {},
    fetchImpl = globalThis.fetch,
    convertFn = convertAudioToMp3,
  } = {}
) {
  if (!apiKey) {
    throw new Error('Missing TRANSCRIBE_API_KEY (or GROQ_API_KEY / OPENAI_API_KEY) for voice note transcription.');
  }

  const buffer =
    typeof audioInput === 'string' ? await fs.promises.readFile(audioInput) : Buffer.from(audioInput);

  const resolvedProvider = provider.toLowerCase();
  const endpoint =
    resolvedProvider === 'openai'
      ? 'https://api.openai.com/v1/audio/transcriptions'
      : 'https://api.groq.com/openai/v1/audio/transcriptions';

  const resolvedModel =
    model || (resolvedProvider === 'openai' ? 'gpt-4o-mini-transcribe' : 'whisper-large-v3-turbo');

  const promptHint = buildVocabularyPrompt(vocabulary);

  const sendRequest = async (buf, fname, mime) => {
    const form = new FormData();
    const blob = new Blob([buf], { type: mime });
    form.append('file', blob, fname);
    form.append('model', resolvedModel);
    if (language && String(language).trim() !== '') {
      form.append('language', String(language).trim());
    }
    if (promptHint) {
      form.append('prompt', promptHint);
    }
    form.append('response_format', 'json');

    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const err = new Error(`Transcription failed (${res.status}): ${errBody}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    return String(data.text || '').trim();
  };

  try {
    return await sendRequest(buffer, filename, mimeType);
  } catch (firstErr) {
    // Convert to MP3 with bundled ffmpeg and retry once if format was rejected
    const mp3Buffer = await convertFn(buffer, path.extname(filename) || '.ogg');
    return await sendRequest(mp3Buffer, 'voice.mp3', 'audio/mpeg');
  }
}

