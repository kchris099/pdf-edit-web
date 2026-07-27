import type { PdfEngineErrorShape } from '../domain/pdf-models';
import type { WorkerPayload } from './protocol';
import type { WorkerRequest } from './protocol';

const workerScope = self as unknown as { onmessage: unknown; postMessage: (message: unknown, transfer?: Transferable[]) => void };

// MuPDF.js resolves its WASM sibling relative to its generated module. A stable
// public URL keeps this working in Vite dev, preview, and GitHub Pages workers.
(globalThis as typeof globalThis & { $libmupdf_wasm_Module?: { locateFile: (name: string) => string } }).$libmupdf_wasm_Module = {
  locateFile: (name: string) => new URL(`/${name}`, self.location.origin).href,
};

const { MuPdfEngine } = await import('./engine');
const engine = new MuPdfEngine();

function errorShape(value: unknown): PdfEngineErrorShape {
  const candidate = value as { code?: string; message?: string };
  const known = ['NO_DOCUMENT', 'PASSWORD_REQUIRED', 'WRONG_PASSWORD', 'UNSUPPORTED_EDIT', 'TEXT_NOT_FOUND', 'SIGNED_DOCUMENT_WARNING', 'INVALID_PDF', 'ENGINE_ERROR'] as const;
  const code = known.includes(candidate?.code as typeof known[number]) ? candidate.code as typeof known[number] : 'ENGINE_ERROR';
  return { code, message: candidate?.message ?? 'The PDF worker encountered an unexpected error.' };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    let payload: WorkerPayload;
    switch (request.type) {
      case 'open': payload = engine.open(request.bytes, request.password); break;
      case 'pageInfos': payload = engine.pageInfos(); break;
      case 'render': {
        const rendered = engine.render(request.page, request.zoom);
        payload = rendered;
        workerScope.postMessage({ id: request.id, ok: true, payload }, [rendered.png]);
        return;
      }
      case 'inspectText': payload = engine.inspectText(request.page); break;
      case 'search': payload = engine.search(request.query); break;
      case 'editText': payload = await engine.editText(request.request); break;
      case 'moveText': payload = engine.moveText(request.request); break;
      case 'applyContentDelta': engine.applyContentDelta(request.delta, request.useAfter); payload = null; break;
      case 'inspectSignatures': payload = engine.inspectSignatures(request.page); break;
      case 'addSignature': payload = engine.addSignature(request.placement); break;
      case 'moveSignature': payload = engine.moveSignature(request.delta, request.deltaX, request.deltaY, request.allowInvalidateDigitalSignatures); break;
      case 'resizeSignature': payload = engine.resizeSignature(request.delta, request.width, request.height, request.allowInvalidateDigitalSignatures); break;
      case 'removeSignature': engine.removeSignature(request.delta); payload = null; break;
      case 'restoreSignature': payload = engine.restoreSignature(request.delta); break;
      case 'save': {
        const saved = engine.save();
        workerScope.postMessage({ id: request.id, ok: true, payload: saved }, [saved]);
        return;
      }
      case 'close': engine.close(); payload = null; break;
    }
    workerScope.postMessage({ id: request.id, ok: true, payload });
  } catch (value) {
    workerScope.postMessage({ id: request.id, ok: false, error: errorShape(value) });
  }
};
