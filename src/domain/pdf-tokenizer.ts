export type PdfTokenKind = 'string' | 'hex' | 'word' | 'number' | 'array' | 'other';

export interface PdfToken {
  kind: PdfTokenKind;
  start: number;
  end: number;
  raw: Uint8Array;
  decoded?: string;
  decodedBytes?: Uint8Array;
}

const whitespace = (byte: number) => byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
const delimiters = (byte: number) => whitespace(byte) || '()<>[]{}/%'.includes(String.fromCharCode(byte));

function decodeLiteralBytes(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let depth = 0;
  for (let i = 1; i < bytes.length - 1; i += 1) {
    const byte = bytes[i];
    if (byte === 92) {
      const next = bytes[++i];
      const escaped: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
      if (escaped[next] !== undefined) out.push(escaped[next]);
      else if (next >= 48 && next <= 55) {
        let octal = next - 48;
        for (let count = 0; count < 2 && i + 1 < bytes.length; count += 1) {
          const digit = bytes[i + 1];
          if (digit < 48 || digit > 55) break;
          octal = octal * 8 + digit - 48;
          i += 1;
        }
        out.push(octal & 255);
      } else if (next !== 10 && next !== 13) out.push(next);
    } else {
      if (byte === 40) depth += 1;
      if (byte === 41 && depth-- === 0) break;
      out.push(byte);
    }
  }
  return new Uint8Array(out);
}

function decodeHexBytes(bytes: Uint8Array): Uint8Array {
  const hex = String.fromCharCode(...bytes.slice(1, -1)).replace(/\s/g, '');
  const padded = hex.length % 2 ? `${hex}0` : hex;
  const decoded = new Uint8Array(padded.length / 2);
  for (let i = 0; i < decoded.length; i += 1) decoded[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return decoded;
}

export function scanPdfTokens(input: Uint8Array): PdfToken[] {
  const tokens: PdfToken[] = [];
  let i = 0;
  while (i < input.length) {
    if (whitespace(input[i])) { i += 1; continue; }
    if (input[i] === 37) { while (i < input.length && input[i] !== 10 && input[i] !== 13) i += 1; continue; }
    const start = i;
    if (input[i] === 40) {
      let depth = 1; i += 1;
      while (i < input.length && depth > 0) { if (input[i] === 92) i += 2; else { if (input[i] === 40) depth += 1; if (input[i] === 41) depth -= 1; i += 1; } }
      const raw = input.slice(start, i);
      const decodedBytes = decodeLiteralBytes(raw);
      tokens.push({ kind: 'string', start, end: i, raw, decodedBytes, decoded: new TextDecoder('latin1').decode(decodedBytes) });
      continue;
    }
    if (input[i] === 60 && input[i + 1] !== 60) {
      i += 1; while (i < input.length && input[i] !== 62) i += 1; i += 1;
      const raw = input.slice(start, i);
      const decodedBytes = decodeHexBytes(raw);
      tokens.push({ kind: 'hex', start, end: i, raw, decodedBytes, decoded: new TextDecoder('latin1').decode(decodedBytes) });
      continue;
    }
    if (input[i] === 91 || input[i] === 93) { i += 1; tokens.push({ kind: 'array', start, end: i, raw: input.slice(start, i) }); continue; }
    if (input[i] === 60 || input[i] === 62 || input[i] === 123 || input[i] === 125 || input[i] === 47) {
      i += 1; tokens.push({ kind: 'other', start, end: i, raw: input.slice(start, i) }); continue;
    }
    while (i < input.length && !delimiters(input[i])) i += 1;
    const raw = input.slice(start, i);
    const word = new TextDecoder('latin1').decode(raw);
    const kind: PdfTokenKind = /^[-+]?\d*\.?\d+$/.test(word) ? 'number' : 'word';
    tokens.push({ kind, start, end: i, raw });
  }
  return tokens;
}

export function encodeSimplePdfString(text: string): Uint8Array | null {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 255 || code === 0) return null;
    bytes[i] = code;
  }
  return bytes;
}
