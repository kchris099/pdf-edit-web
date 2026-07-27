import { describe, expect, it } from 'vitest';
import { scanPdfTokens } from '../../src/domain/pdf-tokenizer';

describe('PDF token scanner', () => {
  it('decodes hex and literal strings while preserving byte ranges', () => {
    const source = new TextEncoder().encode('% comment\n[<436c69656e74204e616d65> (ok\\n)] TJ');
    const tokens = scanPdfTokens(source);
    expect(tokens.filter((token) => token.decoded).map((token) => token.decoded)).toEqual(['Client Name', 'ok\n']);
    expect(new TextDecoder().decode(source.slice(tokens[1].start, tokens[1].end))).toBe('<436c69656e74204e616d65>');
  });

  it('handles escaped parentheses and nested literal strings', () => {
    const source = new TextEncoder().encode('(a \\(nested\\) value) Tj');
    expect(scanPdfTokens(source)[0].decoded).toBe('a (nested) value');
  });
});
