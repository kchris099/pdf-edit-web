import type { ContentStreamDelta, PdfDocumentInfo, PdfEngineErrorShape, PdfPageInfo, RenderedPage, SearchHit, SignatureDelta, SignaturePlacement, TextEditRequest, TextEditResult, TextMoveRequest, TextMoveResult, TextRun } from '../domain/pdf-models';
import type { WorkerRequest, WorkerRequestBody, WorkerResponse } from './protocol';

export class PdfWorkerError extends Error {
  constructor(public readonly detail: PdfEngineErrorShape) { super(detail.message); this.name = 'PdfWorkerError'; }
}

export class PdfWorkerClient {
  private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data);
    this.worker.onerror = (event: ErrorEvent) => {
      this.rejectPending(new PdfWorkerError({
        code: 'ENGINE_ERROR',
        message: event.message || 'The PDF worker could not start. Check that the MuPDF WASM asset is available.',
      }));
    };
    this.worker.onmessageerror = () => {
      this.rejectPending(new PdfWorkerError({ code: 'ENGINE_ERROR', message: 'The PDF worker could not receive the request.' }));
    };
  }

  private rejectPending(error: PdfWorkerError): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private receive(response: WorkerResponse): void {
    const pending = this.pending.get(response.id); if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.payload); else pending.reject(new PdfWorkerError(response.error));
  }

  private call<T>(request: WorkerRequestBody, transfer: Transferable[] = [], timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new PdfWorkerError({ code: 'ENGINE_ERROR', message: `The PDF worker did not respond within ${timeoutMs / 1000} seconds.` }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.worker.postMessage({ ...request, id } as WorkerRequest, transfer);
    });
  }

  // The first open also waits for the worker's 10 MB MuPDF WASM runtime to
  // initialize. Slower browsers can legitimately take longer than 30 seconds.
  open(bytes: ArrayBuffer, password?: string): Promise<PdfDocumentInfo> { return this.call({ type: 'open', bytes, password }, [bytes], 120_000); }
  pageInfos(): Promise<PdfPageInfo[]> { return this.call({ type: 'pageInfos' }); }
  render(page: number, zoom: number): Promise<RenderedPage> { return this.call({ type: 'render', page, zoom }); }
  inspectText(page: number): Promise<TextRun[]> { return this.call({ type: 'inspectText', page }); }
  search(query: string): Promise<SearchHit[]> { return this.call({ type: 'search', query }); }
  editText(request: TextEditRequest): Promise<TextEditResult> { return this.call({ type: 'editText', request }); }
  moveText(request: TextMoveRequest): Promise<TextMoveResult> { return this.call({ type: 'moveText', request }); }
  applyContentDelta(delta: ContentStreamDelta, useAfter: boolean): Promise<null> { return this.call({ type: 'applyContentDelta', delta, useAfter }); }
  inspectSignatures(page: number): Promise<SignatureDelta[]> { return this.call({ type: 'inspectSignatures', page }); }
  addSignature(placement: SignaturePlacement): Promise<SignatureDelta> { return this.call({ type: 'addSignature', placement }); }
  moveSignature(delta: SignatureDelta, deltaX: number, deltaY: number, allowInvalidateDigitalSignatures = false): Promise<SignatureDelta> { return this.call({ type: 'moveSignature', delta, deltaX, deltaY, allowInvalidateDigitalSignatures }); }
  resizeSignature(delta: SignatureDelta, width: number, height: number, allowInvalidateDigitalSignatures = false): Promise<SignatureDelta> { return this.call({ type: 'resizeSignature', delta, width, height, allowInvalidateDigitalSignatures }); }
  removeSignature(delta: SignatureDelta): Promise<null> { return this.call({ type: 'removeSignature', delta }); }
  restoreSignature(delta: SignatureDelta): Promise<SignatureDelta> { return this.call({ type: 'restoreSignature', delta }); }
  save(): Promise<ArrayBuffer> { return this.call({ type: 'save' }); }
  close(): Promise<null> { return this.call({ type: 'close' }); }
  destroy(): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }
}
