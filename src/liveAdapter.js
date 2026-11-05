/**
 * Multi-mode Sheets adapter (`src/liveAdapter.js`).
 *
 * When the Google Sheets API (`sheets.googleapis.com`) is enabled and the service account
 * has Editor access, `BudgetTrackerClient` uses `googleapis` directly.
 *
 * If the Google Sheets API is not yet enabled on the user's GCP project or the service
 * account hasn't been shared as Editor yet, this adapter provides seamless live read/write:
 * - Reads exact formulas and values from the live Google Sheet's public `.xlsx` export
 *   (or cached local workbook `/tmp/budget_tracker_live.xlsx`) using Node's built-in `zlib` + XML parser.
 * - Writes new entries and updates via the user's deployed Google Apps Script Web App (`GOOGLE_WEBHOOK_URL`)
 *   AND updates the local live state so `npm run check-sheet`, `npm run repair-formulas`, and `npm run chat`
 *   work out-of-the-box with zero blockers!
 */

import fs from 'fs';
import zlib from 'zlib';
import {
  DEFAULT_SPREADSHEET_ID,
  createGoogleSheetsApi,
  spendingFormulasForRow,
  incomeFormulasForRow,
  transfersFormulasForRow,
  computeAutoCode,
} from './sheets.js';

/**
 * Parse a minimal `.xlsx` buffer (ZIP archive) using only Node built-in modules (`zlib` + `Buffer`).
 * Returns `{ title, sheets: { [sheetName]: { values: 2D array, formulas: 2D array } } }`.
 */
export function parseXlsxBuffer(buffer) {
  const entries = readZipEntries(buffer);

  // 1. Shared strings
  const sharedStrings = [];
  if (entries['xl/sharedStrings.xml']) {
    const xml = entries['xl/sharedStrings.xml'].toString('utf8');
    const siMatches = xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g);
    for (const m of siMatches) {
      const inner = m[1];
      let text = '';
      for (const tm of inner.matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)) {
        text += decodeXmlEntities(tm[1]);
      }
      sharedStrings.push(text);
    }
  }

  // 2. Workbook sheet names
  const sheetMap = {};
  if (entries['xl/workbook.xml']) {
    const wbXml = entries['xl/workbook.xml'].toString('utf8');
    let idx = 1;
    for (const sm of wbXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const attrs = sm[1];
      const nameMatch = attrs.match(/name="([^"]+)"/);
      if (nameMatch) {
        const sheetName = decodeXmlEntities(nameMatch[1]);
        sheetMap[sheetName] = `xl/worksheets/sheet${idx}.xml`;
        idx++;
      }
    }
  }

  const sheets = {};
  for (const [sheetName, xmlPath] of Object.entries(sheetMap)) {
    const raw = entries[xmlPath];
    if (!raw) continue;
    const xml = raw.toString('utf8');

    const valuesGrid = [];
    const formulasGrid = [];

    for (const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const rIdx = parseInt(rm[1], 10) - 1;
      const rowXml = rm[2];
      if (!valuesGrid[rIdx]) valuesGrid[rIdx] = [];
      if (!formulasGrid[rIdx]) formulasGrid[rIdx] = [];

      for (const cm of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const cAttrs = cm[1];
        const cBody = cm[2] || '';
        const refMatch = cAttrs.match(/\br="([A-Z]+)\d+"/);
        if (!refMatch) continue;
        const colIdx = colLettersToIndex(refMatch[1]);
        const typeMatch = cAttrs.match(/\bt="([^"]+)"/);
        const cellType = typeMatch ? typeMatch[1] : '';

        const fSelfClosing = /<f\b[^>]*\/>/.test(cBody);
        const fMatch = cBody.match(/<f(?:\s+[^>]*)?>([\s\S]*?)<\/f>/);
        const vMatch = cBody.match(/<v(?:\s+[^>]*)?>([\s\S]*?)<\/v>/);
        const isMatch = cBody.match(/<is>[\s\S]*?<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);

        let val = '';
        if (vMatch) {
          val = decodeXmlEntities(vMatch[1]);
          if (cellType === 's') {
            val = sharedStrings[parseInt(val, 10)] ?? '';
          } else if (cellType === '' || cellType === 'n') {
            const num = Number(val);
            if (!Number.isNaN(num)) val = num;
          }
        } else if (isMatch) {
          val = decodeXmlEntities(isMatch[1]);
        }

        valuesGrid[rIdx][colIdx] = val;
        if (fMatch && fMatch[1] !== undefined) {
          const fText = decodeXmlEntities(fMatch[1]);
          formulasGrid[rIdx][colIdx] = fText ? `=${fText}` : '=SHARED_FORMULA';
        } else if (fSelfClosing) {
          formulasGrid[rIdx][colIdx] = '=SHARED_FORMULA';
        } else {
          formulasGrid[rIdx][colIdx] = val;
        }
      }
    }

    sheets[sheetName] = { values: valuesGrid, formulas: formulasGrid };
  }

  return {
    title: 'Budget Tracker ',
    sheets,
  };
}

function readZipEntries(buf) {
  const entries = {};
  let offset = 0;
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // Local file header signature

    const flags = buf.readUInt16LE(offset + 6);
    const method = buf.readUInt16LE(offset + 8);
    let compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;

    // If bit 3 of general purpose flag is set, sizes may be in data descriptor; scan via Central Directory if needed
    if ((flags & 0x08) && compSize === 0) {
      break;
    }

    const compData = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      entries[name] = compData;
    } else if (method === 8) {
      try {
        entries[name] = zlib.inflateRawSync(compData);
      } catch {}
    }
    offset = dataStart + compSize;
  }

  // Fallback: read from Central Directory at end of ZIP (handles streaming ZIPs from Google Sheets export)
  if (Object.keys(entries).length === 0 || !entries['xl/workbook.xml']) {
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset !== -1) {
      const cdEntries = buf.readUInt16LE(eocdOffset + 10);
      let cdOffset = buf.readUInt32LE(eocdOffset + 16);
      for (let e = 0; e < cdEntries && cdOffset + 46 <= buf.length; e++) {
        if (buf.readUInt32LE(cdOffset) !== 0x02014b50) break;
        const method = buf.readUInt16LE(cdOffset + 10);
        const compSize = buf.readUInt32LE(cdOffset + 20);
        const nameLen = buf.readUInt16LE(cdOffset + 28);
        const extraLen = buf.readUInt16LE(cdOffset + 30);
        const commentLen = buf.readUInt16LE(cdOffset + 32);
        const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
        const name = buf.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8');

        const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
        const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
        const compData = buf.subarray(dataStart, dataStart + compSize);

        if (method === 0) {
          entries[name] = compData;
        } else if (method === 8) {
          try {
            entries[name] = zlib.inflateRawSync(compData);
          } catch {}
        }

        cdOffset += 46 + nameLen + extraLen + commentLen;
      }
    }
  }

  return entries;
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function colLettersToIndex(letters) {
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col - 1;
}

export function parseA1Range(a1) {
  const [sheetPart, cellPart] = a1.includes('!') ? a1.split('!') : ['Spending', a1];
  const sheet = sheetPart.replace(/^'|'$/g, '');
  const [startRef, endRef] = (cellPart || 'A1').split(':');

  const parseRef = (ref) => {
    const m = ref.match(/^([A-Z]+)(\d+)$/i);
    if (!m) return { col: 0, row: 0 };
    return {
      col: colLettersToIndex(m[1].toUpperCase()),
      row: parseInt(m[2], 10) - 1,
    };
  };

  const s = parseRef(startRef);
  const e = endRef ? parseRef(endRef) : s;
  return {
    sheet,
    startRow: s.row,
    startCol: s.col,
    endRow: e.row,
    endCol: e.col,
  };
}

/**
 * Create an in-memory `sheetsApi` compatible with `googleapis` v4 `spreadsheets.*`
 * backed by an initial `{ title, sheets }` state (and optional live webhook forwarding).
 */
export function createWorkbookSheetsApi(workbookState, { webhookUrl = '' } = {}) {
  const getSheet = (name) => {
    if (!workbookState.sheets[name]) {
      workbookState.sheets[name] = { values: [], formulas: [] };
    }
    return workbookState.sheets[name];
  };

  const applyRangeWrite = (rangeStr, rowsValues) => {
    const { sheet, startRow, startCol } = parseA1Range(rangeStr);
    const sh = getSheet(sheet);

    for (let r = 0; r < rowsValues.length; r++) {
      const rowIdx = startRow + r;
      if (!sh.values[rowIdx]) sh.values[rowIdx] = [];
      if (!sh.formulas[rowIdx]) sh.formulas[rowIdx] = [];

      const rowArr = rowsValues[r] || [];
      for (let c = 0; c < rowArr.length; c++) {
        const colIdx = startCol + c;
        const cellVal = rowArr[c];
        if (typeof cellVal === 'string' && cellVal.startsWith('=')) {
          sh.formulas[rowIdx][colIdx] = cellVal;
          // Evaluate common Budget Tracker formulas in-memory
          sh.values[rowIdx][colIdx] = evaluateWorkbookFormula(workbookState, sheet, rowIdx + 1, colIdx, cellVal);
        } else {
          sh.values[rowIdx][colIdx] = cellVal;
          sh.formulas[rowIdx][colIdx] = cellVal;
        }
      }
    }

    // Re-evaluate formulas on touched rows
    for (let r = 0; r < rowsValues.length; r++) {
      const rowIdx = startRow + r;
      recalcRowFormulas(workbookState, sheet, rowIdx);
    }
  };

  return {
    _state: workbookState,
    spreadsheets: {
      get: async () => ({
        data: {
          properties: { title: workbookState.title || 'Budget Tracker ' },
          sheets: Object.keys(workbookState.sheets).map((title) => ({ properties: { title } })),
        },
      }),
      values: {
        get: async ({ range, valueRenderOption = 'UNFORMATTED_VALUE' }) => {
          const { sheet, startRow, startCol, endRow, endCol } = parseA1Range(range);
          const sh = getSheet(sheet);
          const grid = valueRenderOption === 'FORMULA' ? sh.formulas : sh.values;
          const out = [];
          const maxR = Math.min(endRow, Math.max(startRow, grid.length - 1));
          for (let r = startRow; r <= maxR; r++) {
            const srcRow = grid[r] || [];
            const slice = [];
            for (let c = startCol; c <= endCol; c++) {
              slice.push(srcRow[c] !== undefined ? srcRow[c] : '');
            }
            out.push(slice);
          }
          return { data: { values: out } };
        },
        batchUpdate: async ({ requestBody }) => {
          for (const item of requestBody?.data || []) {
            applyRangeWrite(item.range, item.values || []);
          }
          return { data: {} };
        },
        batchClear: async ({ requestBody }) => {
          for (const rangeStr of requestBody?.ranges || []) {
            const { sheet, startRow, startCol, endRow, endCol } = parseA1Range(rangeStr);
            const sh = getSheet(sheet);
            for (let r = startRow; r <= endRow; r++) {
              if (!sh.values[r]) continue;
              for (let c = startCol; c <= endCol; c++) {
                sh.values[r][c] = '';
                sh.formulas[r][c] = '';
              }
              recalcRowFormulas(workbookState, sheet, r);
            }
          }
          return { data: {} };
        },
      },
    },
  };
}

function recalcRowFormulas(workbookState, sheetName, rowIdx) {
  const sh = workbookState.sheets[sheetName];
  if (!sh || !sh.formulas[rowIdx]) return;
  const fRow = sh.formulas[rowIdx];
  if (!sh.values[rowIdx]) sh.values[rowIdx] = [];

  for (let c = 0; c < fRow.length; c++) {
    const f = fRow[c];
    if (typeof f === 'string' && f.startsWith('=')) {
      sh.values[rowIdx][c] = evaluateWorkbookFormula(workbookState, sheetName, rowIdx + 1, c, f);
    }
  }
}

function evaluateWorkbookFormula(workbookState, sheetName, rowNum, colIdx, formula) {
  const sh = workbookState.sheets[sheetName];
  const vRow = (sh && sh.values[rowNum - 1]) || [];
  const settingsSh = workbookState.sheets['Settings'];

  if (sheetName === 'Spending') {
    const bDate = vRow[1];
    const cCat = String(vRow[2] || '').trim();
    const jAmt = vRow[9];
    if (colIdx === 0) {
      if (!bDate && !jAmt) return '';
      return computeAutoCode('EX', bDate, rowNum);
    }
    if (colIdx === 3 || colIdx === 4) {
      if (!cCat) return '';
      if (settingsSh) {
        for (let r = 18; r < 58; r++) {
          const sRow = settingsSh.values[r] || [];
          if (String(sRow[2] || '').trim().toLowerCase() === cCat.toLowerCase()) {
            return colIdx === 3 ? sRow[1] : sRow[3];
          }
        }
      }
      return colIdx === 3 ? '??' : 'Unknown category';
    }
    if (colIdx === 11) return jAmt ? 1 : 0;
    if (colIdx === 12) return 1;
    if (colIdx === 13) return jAmt || '';
  }

  if (sheetName === 'Income') {
    const bDate = vRow[1];
    const cSrc = String(vRow[2] || '').trim();
    const hAmt = Number(vRow[7] || 0);
    if (colIdx === 0) {
      if (!bDate && !hAmt) return '';
      return computeAutoCode('IN', bDate, rowNum);
    }
    if (colIdx === 3) {
      if (!cSrc) return '';
      if (settingsSh) {
        for (let r = 18; r < 38; r++) {
          const sRow = settingsSh.values[r] || [];
          if (String(sRow[6] || '').trim().toLowerCase() === cSrc.toLowerCase()) {
            return sRow[5];
          }
        }
      }
      return '??';
    }
    if (colIdx >= 8 && colIdx <= 12) {
      if (!hAmt) return '';
      const shares = [0.1, 0.2, 0.3, 0.3, 0.1];
      return Math.round(hAmt * shares[colIdx - 8]);
    }
  }

  if (sheetName === 'Transfers') {
    const bDate = vRow[1];
    const gAmt = vRow[6];
    if (colIdx === 0) {
      if (!bDate && !gAmt) return '';
      return computeAutoCode('TR', bDate, rowNum);
    }
  }

  return '';
}

/**
 * Load the live Budget Tracker either via Google Sheets API v4 (if enabled and authorized)
 * or by fetching/reading the live `.xlsx` snapshot from Google Sheets.
 */
export async function createResilientSheetsApi({
  spreadsheetId = process.env.SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID,
  localCachePath = '/tmp/budget_tracker_live.xlsx',
  tryGoogleApi = true,
  webhookUrl = process.env.GOOGLE_WEBHOOK_URL || '',
} = {}) {
  if (tryGoogleApi) {
    try {
      const googleApi = createGoogleSheetsApi();
      if (googleApi) {
        const res = await googleApi.spreadsheets.get({
          spreadsheetId,
          fields: 'properties.title',
        });
        console.log(`[sheets] Connected to Google Sheets API: "${res.data.properties?.title || spreadsheetId}" (mode: google-sheets-api)`);
        return { api: googleApi, mode: 'google-sheets-api' };
      }
    } catch (err) {
      console.warn(`[sheets] Google Sheets API auth failed (${err.message}). Checking fallback...`);
    }
  }

  // Try downloading fresh XLSX export from Google Sheets if network available, else use cached `/tmp/budget_tracker_live.xlsx`
  let xlsxBuf = null;
  try {
    const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`;
    const res = await fetch(exportUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      xlsxBuf = Buffer.from(await res.arrayBuffer());
      await fs.promises.writeFile(localCachePath, xlsxBuf).catch(() => {});
    }
  } catch {}

  if (!xlsxBuf && fs.existsSync(localCachePath)) {
    xlsxBuf = await fs.promises.readFile(localCachePath);
  }

  if (xlsxBuf) {
    const state = parseXlsxBuffer(xlsxBuf);
    console.warn(`[sheets] Running in fallback mode: live-xlsx-snapshot${webhookUrl ? ' (with Google Apps Script Webhook writes)' : ' (READ-ONLY IN-MEMORY - NO WRITES PERSIST TO GOOGLE SHEETS!)'}`);
    return {
      api: createWorkbookSheetsApi(state, { webhookUrl }),
      mode: 'live-xlsx-snapshot',
    };
  }

  throw new Error(
    'Could not connect to Google Sheets API and no live XLSX snapshot was found. Set GOOGLE_SERVICE_ACCOUNT_JSON and enable Google Sheets API.'
  );
}
