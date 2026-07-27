export interface SignatureSize {
  width: number;
  height: number;
}

export function fitSignatureSize(
  source: SignatureSize,
  available: SignatureSize,
  maximum: SignatureSize = { width: 180, height: 80 },
): SignatureSize {
  const sourceWidth = Math.max(1, source.width);
  const sourceHeight = Math.max(1, source.height);
  const scale = Math.min(
    maximum.width / sourceWidth,
    maximum.height / sourceHeight,
    available.width / sourceWidth,
    available.height / sourceHeight,
  );
  return {
    width: sourceWidth * Math.max(0, scale),
    height: sourceHeight * Math.max(0, scale),
  };
}
