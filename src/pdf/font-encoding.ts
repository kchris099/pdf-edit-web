import type * as mupdf from 'mupdf';

function key(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function hexBytes(value: string): Uint8Array {
  const padded = value.length % 2 ? `0${value}` : value;
  return Uint8Array.from({ length: padded.length / 2 }, (_, index) => Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16));
}

function utf16Be(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    result += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
  }
  return result;
}

function bigEndianCode(value: number, width: number): Uint8Array {
  const result = new Uint8Array(width);
  for (let index = width - 1; index >= 0; index -= 1) {
    result[index] = value & 0xff;
    value >>>= 8;
  }
  return result;
}

/** Bidirectional character-code map built from a PDF font's ToUnicode CMap. */
export class FontEncodingMap {
  private readonly codeToText = new Map<string, string>();
  private readonly textToCode = new Map<string, Uint8Array>();
  private codeWidth = 1;

  add(code: Uint8Array, text: string): void {
    if (!code.length || !text) return;
    this.codeWidth = Math.max(this.codeWidth, code.length);
    this.codeToText.set(key(code), text);
    if ([...text].length === 1 && !this.textToCode.has(text)) this.textToCode.set(text, code);
  }

  decode(bytes: Uint8Array): string {
    let result = '';
    for (let offset = 0; offset < bytes.length;) {
      let found: string | undefined;
      let consumed = 0;
      for (let width = Math.min(this.codeWidth, bytes.length - offset); width >= 1; width -= 1) {
        found = this.codeToText.get(key(bytes.slice(offset, offset + width)));
        if (found !== undefined) { consumed = width; break; }
      }
      if (found === undefined) { result += '\ufffd'; offset += 1; }
      else { result += found; offset += consumed; }
    }
    return result;
  }

  encode(text: string): { bytes: Uint8Array; missingCodePoints: number[] } {
    const parts: Uint8Array[] = [];
    const missingCodePoints: number[] = [];
    for (const character of text) {
      const alternate = character === ' ' ? '\u00a0' : character === '\u00a0' ? ' ' : '';
      const code = this.textToCode.get(character) ?? (alternate ? this.textToCode.get(alternate) : undefined);
      if (code) parts.push(code);
      else missingCodePoints.push(character.codePointAt(0) ?? 0);
    }
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return { bytes, missingCodePoints };
  }

  static winAnsi(): FontEncodingMap {
    const map = new FontEncodingMap();
    const decoder = new TextDecoder('windows-1252');
    for (let value = 0; value < 256; value += 1) map.add(Uint8Array.of(value), decoder.decode(Uint8Array.of(value)));
    return map;
  }
}

export function parseToUnicodeCMap(bytes: Uint8Array): FontEncodingMap {
  const source = new TextDecoder('latin1').decode(bytes);
  const map = new FontEncodingMap();
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.add(hexBytes(pair[1]), utf16Be(hexBytes(pair[2])));
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    for (const range of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = Number.parseInt(range[1], 16);
      const end = Number.parseInt(range[2], 16);
      const destination = Number.parseInt(range[3], 16);
      const width = Math.ceil(range[1].length / 2);
      for (let code = start; code <= end; code += 1) {
        map.add(bigEndianCode(code, width), String.fromCodePoint(destination + code - start));
      }
    }
    for (const range of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]+)\]/g)) {
      const start = Number.parseInt(range[1], 16);
      const end = Number.parseInt(range[2], 16);
      const width = Math.ceil(range[1].length / 2);
      const values = Array.from(range[3].matchAll(/<([0-9A-Fa-f]+)>/g), (match) => match[1]);
      for (let code = start; code <= end && code - start < values.length; code += 1) {
        map.add(bigEndianCode(code, width), utf16Be(hexBytes(values[code - start])));
      }
    }
  }
  return map;
}

export type FontEncodingMaps = Map<string, FontEncodingMap>;

/** Build the same page-resource encoding lookup used by the desktop editor. */
export function buildFontEncodingMaps(page: mupdf.PDFPage): FontEncodingMaps {
  const maps: FontEncodingMaps = new Map();
  const resources = page.getObject().getInheritable('Resources');
  const fonts = resources.isDictionary() ? resources.get('Font') : null;
  if (!fonts?.isDictionary()) return maps;
  fonts.forEach((fontValue, resourceKey) => {
    const font = fontValue.resolve();
    let map: FontEncodingMap | undefined;
    const toUnicode = font.get('ToUnicode');
    if (toUnicode.isStream()) {
      try { map = parseToUnicodeCMap(new Uint8Array(toUnicode.readStream().asUint8Array())); }
      catch { map = undefined; }
    }
    const encoding = font.get('Encoding');
    if (!map && encoding.isName() && /WinAnsi|Latin/i.test(encoding.asName())) map = FontEncodingMap.winAnsi();
    if (!map) return;
    maps.set(String(resourceKey).replace(/^\//, ''), map);
    const baseFont = font.get('BaseFont');
    if (baseFont.isName()) maps.set(baseFont.asName().replace(/^\//, ''), map);
  });
  return maps;
}
