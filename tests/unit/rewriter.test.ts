import { describe, expect, it } from 'vitest';
import { moveTextInContentStream, moveTextInContentStreams, moveTextInContentStreamsBatch, replaceTextInContentStream, replaceTextInContentStreamWithFont } from '../../src/pdf/content-stream/rewriter';
import { FontEncodingMap } from '../../src/pdf/font-encoding';

describe('conservative content-stream rewriter', () => {
  it('changes only the selected hex Tj/TJ operand', () => {
    const source = new TextEncoder().encode('q BT /F1 12 Tf <4163636f756e74204944> Tj ET Q\nq BT <4163636f756e74204944> Tj ET Q');
    const result = replaceTextInContentStream(source, 'Account ID', 'Client ID');
    expect(result.success).toBe(true);
    expect(new TextDecoder().decode(result.content)).toContain('<436C69656E74204944>');
    expect(new TextDecoder().decode(result.content)).toContain('<4163636f756e74204944> Tj ET Q');
  });

  it('preserves WinAnsi character codes when shortening a literal string', () => {
    const source = new TextEncoder().encode(
      'BT /F4 12 Tf [(\\273 mit H\\344hnchenbrustfilet in Curry Marinade  )] TJ ET',
    );
    const result = replaceTextInContentStream(
      source,
      '» mit Hähnchenbrustfilet in Curry Marinade  ',
      '» mit Hähnchenbrustfilet in  Marinade  ',
    );

    expect(result.success).toBe(true);
    const output = new TextDecoder().decode(result.content);
    expect(output).toContain('(\\273 mit H\\344hnchenbrustfilet in  Marinade  )');
    expect(Array.from(result.content)).not.toEqual(expect.arrayContaining([0xc2, 0xbb]));
    expect(Array.from(result.content)).not.toEqual(expect.arrayContaining([0xc3, 0xa4]));
  });

  it('refuses text that cannot be encoded by the current simple-font path', () => {
    const source = new TextEncoder().encode('<41> Tj');
    const result = replaceTextInContentStream(source, 'A', 'A😀');
    expect(result.success).toBe(false);
    expect(result.missingCodePoints).toContain(0x1f600);
  });

  it('rewrites text split across several show operators', () => {
    const source = new TextEncoder().encode('BT /F1 12 Tf (Suppe) Tj (des) Tj (Tages) Tj ET');
    const edited = replaceTextInContentStream(source, 'SuppedesTages', 'Mittagsmenue');
    expect(edited.success).toBe(true);
    expect(new TextDecoder().decode(edited.content)).toContain('(Mittagsmenue) Tj');

    const moved = moveTextInContentStream(source, 'SuppedesTages', 12, -4);
    expect(moved.success).toBe(true);
    const output = new TextDecoder().decode(moved.content);
    expect(output).toContain('1 0 0 1 12 -4 cm\nBT');
    expect(output).toContain('ET\nQ');
  });

  it('converts page-space moves through a scaled and flipped graphics transform', () => {
    const source = new TextEncoder().encode(
      'q 0.5 0 0 -0.5 0 800 cm BT /F1 12 Tf 1 0 0 1 70 300 Tm (Scaled text) Tj ET Q',
    );
    const moved = moveTextInContentStream(source, 'Scaled text', 10, -4);

    expect(moved.success).toBe(true);
    expect(new TextDecoder().decode(moved.content)).toContain('1 0 0 1 20 8 cm\nBT');
  });

  it('preserves TJ letter tracking without inserting space glyphs', () => {
    const source = new TextEncoder().encode(
      'BT /F2 12.96 Tf 1 0 0 1 279.48 757.9 Tm [(S)-148(U)-156(P)-155(P)-155(E)-163(N)] TJ ET',
    );
    const edited = replaceTextInContentStream(source, 'SUPPEN', 'SALATE');

    expect(edited.success).toBe(true);
    const output = new TextDecoder().decode(edited.content);
    expect(output).toContain('[<53> -155 <41> -155 <4C> -155 <41> -155 <54> -155 <45>] TJ');
    expect(output).toContain('/F2 12.96 Tf');
    expect(output).not.toContain('(S A L A T E)');
  });

  it('switches a replacement to an embedded fallback font while preserving size and tracking', () => {
    const source = new TextEncoder().encode(
      'BT /F5 13.92 Tf 1 0 0 1 70 310 Tm [(F)-120(r)-120(i)-120(s)-120(c)-120(h)-120(e)] TJ ET',
    );
    const edited = replaceTextInContentStreamWithFont(
      source,
      'Frische',
      'Frische ABC',
      'PdfEditOnline42',
    );

    expect(edited.success).toBe(true);
    const output = new TextDecoder().decode(edited.content);
    expect(output).toContain('/PdfEditOnline42 13.92 Tf');
    expect(output).toContain('<41>');
    expect(output).toContain('<42>');
    expect(output).toContain('<43>');
    expect(output).not.toContain('/F5 13.92 Tf 1 0 0 1 70 310 Tm [(F)');
  });

  it('joins same-line text objects used for menu superscripts', () => {
    const source = new TextEncoder().encode([
      'q BT /F4 13.92 Tf 1 0 0 1 70 722 Tm [(Frankfurter Kartoffelsuppe )] TJ ET Q',
      'q BT /F4 7.92 Tf 1 0 0 1 207 726 Tm [(2,)-12(5)] TJ ET Q',
      'q BT /F4 13.92 Tf 1 0 0 1 216 722 Tm [( )] TJ ET Q',
    ].join('\n'));

    const edited = replaceTextInContentStream(source, 'Frankfurter Kartoffelsuppe 2,5 ', 'Kartoffelsuppe');
    expect(edited.success).toBe(true);
    expect(new TextDecoder().decode(edited.content)).toContain('(Kartoffelsuppe) Tj');
    expect(new TextDecoder().decode(edited.content)).not.toContain('Frankfurter');

    const moved = moveTextInContentStream(source, 'Frankfurter Kartoffelsuppe 2,5 ', 8, -3);
    expect(moved.success).toBe(true);
    const movedOutput = new TextDecoder().decode(moved.content);
    expect(movedOutput.match(/1 0 0 1 8 -3 cm\nBT/g)).toHaveLength(3);

    const movedAgain = moveTextInContentStream(moved.content, 'Frankfurter Kartoffelsuppe 2,5 ', 4, 2);
    expect(movedAgain.success).toBe(true);
    expect(new TextDecoder().decode(movedAgain.content).match(/1 0 0 1 4 2 cm\nBT/g)).toHaveLength(3);
  });

  it('edits a superscript marker without discarding its font size or TJ positioning', () => {
    const source = new TextEncoder().encode([
      'q BT /F4 13.92 Tf 1 0 0 1 70 722 Tm [(Kartoffelsuppe mit gebratener Wurst )] TJ ET Q',
      'q BT /F4 7.92 Tf 1 0 0 1 207 726 Tm [(2,)-12(5)] TJ ET Q',
    ].join('\n'));

    const edited = replaceTextInContentStream(source, '2,5', '3,6');
    expect(edited.success).toBe(true);
    const output = new TextDecoder().decode(edited.content);
    expect(output).toContain('/F4 7.92 Tf 1 0 0 1 207 726 Tm [(3,)-12(6)] TJ');
    expect(output).not.toContain('(3,6) Tj');
  });

  it('matches word spacing synthesized between different text objects', () => {
    const source = new TextEncoder().encode([
      'q BT /F4 13.92 Tf 1 0 0 1 70 722 Tm [(Kartoffelsuppe mit gebratener Wurst)] TJ ET Q',
      'q BT /F4 7.92 Tf 1 0 0 1 207 726 Tm [(2,5)] TJ ET Q',
    ].join('\n'));

    const moved = moveTextInContentStream(source, 'Kartoffelsuppe mit gebratener Wurst 2,5', 8, -3);
    expect(moved.success).toBe(true);
    expect(new TextDecoder().decode(moved.content).match(/1 0 0 1 8 -3 cm\nBT/g)).toHaveLength(2);
  });

  it('preserves whitespace-only layout objects before a trimmed text block', () => {
    const source = new TextEncoder().encode([
      'q BT /F4 12 Tf 1 0 0 1 70 300 Tm [(Left)] TJ ET Q',
      'q BT /F4 12 Tf 1 0 0 1 100 300 Tm [(   )] TJ ET Q',
      'q BT /F4 12 Tf 1 0 0 1 150 300 Tm [(Right block)] TJ ET Q',
    ].join('\n'));

    const edited = replaceTextInContentStream(source, 'Right block', 'New block');
    expect(edited.success).toBe(true);
    const output = new TextDecoder().decode(edited.content);
    expect(output).toContain('1 0 0 1 100 300 Tm [(   )] TJ');
    expect(output).toContain('1 0 0 1 150 300 Tm [(New block)] TJ');
  });

  it('rewrites Word-style CID text and preserves a missing space glyph as a layout gap', () => {
    const map = new FontEncodingMap();
    [...'Kidonm'].forEach((character, index) => map.add(Uint8Array.of(0, index + 1), character));
    const encodings = new Map([['F4', map]]);
    const source = new TextEncoder().encode([
      'BT /F4 41.333 Tf 1 0 0 -1 223 8 Tm 0 -31 Td <0001> Tj 22 0 Td <0002> Tj 10 0 Td <0003> Tj 22 0 Td <0004> Tj 22 0 Td <0005> Tj ET',
      'BT /F4 41.333 Tf 1 0 0 -1 332 8 Tm 0 -31 Td <0001> Tj 22 0 Td <0002> Tj 10 0 Td <0006> Tj ET',
    ].join('\n'));

    const edited = replaceTextInContentStream(source, 'Kidon Kim', 'Kidon Kin', 0, encodings);

    expect(edited.success).toBe(true);
    const output = new TextDecoder().decode(edited.content);
    expect(output).toContain('[<00010002000300040005> -250 <000100020005>] TJ');
    expect(output).not.toContain('KidonKin');
  });

  it('preserves individually positioned glyph spacing across repeated deletions', () => {
    const map = new FontEncodingMap();
    [...new Set('Lead and manage where we focus on optimizing the supply')].forEach((character, index) => {
      if (character !== ' ') map.add(Uint8Array.of(0, index + 1), character);
    });
    const encodings = new Map([['F4', map]]);
    const encode = (text: string) => [...text].filter((character) => character !== ' ').map((character, index) => {
      const bytes = map.encode(character).bytes;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
      const wordGap = index > 0 && text.replace(/\s/g, '')[index - 1] === 'e' ? 8 : 0;
      return `${11 + wordGap} 0 Td <${hex}> Tj`;
    }).join(' ');
    const original = 'Lead and manage where we focus on optimizing the supply';
    const firstText = 'Lead and manage where we focus on optimizing';
    const source = new TextEncoder().encode(`BT /F4 12 Tf 1 0 0 1 50 700 Tm 0 0 Td ${encode(original)} ET`);

    const first = replaceTextInContentStream(source, original, firstText, 0, encodings);
    expect(first.success).toBe(true);
    const firstOutput = new TextDecoder().decode(first.content);
    expect(firstOutput).toContain('11 0 Td');
    expect(firstOutput).not.toContain('] TJ');

    const secondText = 'Lead and manage optimizing';
    const second = replaceTextInContentStream(first.content, firstText, secondText, 0, encodings);
    expect(second.success).toBe(true);
    const secondOutput = new TextDecoder().decode(second.content);
    expect(secondOutput).toContain('11 0 Td');
    expect(secondOutput).not.toContain('] TJ');
    expect(secondOutput).not.toContain('-250');
  });

  it('moves a suffix into the first deleted glyph slot without changing its internal spacing', () => {
    const source = new TextEncoder().encode(
      'BT /F1 12 Tf 1 0 0 1 50 700 Tm 0 0 Td (A) Tj 9 0 Td (B) Tj 12 0 Td (C) Tj 7 0 Td (D) Tj 10 0 Td (E) Tj 13 0 Td (F) Tj ET',
    );

    const edited = replaceTextInContentStream(source, 'ABCDEF', 'ADEF');
    expect(edited.success).toBe(true);
    const output = new TextDecoder().decode(edited.content);
    expect(output).toMatch(/\(A\) Tj\s+9 0 Td \(D\) Tj 10 0 Td \(E\) Tj 13 0 Td \(F\) Tj/);
    expect(output).not.toContain('(B)');
    expect(output).not.toContain('(C)');
  });

  it('does not reinterpret synthesized word gaps as character tracking', () => {
    const map = new FontEncodingMap();
    [...new Set('Lead and manage')].forEach((character, index) => {
      if (character !== ' ') map.add(Uint8Array.of(0, index + 1), character);
    });
    const encodings = new Map([['F4', map]]);
    const word = (text: string) => {
      const bytes = map.encode(text).bytes;
      return `<${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}>`;
    };
    const source = new TextEncoder().encode(`BT /F4 12 Tf [${word('Lead')} -250 ${word('and')} -250 ${word('manage')}] TJ ET`);

    const edited = replaceTextInContentStream(source, 'Leadandmanage', 'Lead and', 0, encodings);
    expect(edited.success).toBe(true);
    const output = new TextDecoder().decode(edited.content);
    expect(output).toContain(`[${word('Lead')} -250 ${word('and')}] TJ`);
    expect(output.match(/-250/g)).toHaveLength(1);
  });

  it('moves one visible line across separate page content streams', () => {
    const sources = [
      new TextEncoder().encode('q BT /F4 13.92 Tf 1 0 0 1 70 722 Tm [(Kartoffelsuppe mit gebratener Wurst)] TJ ET Q'),
      new TextEncoder().encode('q BT /F4 7.92 Tf 1 0 0 1 207 726 Tm [(2,5)] TJ ET Q'),
      new TextEncoder().encode('q BT /F4 13.92 Tf 1 0 0 1 70 690 Tm [(Andere Suppe)] TJ ET Q'),
    ];

    const moved = moveTextInContentStreams(sources, 'Kartoffelsuppe mit gebratener Wurst 2,5', 8, -3);
    expect(moved.success).toBe(true);
    expect(new TextDecoder().decode(moved.contents[0])).toContain('1 0 0 1 8 -3 cm\nBT');
    expect(new TextDecoder().decode(moved.contents[1])).toContain('1 0 0 1 8 -3 cm\nBT');
    expect(new TextDecoder().decode(moved.contents[2])).not.toContain('1 0 0 1 8 -3 cm\nBT');
  });

  it('moves several selected lines in one content rewrite', () => {
    const source = new TextEncoder().encode([
      'q BT /F4 12 Tf 1 0 0 1 70 722 Tm [(First line)] TJ ET Q',
      'q BT /F4 12 Tf 1 0 0 1 70 700 Tm [(Second line)] TJ ET Q',
      'q BT /F4 12 Tf 1 0 0 1 70 678 Tm [(Third line)] TJ ET Q',
    ].join('\n'));
    const moved = moveTextInContentStreamsBatch([source], [
      { originalText: 'First line' },
      { originalText: 'Second line' },
      { originalText: 'Third line' },
    ], 8, -3);

    expect(moved.success).toBe(true);
    expect(new TextDecoder().decode(moved.contents[0]).match(/1 0 0 1 8 -3 cm\nBT/g)).toHaveLength(3);
  });

  it('moves long lines fragmented into many text-show operators efficiently', () => {
    const lines = [
      'Lead and manage product analytics in the Ad Marketplace team',
      'for ad revenue by increasing and optimizing placements and coverage of ads',
      'auction models, and reducing losses in ad delivery to end users',
      'and delivered preliminary data analytics and AB test iterations for product development',
      'Met or exceeded the goal of 10% increase in ad revenue and ad GMV',
    ];
    const source = new TextEncoder().encode(lines.map((line, lineIndex) => [
      'BT /F1 12 Tf 1 0 0 1 70', `${700 - lineIndex * 20} Tm`,
      ...[...line].map((character) => `(${character === ' ' ? ' ' : character}) Tj`),
      'ET',
    ].join(' ')).join('\n'));
    const moved = moveTextInContentStreamsBatch([source], lines.map((originalText) => ({ originalText })), 8, -3);

    expect(moved.success).toBe(true);
    expect(new TextDecoder().decode(moved.contents[0]).match(/1 0 0 1 8 -3 cm\nBT/g)).toHaveLength(5);
  });
});
