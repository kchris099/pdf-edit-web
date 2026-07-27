import { describe, expect, it } from 'vitest';
import { fitSignatureSize } from '../../src/signature';

describe('fitSignatureSize', () => {
  it('preserves a wide signature aspect ratio', () => {
    expect(fitSignatureSize(
      { width: 400, height: 100 },
      { width: 612, height: 792 },
    )).toEqual({ width: 180, height: 45 });
  });

  it('fits a tall signature inside the maximum placement box', () => {
    expect(fitSignatureSize(
      { width: 100, height: 200 },
      { width: 612, height: 792 },
    )).toEqual({ width: 40, height: 80 });
  });

  it('also fits the signature to a small page', () => {
    expect(fitSignatureSize(
      { width: 400, height: 100 },
      { width: 90, height: 30 },
    )).toEqual({ width: 90, height: 22.5 });
  });
});
