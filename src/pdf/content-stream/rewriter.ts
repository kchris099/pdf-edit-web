import { encodeSimplePdfString, scanPdfTokens, type PdfToken } from '../../domain/pdf-tokenizer';
import type { FontEncodingMap, FontEncodingMaps } from '../font-encoding';

export interface RewriteResult {
  success: boolean;
  content: Uint8Array;
  message: string;
  missingCodePoints: number[];
  matchCount?: number;
  fontResource?: string;
  fontSize?: number;
}

const decoder = new TextDecoder('latin1');
const encoder = new TextEncoder();

function bytesToText(bytes: Uint8Array): string { return decoder.decode(bytes); }

/**
 * Serialize font character codes without passing them through UTF-8.
 *
 * PDF literal strings are byte strings, not Unicode strings. Converting a
 * WinAnsi byte such as E4 (ä) to JavaScript text and then using TextEncoder
 * changes it to the two UTF-8 bytes C3 A4, which selects different glyphs in
 * the embedded font. Octal escapes keep every original character code intact.
 */
function literalPdfString(bytes: Uint8Array): Uint8Array {
  let literal = '(';
  for (const byte of bytes) {
    if (byte === 40 || byte === 41 || byte === 92) {
      literal += `\\${String.fromCharCode(byte)}`;
    } else if (byte === 10) {
      literal += '\\n';
    } else if (byte === 13) {
      literal += '\\r';
    } else if (byte === 9) {
      literal += '\\t';
    } else if (byte === 8) {
      literal += '\\b';
    } else if (byte === 12) {
      literal += '\\f';
    } else if (byte < 32 || byte > 126) {
      literal += `\\${byte.toString(8).padStart(3, '0')}`;
    } else {
      literal += String.fromCharCode(byte);
    }
  }
  return encoder.encode(`${literal})`);
}

function replacementForToken(token: PdfToken, replacement: Uint8Array): Uint8Array {
  if (token.kind === 'hex') {
    const hex = Array.from(replacement, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    return encoder.encode(`<${hex}>`);
  }
  return literalPdfString(replacement);
}

function trackingForShow(show: TextShow, tokens: PdfToken[], map?: FontEncodingMap): number | undefined {
  if (tokenWord(tokens[show.endToken]) !== 'TJ') return undefined;
  // Character-tracked arrays normally contain one encoded glyph per string.
  // Arrays created for fonts without a space glyph contain whole words with
  // -250 positioning between them. Treating those word gaps as tracking on a
  // later edit spreads every character across the line.
  if (show.strings.some((token) => [...decodedTokenText(token, map)].length !== 1)) return undefined;
  const offsets = tokens
    .slice(show.startToken, show.endToken + 1)
    .filter((token) => token.kind === 'number')
    .map((token) => Number(tokenWord(token)))
    .filter((value) => Number.isFinite(value) && value <= -30 && value >= -500);
  if (offsets.length < 2 || offsets.length < show.strings.length - 3) return undefined;
  return offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
}

function fontForShow(show: TextShow, tokens: PdfToken[]): { resource?: string; size?: number } {
  for (let index = show.startToken - 1; index >= 3; index -= 1) {
    if (tokenWord(tokens[index]) !== 'Tf') continue;
    const size = Number(tokenWord(tokens[index - 1]));
    const resource = tokenWord(tokens[index - 2]);
    return {
      resource: resource || undefined,
      size: Number.isFinite(size) ? size : undefined,
    };
  }
  return {};
}

function trackedReplacement(replacement: Uint8Array, tracking: number): Uint8Array {
  const parts: string[] = ['['];
  const offset = String(Math.round(tracking));
  replacement.forEach((byte, index) => {
    if (byte === 32) {
      // Match the desktop editor's layout-only word gap. This avoids
      // requiring a space glyph in subset fonts that do not contain one.
      parts.push(' -250 ');
      return;
    }
    parts.push(`<${byte.toString(16).padStart(2, '0').toUpperCase()}>`);
    if (index < replacement.length - 1 && replacement[index + 1] !== 32) parts.push(` ${offset} `);
  });
  parts.push('] TJ');
  return encoder.encode(parts.join(''));
}

function hexString(bytes: Uint8Array): string {
  return `<${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}>`;
}

function encodeWithMap(text: string, map?: FontEncodingMap): { bytes?: Uint8Array; missingCodePoints: number[] } {
  if (map) {
    const encoded = map.encode(text);
    return encoded.missingCodePoints.length
      ? { missingCodePoints: encoded.missingCodePoints }
      : { bytes: encoded.bytes, missingCodePoints: [] };
  }
  const bytes = encodeSimplePdfString(text);
  return bytes
    ? { bytes, missingCodePoints: [] }
    : { missingCodePoints: [...text].map((character) => character.codePointAt(0) ?? 0) };
}

/**
 * Word/Td-spaced PDFs often omit a space character from their subset font.
 * Recreate those visual gaps with TJ positioning, exactly as the desktop path
 * does, instead of silently compacting the replacement text.
 */
function layoutWhitespaceReplacement(text: string, map?: FontEncodingMap): { operator?: Uint8Array; missingCodePoints: number[] } {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const encodedWords: Uint8Array[] = [];
  const missingCodePoints: number[] = [];
  for (const word of words) {
    const encoded = encodeWithMap(word, map);
    if (encoded.bytes) encodedWords.push(encoded.bytes);
    else missingCodePoints.push(...encoded.missingCodePoints);
  }
  if (missingCodePoints.length || !encodedWords.length) return { missingCodePoints };
  return {
    operator: encoder.encode(`[${encodedWords.map(hexString).join(' -250 ')}] TJ`),
    missingCodePoints: [],
  };
}

function trackedMappedReplacement(text: string, tracking: number, map?: FontEncodingMap): { operator?: Uint8Array; missingCodePoints: number[] } {
  const parts: string[] = ['['];
  const offset = String(Math.round(tracking));
  const characters = [...text];
  const missingCodePoints: number[] = [];
  characters.forEach((character, index) => {
    if (/\s/u.test(character)) {
      parts.push(' -250 ');
      return;
    }
    const encoded = encodeWithMap(character, map);
    if (!encoded.bytes) { missingCodePoints.push(...encoded.missingCodePoints); return; }
    parts.push(hexString(encoded.bytes));
    if (index < characters.length - 1 && !/\s/u.test(characters[index + 1])) parts.push(` ${offset} `);
  });
  parts.push('] TJ');
  return missingCodePoints.length
    ? { missingCodePoints }
    : { operator: encoder.encode(parts.join('')), missingCodePoints: [] };
}

interface TextShow {
  start: number;
  end: number;
  startToken: number;
  endToken: number;
  strings: PdfToken[];
  text: string;
  origin?: { x: number; y: number };
  streamIndex: number;
  fontResource?: string;
}

interface TextMatch {
  start: TextShow;
  end: TextShow;
  shows: TextShow[];
}

const showOperators = new Set(['Tj', 'TJ', "'", '"']);
const hardPositionOperators = new Set(['TD', 'T*', 'Do']);

function tokenWord(token: PdfToken | undefined): string { return token ? bytesToText(token.raw) : ''; }

function isStringToken(token: PdfToken | undefined): token is PdfToken & { decoded: string } {
  return Boolean(token && (token.kind === 'string' || token.kind === 'hex'));
}

function textOrigin(tokens: PdfToken[], startToken: number): { x: number; y: number } | undefined {
  for (let index = startToken - 1; index >= 6; index -= 1) {
    if (tokenWord(tokens[index]) !== 'Tm') continue;
    const x = Number(tokenWord(tokens[index - 2]));
    const y = Number(tokenWord(tokens[index - 1]));
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }
  return undefined;
}

/** Find every text-show operator, including strings inside a TJ array. */
function decodedTokenText(token: PdfToken, map?: FontEncodingMap): string {
  return map && token.decodedBytes ? map.decode(token.decodedBytes) : token.decoded ?? '';
}

function textShows(tokens: PdfToken[], streamIndex: number, encodings?: FontEncodingMaps): TextShow[] {
  const shows: TextShow[] = [];
  let currentFont: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (tokenWord(token) === 'Tf') {
      currentFont = tokenWord(tokens[index - 2]).replace(/^\//, '') || undefined;
      continue;
    }
    if (tokenWord(token) !== '[') {
      if (!isStringToken(token) || !showOperators.has(tokenWord(tokens[index + 1]))) continue;
      shows.push({
        start: token.start, end: tokens[index + 1].end, startToken: index, endToken: index + 1,
        strings: [token], text: decodedTokenText(token, currentFont ? encodings?.get(currentFont) : undefined),
        origin: textOrigin(tokens, index), streamIndex, fontResource: currentFont,
      });
      continue;
    }

    let depth = 1;
    let close = -1;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const word = tokenWord(tokens[cursor]);
      if (word === '[') depth += 1;
      if (word === ']' && --depth === 0) { close = cursor; break; }
    }
    if (close < 0 || tokenWord(tokens[close + 1]) !== 'TJ') continue;
    const strings = tokens.slice(index + 1, close).filter(isStringToken);
    const map = currentFont ? encodings?.get(currentFont) : undefined;
    shows.push({
      start: token.start, end: tokens[close + 1].end, startToken: index, endToken: close + 1,
      strings, text: strings.map((value) => decodedTokenText(value, map)).join(''),
      origin: textOrigin(tokens, index), streamIndex, fontResource: currentFont,
    });
    index = close + 1;
  }
  return shows;
}

function mayJoin(previousTokens: PdfToken[], previous: TextShow, nextTokens: PdfToken[], next: TextShow): boolean {
  if (previous.streamIndex !== next.streamIndex) {
    // A PDF page may expose each visible text object as a separate Contents
    // stream. MuPDF still groups those objects into one structured-text line,
    // but without origins there is no safe way to tell a line break from a
    // stream boundary.
    return Boolean(previous.origin && next.origin && Math.abs(previous.origin.y - next.origin.y) <= 6);
  }
  let resetByTextMatrix = false;
  for (let index = previous.endToken + 1; index < next.startToken; index += 1) {
    if (previousTokens[index].kind === 'word' && hardPositionOperators.has(tokenWord(previousTokens[index]))) return false;
    if (previousTokens[index].kind === 'word' && tokenWord(previousTokens[index]) === 'cm' && (!previous.origin || !next.origin)) return false;
    if (tokenWord(previousTokens[index]) === 'Tm') resetByTextMatrix = true;
    if (tokenWord(previousTokens[index]) === 'Td') {
      const vertical = Number(tokenWord(previousTokens[index - 1]));
      if (!resetByTextMatrix && (!Number.isFinite(vertical) || Math.abs(vertical) > 0.001)) return false;
    }
  }
  if (previous.origin && next.origin && Math.abs(previous.origin.y - next.origin.y) > 6) return false;
  return true;
}

function normalizedText(text: string): string { return text.replace(/\s+/g, ' '); }

function compactText(text: string): string { return text.replace(/\s/g, ''); }

function inferredText(shows: TextShow[]): string {
  return shows.reduce((result, show, index) => {
    if (!index) return show.text;
    const previous = shows[index - 1].text;
    const left = previous[previous.length - 1];
    const right = show.text[0];
    const separator = left && right && !/\s/.test(left) && !/\s/.test(right) ? ' ' : '';
    return `${result}${separator}${show.text}`;
  }, '');
}

function matchesText(shows: TextShow[], originalText: string): boolean {
  const raw = shows.map((show) => show.text).join('');
  const inferred = inferredText(shows);
  const expected = normalizedText(originalText);
  const canIgnoreBoundaryWhitespace = originalText.trim() === originalText;
  return raw === originalText
    || inferred === originalText
    || normalizedText(raw) === expected
    || normalizedText(inferred) === expected
    // Some producers use TJ positioning numbers instead of literal spaces;
    // the structured-text layer still reports those as word-separated text.
    || (canIgnoreBoundaryWhitespace && compactText(raw) === compactText(originalText))
    || (canIgnoreBoundaryWhitespace && compactText(inferred) === compactText(originalText));
}

/**
 * Locate a visible line even when the PDF split it across several Tj/TJ
 * operators. This is common in exported menus, where each word or glyph can
 * be emitted as its own text-show operation.
 */
function findTextMatchInStreams(contents: Uint8Array[], originalText: string, occurrenceIndex: number, encodings?: FontEncodingMaps): { match?: TextMatch; count: number; tokens: PdfToken[][] } {
  const tokens = contents.map((content) => scanPdfTokens(content));
  const shows = tokens.flatMap((streamTokens, streamIndex) => textShows(streamTokens, streamIndex, encodings));
  const mayIgnoreLeadingWhitespace = originalText.trimStart() === originalText;
  let count = 0;
  for (let start = 0; start < shows.length; start += 1) {
    // A trimmed UI run must not claim preceding layout-only text objects.
    // Removing those objects would collapse independently positioned columns.
    if (mayIgnoreLeadingWhitespace && !shows[start].text.trim()) continue;
    for (let end = start; end < shows.length; end += 1) {
      if (end > start && !mayJoin(tokens[shows[end - 1].streamIndex], shows[end - 1], tokens[shows[end].streamIndex], shows[end])) break;
      const matchShows = shows.slice(start, end + 1);
      if (matchesText(matchShows, originalText)) {
        if (count++ === occurrenceIndex) return { match: { start: shows[start], end: shows[end], shows: matchShows }, count, tokens };
        break;
      }
    }
  }
  return { count, tokens };
}

function findTextMatch(content: Uint8Array, originalText: string, occurrenceIndex: number, encodings?: FontEncodingMaps): { match?: TextMatch; count: number; tokens: PdfToken[][] } {
  return findTextMatchInStreams([content], originalText, occurrenceIndex, encodings);
}

function replaceRange(content: Uint8Array, start: number, end: number, replacement: Uint8Array): Uint8Array {
  const result = new Uint8Array(content.length - (end - start) + replacement.length);
  result.set(content.slice(0, start));
  result.set(replacement, start);
  result.set(content.slice(end), start + replacement.length);
  return result;
}

/**
 * Preserve the original text-show operators when the replacement fits their
 * existing string operands. Styled markers commonly use TJ positioning in
 * addition to a smaller Tf size; replacing only the strings retains both.
 */
function replaceMatchedStringBytes(content: Uint8Array, match: TextMatch, replacement: Uint8Array): Uint8Array | undefined {
  const strings = match.shows.flatMap((show) => show.strings);
  const lengths = strings.map((token) => token.decoded?.length ?? 0);
  if (lengths.reduce((sum, length) => sum + length, 0) !== replacement.length) return undefined;

  let offset = 0;
  const edits = strings.map((token, index) => {
    const bytes = replacement.slice(offset, offset + lengths[index]);
    offset += lengths[index];
    return { token, replacement: replacementForToken(token, bytes) };
  });
  let result = content;
  for (const edit of edits.reverse()) {
    result = replaceRange(result, edit.token.start, edit.token.end, edit.replacement);
  }
  return result;
}

/**
 * Preserve Word-style glyph positioning for a pure deletion.
 *
 * Word commonly emits every glyph as `dx 0 Td <code> Tj`. Removing both the
 * deleted glyph and its relative Td step closes the deleted span while leaving
 * all surviving glyphs and their original spacing untouched.
 */
function deleteFromIndividuallyPositionedShows(
  content: Uint8Array,
  match: TextMatch,
  tokens: PdfToken[],
  replacementText: string,
): Uint8Array | undefined {
  if (match.shows.some((show) => show.streamIndex !== match.start.streamIndex || show.strings.length !== 1)) return undefined;
  const characters = match.shows.map((show) => [...show.text]);
  if (characters.some((value) => value.length !== 1 || /\s/u.test(value[0]))) return undefined;

  const replacement = [...replacementText].filter((character) => !/\s/u.test(character));
  const keep = new Set<number>();
  let replacementIndex = 0;
  for (let index = 0; index < characters.length && replacementIndex < replacement.length; index += 1) {
    if (characters[index][0] !== replacement[replacementIndex]) continue;
    keep.add(index);
    replacementIndex += 1;
  }
  if (replacementIndex !== replacement.length || keep.size === characters.length || !keep.has(0)) return undefined;

  const positionRange = (show: TextShow, index: number): { start: number; end: number } | undefined => {
    const tdIndex = show.startToken - 1;
    return tokenWord(tokens[tdIndex]) === 'Td'
      && tokens[tdIndex - 1]?.kind === 'number'
      && tokens[tdIndex - 2]?.kind === 'number'
      && (index === 0 || tokens[tdIndex - 2].start >= match.shows[index - 1].end)
      ? { start: tokens[tdIndex - 2].start, end: tokens[tdIndex].end }
      : undefined;
  };
  const edits: Array<{ start: number; end: number; replacement: Uint8Array }> = [];
  match.shows.forEach((show, index) => {
    if (keep.has(index)) return;
    const position = positionRange(show, index);
    edits.push({
      start: position?.start ?? show.start,
      end: show.end,
      replacement: new Uint8Array(),
    });
  });

  // The first surviving glyph after a deleted span moves into the first
  // deleted glyph's slot. Its following glyphs keep their own Td values, so
  // the suffix retains its original internal spacing.
  let previousKept = 0;
  for (let index = 1; index < match.shows.length; index += 1) {
    if (!keep.has(index)) continue;
    if (index > previousKept + 1) {
      const target = positionRange(match.shows[index], index);
      const source = positionRange(match.shows[previousKept + 1], previousKept + 1);
      if (!target || !source) return undefined;
      edits.push({ start: target.start, end: target.end, replacement: content.slice(source.start, source.end) });
    }
    previousKept = index;
  }

  let result = content;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = replaceRange(result, edit.start, edit.end, edit.replacement);
  }
  return result;
}

/**
 * Rewrites the original text-show operators. It keeps the old safe path for
 * one operand and additionally handles a complete line split across several
 * operands or a kerning TJ array. It never paints over the page.
 */
export function replaceTextInContentStream(
  content: Uint8Array,
  originalText: string,
  replacementText: string,
  occurrenceIndex = 0,
  encodings?: FontEncodingMaps,
): RewriteResult {
  const found = findTextMatch(content, originalText, occurrenceIndex, encodings);
  if (!found.match) return { success: false, content, message: 'The selected text was not found in the original content stream.', missingCodePoints: [], matchCount: found.count };

  const firstString = found.match.start.strings[0];
  if (!firstString) return { success: false, content, message: 'The selected text has no editable string operand.', missingCodePoints: [], matchCount: found.count };
  const selectedFont = fontForShow(found.match.start, found.tokens[found.match.start.streamIndex]);
  const fontResource = found.match.start.fontResource ?? selectedFont.resource?.replace(/^\//, '');
  const fontMap = fontResource ? encodings?.get(fontResource) : undefined;
  const tracking = trackingForShow(found.match.start, found.tokens[found.match.start.streamIndex], fontMap);
  const fullEncoding = encodeWithMap(replacementText, fontMap);
  const whitespaceOnlyMissing = fullEncoding.missingCodePoints.length > 0
    && fullEncoding.missingCodePoints.every((codePoint) => /\s/u.test(String.fromCodePoint(codePoint)));
  const layout = whitespaceOnlyMissing ? layoutWhitespaceReplacement(replacementText, fontMap) : undefined;
  if (!fullEncoding.bytes && !layout?.operator) {
    return {
      success: false,
      content,
      message: 'The embedded font encoding does not contain every replacement character.',
      missingCodePoints: layout?.missingCodePoints.length ? layout.missingCodePoints : fullEncoding.missingCodePoints,
      fontResource,
      fontSize: selectedFont.size,
    };
  }
  const replacement = fullEncoding.bytes ?? new Uint8Array();
  const positionedDeletion = deleteFromIndividuallyPositionedShows(
    content,
    found.match,
    found.tokens[found.match.start.streamIndex],
    replacementText,
  );
  if (positionedDeletion) {
    return {
      success: true,
      content: positionedDeletion,
      message: `Replaced ${originalText} in the original content stream.`,
      missingCodePoints: [],
      fontResource,
      fontSize: selectedFont.size,
    };
  }
  const structurePreservingResult = tracking === undefined && !encodings && !layout
    ? replaceMatchedStringBytes(content, found.match, replacement)
    : undefined;
  if (structurePreservingResult) {
    return { success: true, content: structurePreservingResult, message: `Replaced ${originalText} in the original content stream.`, missingCodePoints: [], fontResource: selectedFont.resource, fontSize: selectedFont.size };
  }
  const exactSingleOperand = found.match.start === found.match.end && found.match.start.strings.length === 1;
  const tracked = tracking !== undefined ? trackedMappedReplacement(replacementText, tracking, fontMap) : undefined;
  if (tracked && !tracked.operator) {
    return {
      success: false, content, message: 'The embedded font encoding does not contain every replacement character.',
      missingCodePoints: tracked.missingCodePoints, fontResource, fontSize: selectedFont.size,
    };
  }
  const encoded = tracked?.operator
    ?? layout?.operator
    ?? (exactSingleOperand
      ? replacementForToken(firstString, replacement)
      : encoder.encode(`${bytesToText(replacementForToken(firstString, replacement))} Tj`));
  const result = exactSingleOperand
    ? (tracked?.operator || layout?.operator
      ? replaceRange(content, found.match.start.start, found.match.end.end, encoded)
      : replaceRange(content, firstString.start, firstString.end, encoded))
    : replaceRange(content, found.match.start.start, found.match.end.end, encoded);
  return { success: true, content: result, message: `Replaced ${originalText} in the original content stream.`, missingCodePoints: [], fontResource: selectedFont.resource, fontSize: selectedFont.size };
}

/**
 * Replace a matched text show while switching it to a newly embedded simple
 * font. The surrounding text matrix, color, and graphics state stay intact.
 */
export function replaceTextInContentStreamWithFont(
  content: Uint8Array,
  originalText: string,
  replacementText: string,
  fontResource: string,
  occurrenceIndex = 0,
  encodings?: FontEncodingMaps,
): RewriteResult {
  const replacement = encodeSimplePdfString(replacementText);
  if (!replacement) {
    return {
      success: false,
      content,
      message: 'The online fallback currently supports Latin replacement text.',
      missingCodePoints: [...replacementText].map((character) => character.codePointAt(0) ?? 0),
    };
  }
  const found = findTextMatch(content, originalText, occurrenceIndex, encodings);
  if (!found.match) {
    return { success: false, content, message: 'The selected text was not found in the original content stream.', missingCodePoints: [], matchCount: found.count };
  }

  const selectedFont = fontForShow(found.match.start, found.tokens[found.match.start.streamIndex]);
  if (!selectedFont.size) {
    return { success: false, content, message: 'The selected text has no usable font size.', missingCodePoints: [], matchCount: found.count };
  }
  const sourceFontResource = found.match.start.fontResource ?? selectedFont.resource?.replace(/^\//, '');
  const sourceFontMap = sourceFontResource ? encodings?.get(sourceFontResource) : undefined;
  const tracking = trackingForShow(found.match.start, found.tokens[found.match.start.streamIndex], sourceFontMap);
  const shown = tracking === undefined
    ? `${bytesToText(literalPdfString(replacement))} Tj`
    : bytesToText(trackedReplacement(replacement, tracking));
  const encoded = encoder.encode(`/${fontResource} ${selectedFont.size} Tf ${shown}`);
  const result = replaceRange(content, found.match.start.start, found.match.end.end, encoded);
  return {
    success: true,
    content: result,
    message: `Replaced ${originalText} using the embedded online font fallback.`,
    missingCodePoints: [],
    fontResource,
    fontSize: selectedFont.size,
  };
}

/** Move the complete selected text cluster without painting over the source. */
export function moveTextInContentStream(content: Uint8Array, originalText: string, deltaX: number, deltaY: number, occurrenceIndex = 0, encodings?: FontEncodingMaps): RewriteResult {
  const found = findTextMatch(content, originalText, occurrenceIndex, encodings);
  if (!found.match) return { success: false, content, message: 'The selected text was not found in the original content stream.', missingCodePoints: [], matchCount: found.count };
  return moveMatchedTextObjects(content, found.tokens[0], found.match.shows, deltaX, deltaY, found.count);
}

function moveMatchedTextObjects(content: Uint8Array, tokens: PdfToken[], matchedShows: TextShow[], deltaX: number, deltaY: number, matchCount: number): RewriteResult {
  const number = (value: number) => Number.isFinite(value) ? String(Number(value.toFixed(4))) : '0';
  const prefix = encoder.encode(`q\n1 0 0 1 ${number(deltaX)} ${number(deltaY)} cm\n`);
  const suffix = encoder.encode('\nQ');
  const startOffset = Math.min(...matchedShows.map((show) => show.start));
  const endOffset = Math.max(...matchedShows.map((show) => show.end));
  const objects: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokenWord(tokens[index]) !== 'BT') continue;
    const endToken = tokens.slice(index + 1).find((token) => tokenWord(token) === 'ET');
    if (!endToken) continue;
    const end = endToken.end;
    if (tokens[index].start < endOffset && end > startOffset) objects.push({ start: tokens[index].start, end });
  }

  if (!objects.length) return { success: false, content, message: 'The selected text has no movable text object.', missingCodePoints: [], matchCount };

  // A menu line can span several BT…ET objects. Each object has its own
  // internal Q, so a single outer transform would be restored after the first
  // fragment. Wrap every matched text object independently instead.
  let result = content;
  for (const object of [...objects].reverse()) {
    const withSuffix = new Uint8Array(result.length + suffix.length);
    withSuffix.set(result.slice(0, object.end), 0);
    withSuffix.set(suffix, object.end);
    withSuffix.set(result.slice(object.end), object.end + suffix.length);
    const withPrefix = new Uint8Array(withSuffix.length + prefix.length);
    withPrefix.set(withSuffix.slice(0, object.start), 0);
    withPrefix.set(prefix, object.start);
    withPrefix.set(withSuffix.slice(object.start), object.start + prefix.length);
    result = withPrefix;
  }
  return { success: true, content: result, message: 'Moved the selected text cluster.', missingCodePoints: [] };
}

export interface MultiStreamMoveResult {
  success: boolean;
  contents: Uint8Array[];
  message: string;
  missingCodePoints: number[];
  matchCount?: number;
}

/** Move a logical text line even when its PDF objects live in several page streams. */
export function moveTextInContentStreams(contents: Uint8Array[], originalText: string, deltaX: number, deltaY: number, occurrenceIndex = 0, encodings?: FontEncodingMaps): MultiStreamMoveResult {
  const found = findTextMatchInStreams(contents, originalText, occurrenceIndex, encodings);
  if (!found.match) return { success: false, contents, message: 'The selected text was not found in the page content streams.', missingCodePoints: [], matchCount: found.count };

  const moved = contents.map((content, streamIndex) => {
    const shows = found.match!.shows.filter((show) => show.streamIndex === streamIndex);
    return shows.length
      ? moveMatchedTextObjects(content, found.tokens[streamIndex], shows, deltaX, deltaY, found.count).content
      : content;
  });
  return { success: true, contents: moved, message: 'Moved the selected text cluster.', missingCodePoints: [] };
}
