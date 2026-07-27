import { describe, expect, it } from 'vitest';
import type { StructuredTextChar } from '../../src/pdf/text-runs';
import { groupStructuredTextLine } from '../../src/pdf/text-runs';

function chars(text: string, startX: number, y: number, size: number, font = 'MenuFont'): StructuredTextChar[] {
  return [...text].map((value, index) => {
    const x = startX + index * size * 0.5;
    return {
      text: value,
      origin: [x, y],
      font,
      size,
      quad: [x, y - size, x + size * 0.5, y - size, x, y + 2, x + size * 0.5, y + 2],
      color: [0],
      bidi: 0,
    };
  });
}

describe('structured text run grouping', () => {
  it('collapses MuPDF spaces synthesized between tracked capital letters', () => {
    const runs = groupStructuredTextLine(chars('SU P P E N', 0, 10, 12), [1, 0]);
    expect(runs.map((run) => run.text)).toEqual(['SUPPEN']);
  });

  it('keeps a normal same-style line together', () => {
    const runs = groupStructuredTextLine(chars('Kartoffelsuppe mit Wurst', 10, 30, 12), [1, 0]);
    expect(runs.map((run) => run.text)).toEqual(['Kartoffelsuppe mit Wurst']);
  });

  it('separates a smaller superscript marker while keeping its punctuation together', () => {
    const normal = chars('Kartoffelsuppe mit gebratener Wurst ', 10, 30, 12);
    const marker = chars('2,5', 214, 25, 7);
    const runs = groupStructuredTextLine([...normal, ...marker], [1, 0]);

    expect(runs.map((run) => run.text)).toEqual(['Kartoffelsuppe mit gebratener Wurst', '2,5']);
    expect(runs[1].bounds.height).toBeLessThan(runs[0].bounds.height);
  });

  it('separates text with a shifted baseline even when its font and size match', () => {
    const runs = groupStructuredTextLine([
      ...chars('Wurst ', 10, 30, 12),
      ...chars('2,5', 46, 25, 12),
    ], [1, 0]);
    expect(runs.map((run) => run.text)).toEqual(['Wurst', '2,5']);
  });

  it('separates a Unicode superscript glyph with the same reported font metrics', () => {
    const runs = groupStructuredTextLine(chars('Gulaschsuppe mit Bauernbrot \u00b2', 10, 30, 12), [1, 0]);
    expect(runs.map((run) => run.text)).toEqual(['Gulaschsuppe mit Bauernbrot', '\u00b2']);
  });

  it('keeps punctuation inside a compound Unicode superscript marker', () => {
    const runs = groupStructuredTextLine(chars('Wurst \u00b2,\u2075', 10, 30, 12), [1, 0]);
    expect(runs.map((run) => run.text)).toEqual(['Wurst', '\u00b2,\u2075']);
  });

  it('splits columns separated by repeated space glyphs', () => {
    const runs = groupStructuredTextLine(
      chars('Beilagensalat            Blatt-, Gurken- oder Krautsalat ', 10, 30, 12),
      [1, 0],
    );

    expect(runs.map((run) => run.text)).toEqual([
      'Beilagensalat',
      'Blatt-, Gurken- oder Krautsalat',
    ]);
    expect(runs[0].bounds.x + runs[0].bounds.width).toBeLessThan(runs[1].bounds.x);
  });

  it('removes leading and trailing whitespace from editable runs', () => {
    const runs = groupStructuredTextLine(chars('  Hähnchenbrustfilet  ', 10, 30, 12), [1, 0]);
    expect(runs.map((run) => run.text)).toEqual(['Hähnchenbrustfilet']);
  });
});
