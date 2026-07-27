import * as mupdf from 'mupdf';
import { moveTextInContentStreams, replaceTextInContentStream, replaceTextInContentStreamWithFont } from './content-stream/rewriter';
import { resolveOnlineFont } from './online-font-resolver';
import { groupStructuredTextLine, type StructuredTextChar, type StructuredTextRun } from './text-runs';
import { buildFontEncodingMaps } from './font-encoding';
import type {
  ContentStreamDelta, PdfDocumentInfo, PdfPageInfo, RenderedPage, SearchHit, SignatureDelta,
  SignaturePlacement, TextEditRequest, TextEditResult, TextMoveRequest, TextMoveResult, TextRun,
} from '../domain/pdf-models';

type PdfDocument = mupdf.PDFDocument;
const RENDER_RESOLUTION_SCALE = 2;

function copyBytes(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes.slice(0);
  return new Uint8Array(bytes).slice().buffer;
}

function error(code: string, message: string): Error & { code: string } {
  const value = new Error(message) as Error & { code: string };
  value.code = code;
  return value;
}

function hasSignatureField(bytes: ArrayBuffer): boolean {
  // ByteRange is the portable marker used by PDF signature dictionaries. This
  // is intentionally conservative: a positive result warns before mutation;
  // a false negative only means MuPDF can still reject the mutation itself.
  return /\/ByteRange\b/.test(new TextDecoder('latin1').decode(new Uint8Array(bytes)));
}

function streamObjects(page: mupdf.PDFPage): mupdf.PDFObject[] {
  const contents = page.getObject().getInheritable('Contents');
  if (contents.isArray()) return Array.from({ length: contents.length }, (_, index) => contents.get(index));
  return contents.isNull() ? [] : [contents];
}

function streamId(stream: mupdf.PDFObject): number {
  return stream.isIndirect() ? stream.asIndirect() : 0;
}

function fontDictionary(page: mupdf.PDFPage): mupdf.PDFObject {
  const resources = page.getObject().getInheritable('Resources');
  if (!resources.isDictionary()) throw error('UNSUPPORTED_EDIT', 'The page has no editable font resources.');
  let fonts = resources.get('Font');
  if (!fonts.isDictionary()) {
    fonts = resources._doc.newDictionary();
    resources.put('Font', fonts);
  }
  return fonts;
}

function embeddedFontBytes(font: mupdf.PDFObject): Uint8Array | null {
  const descriptor = font.get('FontDescriptor');
  if (!descriptor.isDictionary()) return null;
  for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
    const stream = descriptor.get(key);
    if (stream.isStream()) return new Uint8Array(stream.readStream().asUint8Array());
  }
  return null;
}

function missingGlyphs(font: mupdf.PDFObject, text: string): number[] | null {
  const bytes = embeddedFontBytes(font);
  if (!bytes) return null;
  try {
    const parsed = new mupdf.Font('Embedded PDF font', bytes);
    try {
      return [...text]
        .filter((character) => !/\s/.test(character) && parsed.encodeCharacter(character.codePointAt(0) ?? 0) === 0)
        .map((character) => character.codePointAt(0) ?? 0)
        .filter((codePoint, index, values) => values.indexOf(codePoint) === index);
    } finally {
      parsed.destroy();
    }
  } catch {
    return null;
  }
}

export class MuPdfEngine {
  private document: PdfDocument | null = null;
  private signed = false;
  private readonly renderCache = new Map<string, RenderedPage>();

  private invalidateRenderCache(): void { this.renderCache.clear(); }

  private cacheKey(pageNumber: number, zoom: number): string {
    return `${pageNumber}:${zoom.toPrecision(12)}`;
  }

  private rememberRender(key: string, rendered: RenderedPage): void {
    this.renderCache.delete(key);
    this.renderCache.set(key, rendered);
    while (this.renderCache.size > 4) {
      const oldest = this.renderCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.renderCache.delete(oldest);
    }
  }

  open(bytes: ArrayBuffer, password?: string): PdfDocumentInfo {
    this.close();
    let document: mupdf.Document;
    try { document = mupdf.Document.openDocument(bytes, 'application/pdf'); }
    catch { throw error('INVALID_PDF', 'This file could not be opened as a PDF.'); }
    if (document.needsPassword()) {
      if (!password) { document.destroy(); throw error('PASSWORD_REQUIRED', 'This PDF requires a password. The password is kept only in memory.'); }
      if (!document.authenticatePassword(password)) { document.destroy(); throw error('WRONG_PASSWORD', 'The password was not accepted.'); }
    }
    const pdf = document.asPDF();
    if (!pdf) { document.destroy(); throw error('INVALID_PDF', 'MuPDF opened the file, but it is not an editable PDF document.'); }
    pdf.disableJS();
    this.document = pdf;
    this.signed = hasSignatureField(bytes);
    return {
      pageCount: pdf.countPages(),
      encrypted: Boolean(password),
      needsPassword: false,
      hasDigitalSignatures: this.signed,
      title: pdf.getMetaData(mupdf.Document.META_INFO_TITLE) || undefined,
    };
  }

  close(): void {
    if (this.document) { this.document.destroy(); this.document = null; }
    this.signed = false;
    this.invalidateRenderCache();
  }
  private get pdf(): PdfDocument { if (!this.document) throw error('NO_DOCUMENT', 'Open a PDF before using the editor.'); return this.document; }
  private checkMutation(allow?: boolean): void {
    if (this.signed && !allow) throw error('SIGNED_DOCUMENT_WARNING', 'Editing this signed PDF will invalidate its existing digital signature. Confirm to continue.');
  }

  pageInfos(): PdfPageInfo[] {
    return Array.from({ length: this.pdf.countPages() }, (_, pageNumber) => {
      const page = this.pdf.loadPage(pageNumber);
      const bounds = page.getBounds();
      const rotation = ((page.getObject().getInheritable('Rotate').isNumber() ? page.getObject().getInheritable('Rotate').asNumber() : 0) + 360) % 360;
      return { page: pageNumber, width: bounds[2] - bounds[0], height: bounds[3] - bounds[1], rotation };
    });
  }

  render(pageNumber: number, zoom: number): RenderedPage {
    const key = this.cacheKey(pageNumber, zoom);
    const cached = this.renderCache.get(key);
    if (cached) {
      this.renderCache.delete(key);
      this.renderCache.set(key, cached);
      return { ...cached, png: copyBytes(cached.png) };
    }
    const page = this.pdf.loadPage(pageNumber);
    const bounds = page.getBounds();
    const renderScale = zoom * RENDER_RESOLUTION_SCALE;
    const matrix = mupdf.Matrix.scale(renderScale, renderScale);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    const png = pixmap.asPNG();
    const rendered: RenderedPage = {
      page: pageNumber,
      width: Math.ceil((bounds[2] - bounds[0]) * renderScale),
      height: Math.ceil((bounds[3] - bounds[1]) * renderScale),
      png: copyBytes(png),
    };
    this.rememberRender(key, rendered);
    return { ...rendered, png: copyBytes(rendered.png) };
  }

  inspectText(pageNumber: number): TextRun[] {
    const page = this.pdf.loadPage(pageNumber);
    // Keep MuPDF's geometry-derived word gaps. Word-style PDFs frequently
    // contain no space glyphs at all and position every word with Td.
    // groupStructuredTextLine filters the all-caps tracking false positive.
    const structuredText = page.toStructuredText();
    const extracted: StructuredTextRun[] = [];
    let chars: StructuredTextChar[] = [];
    let direction: mupdf.Point = [1, 0];
    structuredText.walk({
      beginLine(_bounds, _writingMode, lineDirection) {
        chars = [];
        direction = lineDirection;
      },
      onChar(text, origin, font, size, quad, color, bidi) {
        chars.push({ text, origin, font: font.getName(), size, quad, color, bidi });
      },
      endLine() {
        extracted.push(...groupStructuredTextLine(chars, direction));
      },
    });
    return extracted.filter((run) => run.text).map((run, occurrenceIndex) => ({
      id: `${pageNumber}:${occurrenceIndex}`,
      page: pageNumber,
      text: run.text,
      bounds: run.bounds,
      font: run.font || 'unknown',
      editable: true,
      occurrenceIndex,
      contentStringIndex: 0,
    }));
  }

  search(query: string): SearchHit[] {
    const hits: SearchHit[] = [];
    for (let page = 0; page < this.pdf.countPages(); page += 1) {
      for (const quads of this.pdf.loadPage(page).search(query)) hits.push({ page, quads: quads.map((quad) => [...quad]), text: query });
    }
    return hits;
  }

  async editText(request: TextEditRequest): Promise<TextEditResult> {
    this.checkMutation(request.allowInvalidateDigitalSignatures);
    const page = this.pdf.loadPage(request.page);
    const encodings = buildFontEncodingMaps(page);
    let occurrence = Math.max(0, request.occurrenceIndex ?? 0);
    for (const stream of streamObjects(page)) {
      if (!stream.isStream()) continue;
      const before = new Uint8Array(stream.readStream().asUint8Array());
      let result = replaceTextInContentStream(before, request.originalText, request.replacementText, occurrence, encodings);
      if (!result.success) {
        if (result.missingCodePoints.length && result.fontResource) {
          // Continue into the verified embedded-fallback path below. The
          // original CID subset may render a glyph but lack a code for it.
        } else {
        // The occurrence index belongs to the page, not to an individual
        // content stream. Keep looking without selecting the first duplicate
        // again in every stream.
          occurrence = Math.max(0, occurrence - (result.matchCount ?? 0));
          continue;
        }
      }
      const fonts = fontDictionary(page);
      const originalFont = result.fontResource ? fonts.get(result.fontResource) : mupdf.PDFObject.Null;
      const missing = result.success
        ? (originalFont.isDictionary() ? missingGlyphs(originalFont, request.replacementText) : null)
        : result.missingCodePoints;
      if (missing?.length) {
        const baseFontName = originalFont.get('BaseFont').isName()
          ? originalFont.get('BaseFont').asName()
          : result.fontResource ?? '';
        let online;
        try {
          online = await resolveOnlineFont(baseFontName, request.replacementText);
        } catch {
          throw error(
            'UNSUPPORTED_EDIT',
            `The embedded font is missing ${missing.map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')}, and its online fallback could not be downloaded.`,
          );
        }
        if (!online) {
          throw error(
            'UNSUPPORTED_EDIT',
            `The embedded font is missing ${missing.map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')}, and no matching online font is available.`,
          );
        }

        const resourceName = `PdfEditOnline${this.pdf.countObjects()}`;
        const fallbackFont = new mupdf.Font(online.family, online.bytes);
        let fallbackRef: mupdf.PDFObject;
        try {
          fallbackRef = this.pdf.addSimpleFont(fallbackFont, mupdf.Font.SIMPLE_ENCODING_LATIN);
        } finally {
          fallbackFont.destroy();
        }
        fonts.put(resourceName, fallbackRef);
        result = replaceTextInContentStreamWithFont(
          before,
          request.originalText,
          request.replacementText,
          resourceName,
          occurrence,
          encodings,
        );
        if (!result.success) throw error('UNSUPPORTED_EDIT', result.message);
        result.message = `Replaced ${request.originalText} with ${online.family}, downloaded from Google Fonts and embedded in the PDF.`;
      }
      stream.writeStream(result.content); page.update();
      this.invalidateRenderCache();
      const delta: ContentStreamDelta = { page: request.page, streamObject: streamId(stream), before, after: result.content };
      return { changed: true, message: result.message, page: request.page, originalText: request.originalText, replacementText: request.replacementText, changedStreamObjects: streamId(stream) ? [streamId(stream)] : [], missingCodePoints: result.missingCodePoints, delta };
    }
    throw error('TEXT_NOT_FOUND', `Could not safely locate “${request.originalText}” in the original page content stream.`);
  }

  moveText(request: TextMoveRequest): TextMoveResult {
    this.checkMutation(request.allowInvalidateDigitalSignatures);
    const page = this.pdf.loadPage(request.page);
    const encodings = buildFontEncodingMaps(page);
    const streams = streamObjects(page).filter((stream) => stream.isStream());
    const before = streams.map((stream) => new Uint8Array(stream.readStream().asUint8Array()));
    const result = moveTextInContentStreams(before, request.originalText, request.deltaX, request.deltaY, Math.max(0, request.occurrenceIndex ?? 0), encodings);
    if (!result.success) throw error('TEXT_NOT_FOUND', 'The selected text cluster could not be located in the page content streams.');

    const deltas: ContentStreamDelta[] = [];
    streams.forEach((stream, index) => {
      if (result.contents[index] === before[index]) return;
      stream.writeStream(result.contents[index]);
      deltas.push({ page: request.page, streamObject: streamId(stream), before: before[index], after: result.contents[index] });
    });
    if (!deltas.length) throw error('TEXT_NOT_FOUND', 'The selected text cluster has no movable text object.');
    page.update();
    this.invalidateRenderCache();
    return { changed: true, page: request.page, message: result.message, delta: deltas[0], deltas };
  }

  applyContentDelta(delta: ContentStreamDelta, useAfter: boolean): void {
    const page = this.pdf.loadPage(delta.page);
    const target = streamObjects(page).find((stream) => stream.isStream() && streamId(stream) === delta.streamObject);
    if (!target) throw error('ENGINE_ERROR', 'The edited content stream no longer exists.');
    target.writeStream(useAfter ? delta.after : delta.before); page.update();
    this.invalidateRenderCache();
  }

  inspectSignatures(pageNumber: number): SignatureDelta[] {
    const page = this.pdf.loadPage(pageNumber);
    return page.getAnnotations().filter((annot) => annot.getType() === 'Ink').flatMap((annot) => {
      const rect = annot.getBounds();
      const inkList = annot.hasInkList() ? annot.getInkList() : [];
      const placement: SignaturePlacement = {
        page: pageNumber,
        bounds: { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] },
        // MuPDF exposes ink vertices in page coordinates. SignaturePlacement
        // stores them relative to its bounds so restoring or moving an
        // inspected annotation does not apply the page offset a second time.
        ink: { strokes: inkList.map((stroke) => ({ points: stroke.map((point) => ({ x: point[0] - rect[0], y: point[1] - rect[1] })) })) },
        lineWidth: annot.getBorderWidth(), opacity: annot.getOpacity(),
      };
      return [{ page: pageNumber, annotationObject: annot.getObject().asIndirect(), placement }];
    });
  }

  addSignature(placement: SignaturePlacement): SignatureDelta {
    this.checkMutation(placement.allowInvalidateDigitalSignatures);
    const page = this.pdf.loadPage(placement.page);
    const annot = page.createAnnotation('Ink');
    const b = placement.bounds;
    // Ink annotations derive their bounds from their stroke vertices. MuPDF
    // deliberately does not expose a Rect setter for this annotation type.
    annot.setInkList(placement.ink.strokes.map((stroke) => stroke.points.map((point) => [point.x + b.x, point.y + b.y] as [number, number])));
    annot.setColor([0, 0, 0]);
    annot.setBorderWidth(placement.lineWidth ?? 1.6);
    annot.setOpacity(placement.opacity ?? 1);
    annot.update(); page.update();
    this.invalidateRenderCache();
    return { page: placement.page, annotationObject: annot.getObject().asIndirect(), placement };
  }

  removeSignature(delta: SignatureDelta): void {
    this.checkMutation(delta.placement.allowInvalidateDigitalSignatures);
    const page = this.pdf.loadPage(delta.page);
    const annotation = page.getAnnotations().find((annot) => annot.getObject().asIndirect() === delta.annotationObject);
    if (!annotation) throw error('ENGINE_ERROR', 'The signature annotation no longer exists.');
    page.deleteAnnotation(annotation); page.update();
    this.invalidateRenderCache();
  }

  moveSignature(delta: SignatureDelta, deltaX: number, deltaY: number, allowInvalidateDigitalSignatures = false): SignatureDelta {
    this.checkMutation(allowInvalidateDigitalSignatures);
    this.removeSignature({ ...delta, placement: { ...delta.placement, allowInvalidateDigitalSignatures: true } });
    const placement = { ...delta.placement, bounds: { ...delta.placement.bounds, x: delta.placement.bounds.x + deltaX, y: delta.placement.bounds.y + deltaY }, allowInvalidateDigitalSignatures };
    return this.addSignature(placement);
  }

  resizeSignature(delta: SignatureDelta, width: number, height: number, allowInvalidateDigitalSignatures = false): SignatureDelta {
    this.checkMutation(allowInvalidateDigitalSignatures);
    const oldBounds = delta.placement.bounds;
    if (oldBounds.width <= 0 || oldBounds.height <= 0 || width <= 0 || height <= 0) {
      throw error('ENGINE_ERROR', 'The signature cannot be resized to empty bounds.');
    }
    const scaleX = width / oldBounds.width;
    const scaleY = height / oldBounds.height;
    this.removeSignature({ ...delta, placement: { ...delta.placement, allowInvalidateDigitalSignatures: true } });
    return this.addSignature({
      ...delta.placement,
      bounds: { ...oldBounds, width, height },
      ink: {
        strokes: delta.placement.ink.strokes.map((stroke) => ({
          points: stroke.points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })),
        })),
      },
      lineWidth: (delta.placement.lineWidth ?? 1.6) * Math.min(scaleX, scaleY),
      allowInvalidateDigitalSignatures,
    });
  }

  restoreSignature(delta: SignatureDelta): SignatureDelta { return this.addSignature(delta.placement); }
  save(): ArrayBuffer { return copyBytes(this.pdf.saveToBuffer({ garbage: 4, compress: true }).asUint8Array()); }
}
