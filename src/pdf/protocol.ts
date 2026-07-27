import type { ContentStreamDelta, PdfDocumentInfo, PdfEngineErrorShape, PdfPageInfo, RenderedPage, SearchHit, SignatureDelta, SignaturePlacement, TextEditRequest, TextEditResult, TextMoveRequest, TextMoveResult, TextRun } from '../domain/pdf-models';

export type WorkerRequest =
  | { id: number; type: 'open'; bytes: ArrayBuffer; password?: string }
  | { id: number; type: 'pageInfos' }
  | { id: number; type: 'render'; page: number; zoom: number }
  | { id: number; type: 'inspectText'; page: number }
  | { id: number; type: 'search'; query: string }
  | { id: number; type: 'editText'; request: TextEditRequest }
  | { id: number; type: 'moveText'; request: TextMoveRequest }
  | { id: number; type: 'applyContentDelta'; delta: ContentStreamDelta; useAfter: boolean }
  | { id: number; type: 'inspectSignatures'; page: number }
  | { id: number; type: 'addSignature'; placement: SignaturePlacement }
  | { id: number; type: 'moveSignature'; delta: SignatureDelta; deltaX: number; deltaY: number; allowInvalidateDigitalSignatures?: boolean }
  | { id: number; type: 'resizeSignature'; delta: SignatureDelta; width: number; height: number; allowInvalidateDigitalSignatures?: boolean }
  | { id: number; type: 'removeSignature'; delta: SignatureDelta }
  | { id: number; type: 'restoreSignature'; delta: SignatureDelta }
  | { id: number; type: 'save' }
  | { id: number; type: 'close' };

export type WorkerRequestBody = { [K in WorkerRequest['type']]: Omit<Extract<WorkerRequest, { type: K }>, 'id'> }[WorkerRequest['type']];

export type WorkerPayload = PdfDocumentInfo | PdfPageInfo[] | RenderedPage | TextRun[] | SearchHit[] | TextEditResult | TextMoveResult | SignatureDelta[] | SignatureDelta | ArrayBuffer | null;

export type WorkerResponse =
  | { id: number; ok: true; payload: WorkerPayload }
  | { id: number; ok: false; error: PdfEngineErrorShape };
