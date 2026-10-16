import type { PriceRow, UnitStatus } from '../types';

/**
 * Price sheet parsing for the agent panel: .csv or .xlsx → PriceRow[].
 * Columns are found by header name, in English or Arabic. Prices are SAR (major units) and may be
 * written "850,000", "850000 SAR" or with Arabic-Indic digits. Status is optional.
 */

const HEADERS: Record<'unit_code' | 'price' | 'status', string[]> = {
  unit_code: ['unit_code', 'unit code', 'unit', 'code', 'unit no', 'unit number', 'رقم الوحدة', 'الوحدة', 'رمز الوحدة'],
  price: ['price', 'price (sar)', 'price sar', 'sar', 'السعر', 'سعر', 'السعر (ريال)'],
  status: ['status', 'الحالة', 'حالة'],
};

const STATUS_WORDS: Record<string, UnitStatus> = {
  available: 'available', free: 'available', 'متاح': 'available', 'متاحة': 'available',
  reserved: 'reserved', hold: 'reserved', 'محجوز': 'reserved', 'محجوزة': 'reserved',
  sold: 'sold', 'مباع': 'sold', 'مباعة': 'sold',
};

// Arabic-Indic (٠-٩) and Persian (۰-۹) digits → 0-9.
const toLatinDigits = (s: string) =>
  s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0));

export interface ParsedSheet {
  rows: PriceRow[];
  lines: number[];                              // spreadsheet line of each row, as Excel numbers it
  problems: { row: number; error: string }[];   // rows we couldn't read at all (shown before upload)
}

export function parsePrice(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  const s = toLatinDigits(String(raw ?? ''))
    .replace(/[٬,\s]/g, '')          // thousands separators (incl. Arabic ٬)
    .replace(/٫/g, '.')              // Arabic decimal separator
    .replace(/sar|ريال|ر\.س/gi, '');
  return s ? Number(s) : NaN;
}

function rowsToPrices(table: unknown[][]): ParsedSheet {
  const problems: ParsedSheet['problems'] = [];
  const headerIndex = table.findIndex(r => r.some(c => typeof c === 'string' && c.trim()));
  if (headerIndex < 0) return { rows: [], lines: [], problems: [{ row: 0, error: 'The sheet is empty' }] };
  const header = table[headerIndex].map(c => String(c ?? '').trim().toLowerCase());
  const col = (k: keyof typeof HEADERS) => header.findIndex(h => HEADERS[k].includes(h));
  const iCode = col('unit_code'), iPrice = col('price'), iStatus = col('status');
  if (iCode < 0 || iPrice < 0) {
    return { rows: [], lines: [], problems: [{ row: headerIndex + 1, error: 'Need a "unit_code" (رقم الوحدة) column and a "price" (السعر) column in the first row' }] };
  }

  const rows: PriceRow[] = [];
  const lines: number[] = [];
  table.slice(headerIndex + 1).forEach((r, i) => {
    const line = headerIndex + 2 + i; // 1-based, as Excel shows it
    const code = toLatinDigits(String(r[iCode] ?? '')).trim();
    if (!code && r.every(c => c === null || c === undefined || String(c).trim() === '')) return; // blank line
    const price = parsePrice(r[iPrice]);
    if (!code) return problems.push({ row: line, error: 'Missing unit code' });
    if (!Number.isFinite(price)) return problems.push({ row: line, error: `Can't read the price "${r[iPrice] ?? ''}"` });
    const rawStatus = iStatus >= 0 ? String(r[iStatus] ?? '').trim().toLowerCase() : '';
    const status = rawStatus ? STATUS_WORDS[rawStatus] : undefined;
    if (rawStatus && !status) return problems.push({ row: line, error: `Unknown status "${r[iStatus]}" (use available / reserved / sold)` });
    rows.push({ unit_code: code, price, ...(status && { status }) });
    lines.push(line);
  });
  return { rows, lines, problems };
}

/** Minimal RFC 4180 CSV: quoted fields, "" escapes, CRLF or LF, and ; as separator if that's what the file uses. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out;
}

export async function readPriceSheet(file: File): Promise<ParsedSheet> {
  if (/\.xlsx$/i.test(file.name)) {
    const { default: readXlsxFile } = await import('read-excel-file'); // only loaded when needed
    return rowsToPrices(await readXlsxFile(file) as unknown[][]);
  }
  if (/\.(csv|txt)$/i.test(file.name)) return rowsToPrices(parseCsv(await file.text()));
  return { rows: [], lines: [], problems: [{ row: 0, error: 'Use an Excel (.xlsx) or CSV file. Older .xls files: save as .xlsx first.' }] };
}

/** The current units as a CSV the admin can edit and re-upload. */
export function priceSheetCsv(units: { unit_code: string; price: number; status: UnitStatus }[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = units.map(u => [esc(u.unit_code), u.price > 0 ? String(u.price / 100) : '', u.status].join(','));
  return '﻿' + ['unit_code,price,status', ...lines].join('\r\n'); // BOM so Excel reads UTF-8
}
