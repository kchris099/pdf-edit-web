export interface PdfPageInfo {
  page: number;
  width: number;
  height: number;
  rotation: number;
}

export interface PdfDocumentInfo {
  pageCount: number;
  encrypted: boolean;
  needsPassword: boolean;
  hasDigitalSignatures: boolean;
  title?: string;
}

export interface SearchHit {
  page: number;
  quads: number[][];
  text: string;
}

export interface TextRun {
  id: string;
  page: number;
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  font: string;
  editable: boolean;
  occurrenceIndex: number;
  contentStringIndex: number;
  unsupportedReason?: string;
}

export interface RenderedPage {
  page: number;
  width: number;
  height: number;
  png: ArrayBuffer;
}

export type PdfErrorCode =
  | 'NO_DOCUMENT'
  | 'PASSWORD_REQUIRED'
  | 'WRONG_PASSWORD'
  | 'UNSUPPORTED_EDIT'
  | 'TEXT_NOT_FOUND'
  | 'SIGNED_DOCUMENT_WARNING'
  | 'INVALID_PDF'
  | 'ENGINE_ERROR';

export interface PdfEngineErrorShape {
  code: PdfErrorCode;
  message: string;
}

export interface TextEditRequest {
  page: number;
  originalText: string;
  replacementText: string;
  occurrenceIndex?: number;
  allowInvalidateDigitalSignatures?: boolean;
}

export interface TextEditResult {
  changed: boolean;
  message: string;
  page: number;
  originalText: string;
  replacementText: string;
  changedStreamObjects: number[];
  missingCodePoints: number[];
  delta?: ContentStreamDelta;
  overflows?: boolean;
}

export interface ContentStreamDelta {
  page: number;
  streamObject: number;
  before: Uint8Array;
  after: Uint8Array;
}

export interface TextMoveRequest {
  page: number;
  originalText: string;
  occurrenceIndex?: number;
  deltaX: number;
  deltaY: number;
  allowInvalidateDigitalSignatures?: boolean;
}

export interface TextMoveOperation {
  originalText: string;
  occurrenceIndex?: number;
}

export interface TextMovesRequest {
  page: number;
  moves: TextMoveOperation[];
  deltaX: number;
  deltaY: number;
  allowInvalidateDigitalSignatures?: boolean;
}

export interface TextMoveResult {
  changed: boolean;
  message: string;
  page: number;
  delta?: ContentStreamDelta;
  deltas?: ContentStreamDelta[];
}

export interface SignaturePoint { x: number; y: number }
export interface SignatureStroke { points: SignaturePoint[] }
export interface SignatureInk { strokes: SignatureStroke[] }
export interface SignaturePlacement {
  page: number;
  bounds: { x: number; y: number; width: number; height: number };
  ink: SignatureInk;
  lineWidth?: number;
  opacity?: number;
  allowInvalidateDigitalSignatures?: boolean;
}
export interface SignatureDelta {
  page: number;
  annotationObject: number;
  placement: SignaturePlacement;
}
