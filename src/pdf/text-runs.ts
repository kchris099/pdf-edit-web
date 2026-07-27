import type { Color, Point, Quad } from 'mupdf';

export interface StructuredTextChar {
  text: string;
  origin: Point;
  font: string;
  size: number;
  quad: Quad;
  color: Color;
  bidi: number;
}

export interface StructuredTextRun {
  text: string;
  font: string;
  bounds: { x: number; y: number; width: number; height: number };
}

function colorsMatch(left: Color, right: Color): boolean {
  return left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) <= 0.01);
}

function crossAxisDistance(left: StructuredTextChar, right: StructuredTextChar, direction: Point): number {
  const length = Math.hypot(direction[0], direction[1]);
  if (length < 1e-6) return Math.abs(right.origin[1] - left.origin[1]);
  const crossX = -direction[1] / length;
  const crossY = direction[0] / length;
  return Math.abs((right.origin[0] - left.origin[0]) * crossX + (right.origin[1] - left.origin[1]) * crossY);
}

function sameTextStyle(first: StructuredTextChar, current: StructuredTextChar, direction: Point): boolean {
  const sizeTolerance = Math.max(0.05, Math.max(first.size, current.size) * 0.02);
  const baselineTolerance = Math.max(0.5, Math.max(first.size, current.size) * 0.08);
  return first.font === current.font
    && Math.abs(first.size - current.size) <= sizeTolerance
    && first.bidi === current.bidi
    && colorsMatch(first.color, current.color)
    && crossAxisDistance(first, current, direction) <= baselineTolerance;
}

function isSuperscriptMarker(char: StructuredTextChar): boolean {
  const codePoint = char.text.codePointAt(0);
  return codePoint === 0x00b2
    || codePoint === 0x00b3
    || codePoint === 0x00b9
    || (codePoint !== undefined && codePoint >= 0x2070 && codePoint <= 0x207f);
}

function continuesSuperscriptMarker(char: StructuredTextChar): boolean {
  return isSuperscriptMarker(char) || /^[0-9,.;:/+\-()]$/u.test(char.text);
}

function crossesSuperscriptBoundary(group: StructuredTextChar[], current: StructuredTextChar): boolean {
  const groupHasMarker = group.some(isSuperscriptMarker);
  if (isSuperscriptMarker(current)) return !groupHasMarker;
  return groupHasMarker && !continuesSuperscriptMarker(current);
}

function boundsFor(chars: StructuredTextChar[]): StructuredTextRun['bounds'] {
  const coordinates = chars.flatMap((char) => char.quad);
  const xs = coordinates.filter((_, index) => index % 2 === 0);
  const ys = coordinates.filter((_, index) => index % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function isWhitespace(char: StructuredTextChar): boolean {
  return /^\s$/u.test(char.text);
}

/**
 * PDF producers often align columns by drawing a long sequence of space
 * glyphs. Expose the columns as separate editable objects and keep boundary
 * whitespace out of their text and hit boxes.
 */
function splitLayoutWhitespace(chars: StructuredTextChar[]): StructuredTextChar[][] {
  const segments: StructuredTextChar[][] = [];
  let segment: StructuredTextChar[] = [];
  for (let index = 0; index < chars.length;) {
    if (!isWhitespace(chars[index])) {
      segment.push(chars[index]);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < chars.length && isWhitespace(chars[end])) end += 1;
    const whitespace = chars.slice(index, end);
    const isBoundary = !segment.length || end === chars.length;
    if (whitespace.length >= 2 || isBoundary) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else {
      segment.push(...whitespace);
    }
    index = end;
  }
  if (segment.length) segments.push(segment);
  return segments;
}

/**
 * MuPDF's JSON output flattens every visual line to one object. Keep the
 * character-level style boundaries exposed by StructuredText.walk instead,
 * matching the desktop extractor's span-based behavior.
 */
export function groupStructuredTextLine(chars: StructuredTextChar[], direction: Point): StructuredTextRun[] {
  if (!chars.length) return [];
  const groups: StructuredTextChar[][] = [[chars[0]]];
  for (const char of chars.slice(1)) {
    const group = groups[groups.length - 1];
    if (sameTextStyle(group[0], char, direction) && !crossesSuperscriptBoundary(group, char)) group.push(char);
    else groups.push([char]);
  }
  return groups.flatMap(splitLayoutWhitespace).map((group) => ({
    // MuPDF can infer a space for every tracking gap in all-caps headings.
    // Keep inferred word spaces, but collapse the characteristic "SU P P E N"
    // pattern produced by letter-spaced PDF operators.
    text: group.map((char) => char.text).join('').replace(/^([A-Z0-9]+(?:\s+[A-Z0-9]){2,})$/u, (value) => value.replace(/\s/g, '')),
    font: group[0].font,
    bounds: boundsFor(group),
  }));
}
