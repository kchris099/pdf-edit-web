import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { PageSurface, type MoveTarget, type ToolMode } from './components/PageSurface';
import { PdfWorkerClient, PdfWorkerError } from './pdf/client';
import type {
  ContentStreamDelta, PdfDocumentInfo, PdfPageInfo, SearchHit, SignatureDelta,
  SignatureStroke, TextRun,
} from './domain/pdf-models';
import { fitSignatureSize } from './signature';
import './styles.css';

const ZOOM_RENDER_DEBOUNCE_MS = 60;
// The previous implementation persisted its light fallback as a preference.
// Use a new key so those legacy values do not override the browser theme.
const THEME_STORAGE_KEY = 'pdf-edit-theme-preference';

type Theme = 'light' | 'dark';

function preferredTheme(): Theme {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

type HistoryAction =
  | { kind: 'content'; delta: ContentStreamDelta }
  | { kind: 'signature-add'; delta: SignatureDelta }
  | { kind: 'signature-remove'; delta: SignatureDelta }
  | { kind: 'signature-move'; before: SignatureDelta; after: SignatureDelta };
type HistoryEntry = { id: number; description: string; actions: HistoryAction[] };
type PendingSignature = {
  strokes: SignatureStroke[];
  sourceWidth: number;
  sourceHeight: number;
};

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function download(bytes: ArrayBuffer, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStem(name: string): string { return name.replace(/\.pdf$/i, '') || 'document'; }

function occurrenceForRun(runs: TextRun[], target: TextRun): number {
  let occurrence = 0;
  for (const run of runs) {
    if (run.id === target.id) return occurrence;
    if (run.text === target.text) occurrence += 1;
  }
  return 0;
}

export default function App() {
  const clientRef = useRef<PdfWorkerClient | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRequestRef = useRef(0);
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const renderSequence = useRef(0);
  const zoomRenderTimer = useRef<number | null>(null);
  const thumbnailsRef = useRef<Record<number, string>>({});
  const thumbnailRequestsRef = useRef(new Set<number>());
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const nextHistoryId = useRef(1);
  const savedHistoryKey = useRef('');

  const [fileName, setFileName] = useState('');
  const [sourceHash, setSourceHash] = useState('');
  const [info, setInfo] = useState<PdfDocumentInfo | null>(null);
  const [pageInfos, setPageInfos] = useState<PdfPageInfo[]>([]);
  const [page, setPage] = useState(0);
  const [pageInput, setPageInput] = useState('');
  const [zoom, setZoom] = useState(1);
  const [imageUrl, setImageUrl] = useState('');
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [textRuns, setTextRuns] = useState<TextRun[]>([]);
  const [signatures, setSignatures] = useState<SignatureDelta[]>([]);
  const [tool, setTool] = useState<ToolMode>('select');

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeHit, setActiveHit] = useState(-1);

  const [showSignature, setShowSignature] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [strokes, setStrokes] = useState<SignatureStroke[]>([]);
  const [pendingSignature, setPendingSignature] = useState<PendingSignature | null>(null);
  const [dirty, setDirty] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [, setStatus] = useState('');
  const [theme, setTheme] = useState<Theme>(preferredTheme);

  const hasDocument = Boolean(info);
  const canUndo = undoStack.current.length > 0 && !busy;
  const canRedo = redoStack.current.length > 0 && !busy;

  const showError = useCallback((value: unknown) => {
    if (value instanceof PdfWorkerError) setStatus(`${value.detail.code}: ${value.message}`);
    else setStatus(value instanceof Error ? value.message : 'The PDF worker stopped unexpectedly.');
  }, []);

  const replaceImageUrl = useCallback((next: string) => {
    setImageUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return next;
    });
  }, []);

  const cancelScheduledZoomRender = useCallback(() => {
    if (zoomRenderTimer.current !== null) {
      window.clearTimeout(zoomRenderTimer.current);
      zoomRenderTimer.current = null;
    }
  }, []);

  const renderPage = useCallback(async (nextPage: number, nextZoom: number) => {
    cancelScheduledZoomRender();
    const client = clientRef.current;
    if (!client) return;
    const sequence = ++renderSequence.current;
    const rendered = await client.render(nextPage, nextZoom);
    const nextUrl = URL.createObjectURL(new Blob([rendered.png], { type: 'image/png' }));
    if (sequence !== renderSequence.current) { URL.revokeObjectURL(nextUrl); return; }
    replaceImageUrl(nextUrl);
  }, [cancelScheduledZoomRender, replaceImageUrl]);

  const loadThumbnail = useCallback(async (pageNumber: number) => {
    const client = clientRef.current;
    if (!client || thumbnailsRef.current[pageNumber] || thumbnailRequestsRef.current.has(pageNumber)) return;
    thumbnailRequestsRef.current.add(pageNumber);
    try {
      const rendered = await client.render(pageNumber, 0.2);
      const url = URL.createObjectURL(new Blob([rendered.png], { type: 'image/png' }));
      setThumbnails((current) => {
        if (current[pageNumber]) { URL.revokeObjectURL(url); return current; }
        thumbnailsRef.current = { ...current, [pageNumber]: url };
        return { ...current, [pageNumber]: url };
      });
    } catch { /* the full page render reports actionable failures */ }
    finally { thumbnailRequestsRef.current.delete(pageNumber); }
  }, []);

  const refreshPage = useCallback(async (nextPage = page, nextZoom = zoom) => {
    const client = clientRef.current;
    if (!client) return;
    setPage(nextPage);
    const [runs, pageSignatures] = await Promise.all([client.inspectText(nextPage), client.inspectSignatures(nextPage)]);
    setTextRuns(runs);
    setSignatures(pageSignatures);
    await renderPage(nextPage, nextZoom);
    void loadThumbnail(nextPage);
  }, [loadThumbnail, page, renderPage, zoom]);

  const jumpToPage = useCallback(() => {
    const requestedPage = Number(pageInput);
    if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > pageInfos.length) {
      setPageInput(hasDocument ? String(page + 1) : '');
      setStatus(pageInfos.length ? `Enter a page number from 1 to ${pageInfos.length}.` : 'Open a PDF before jumping to a page.');
      return;
    }
    const nextPage = requestedPage - 1;
    setPageInput(String(requestedPage));
    if (nextPage !== page) void refreshPage(nextPage);
  }, [hasDocument, page, pageInfos.length, pageInput, refreshPage]);

  const historyKey = useCallback(() => undoStack.current.map((entry) => entry.id).join(','), []);
  const syncDirty = useCallback(() => setDirty(historyKey() !== savedHistoryKey.current), [historyKey]);

  const record = useCallback((entry: Omit<HistoryEntry, 'id'>) => {
    undoStack.current.push({ ...entry, id: nextHistoryId.current++ });
    redoStack.current = [];
    setHistoryVersion((value) => value + 1);
    syncDirty();
  }, [syncDirty]);

  const mutationPermission = useCallback((): boolean | null => {
    if (!info?.hasDigitalSignatures) return false;
    return window.confirm('Editing this signed PDF will invalidate its existing digital signature. Continue?') ? true : null;
  }, [info?.hasDigitalSignatures]);

  const openBytes = useCallback(async (bytes: ArrayBuffer, name: string, password?: string) => {
    setBusy(true);
    setStatus('Preparing the local PDF engine…');
    const original = bytes.slice(0);
    try {
      const client = clientRef.current ?? new PdfWorkerClient();
      clientRef.current = client;
      const [hash, opened] = await Promise.all([sha256(original), client.open(original.slice(0), password)]);
      const infos = await client.pageInfos();
      undoStack.current = [];
      redoStack.current = [];
      nextHistoryId.current = 1;
      savedHistoryKey.current = '';
      setHistoryVersion((value) => value + 1);
      setDirty(false);
      setInfo(opened);
      setFileName(name);
      setSourceHash(hash);
      setPageInfos(infos);
      zoomRef.current = 1;
      setZoom(1);
      setHits([]);
      setActiveHit(-1);
      setTool('select');
      setPendingSignature(null);
      setThumbnails((current) => {
        Object.values(current).forEach(URL.revokeObjectURL);
        thumbnailsRef.current = {};
        return {};
      });
      await refreshPage(0, 1);
      setStatus(`Opened ${opened.pageCount} page${opened.pageCount === 1 ? '' : 's'}.${opened.hasDigitalSignatures ? ' Signed document warning enabled.' : ''}`);
    } catch (value) {
      if (value instanceof PdfWorkerError && value.detail.code === 'PASSWORD_REQUIRED' && !password) {
        const entered = window.prompt('This PDF is password protected. Enter its password:');
        if (entered !== null) { await openBytes(original, name, entered); return; }
      }
      showError(value);
    } finally { setBusy(false); }
  }, [refreshPage, showError]);

  const openFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setStatus('Choose a PDF file.');
      return;
    }
    void file.arrayBuffer().then((bytes) => openBytes(bytes, file.name));
  }, [openBytes]);

  const editRun = useCallback(async (run: TextRun, replacement: string) => {
    const client = clientRef.current;
    if (!client || replacement === run.text) return;
    const allow = mutationPermission();
    if (allow === null) return;
    setBusy(true);
    try {
      const result = await client.editText({
        page,
        originalText: run.text,
        replacementText: replacement,
        occurrenceIndex: occurrenceForRun(textRuns, run),
        allowInvalidateDigitalSignatures: allow,
      });
      if (result.changed && result.delta) {
        record({ description: 'Edit text', actions: [{ kind: 'content', delta: result.delta }] });
        await refreshPage();
        setStatus(result.message);
      }
    } catch (value) { showError(value); }
    finally { setBusy(false); }
  }, [mutationPermission, page, record, refreshPage, showError, textRuns]);

  const moveTargets = useCallback(async (targets: MoveTarget[], deltaX: number, deltaY: number) => {
    const client = clientRef.current;
    if (!client || (!deltaX && !deltaY)) return;
    const allow = mutationPermission();
    if (allow === null) return;
    setBusy(true);
    const actions: HistoryAction[] = [];
    try {
      for (const target of targets) {
        if (target.kind === 'text') {
          const result = await client.moveText({
            page,
            originalText: target.run.text,
            occurrenceIndex: occurrenceForRun(textRuns, target.run),
            deltaX,
            deltaY: -deltaY,
            allowInvalidateDigitalSignatures: allow,
          });
          for (const delta of result.deltas ?? (result.delta ? [result.delta] : [])) actions.push({ kind: 'content', delta });
        } else {
          const before = { ...target.signature, placement: { ...target.signature.placement, allowInvalidateDigitalSignatures: allow } };
          const after = await client.moveSignature(before, deltaX, deltaY, allow);
          actions.push({ kind: 'signature-move', before, after });
        }
      }
      if (actions.length) {
        record({ description: targets.length > 1 ? `Move ${targets.length} items` : 'Move item', actions });
        await refreshPage();
        setStatus(`Moved ${targets.length} item${targets.length === 1 ? '' : 's'} ${Math.abs(deltaX).toFixed(1)} pt horizontally and ${Math.abs(deltaY).toFixed(1)} pt vertically.`);
      }
    } catch (value) {
      for (const action of [...actions].reverse()) {
        try {
          if (action.kind === 'content') await client.applyContentDelta(action.delta, false);
          else if (action.kind === 'signature-move') {
            await client.removeSignature(action.after);
            action.before = await client.restoreSignature(action.before);
          }
        } catch { /* preserve the original actionable error */ }
      }
      showError(value);
      await refreshPage();
    } finally { setBusy(false); }
  }, [mutationPermission, page, record, refreshPage, showError, textRuns]);

  const resizeSignature = useCallback(async (signature: SignatureDelta, width: number, height: number) => {
    const client = clientRef.current;
    if (!client) return;
    const allow = mutationPermission();
    if (allow === null) return;
    const before = { ...signature, placement: { ...signature.placement, allowInvalidateDigitalSignatures: allow } };
    setBusy(true);
    try {
      const after = await client.resizeSignature(before, width, height, allow);
      record({ description: 'Resize signature', actions: [{ kind: 'signature-move', before, after }] });
      await refreshPage();
      setStatus(`Resized signature to ${width.toFixed(1)} × ${height.toFixed(1)} pt.`);
    } catch (value) {
      showError(value);
      await refreshPage();
    } finally { setBusy(false); }
  }, [mutationPermission, record, refreshPage, showError]);

  const addSignatureAt = useCallback(async (x: number, y: number) => {
    const client = clientRef.current;
    const pending = pendingSignature;
    const pageInfo = pageInfos[page];
    if (!client || !pending || !pageInfo) return;
    const allow = mutationPermission();
    if (allow === null) return;
    const { width, height } = fitSignatureSize(
      { width: pending.sourceWidth, height: pending.sourceHeight },
      { width: pageInfo.width, height: pageInfo.height },
    );
    const bounds = {
      x: Math.max(0, Math.min(pageInfo.width - width, x - width / 2)),
      y: Math.max(0, Math.min(pageInfo.height - height, y - height / 2)),
      width,
      height,
    };
    setBusy(true);
    try {
      const delta = await client.addSignature({
        page,
        bounds,
        ink: { strokes: pending.strokes.map((stroke) => ({ points: stroke.points.map((point) => ({ x: point.x * width, y: point.y * height })) })) },
        allowInvalidateDigitalSignatures: allow,
      });
      record({ description: 'Add signature', actions: [{ kind: 'signature-add', delta }] });
      setPendingSignature(null);
      setTool('select');
      await refreshPage();
      setStatus('Signature added as a vector ink annotation.');
    } catch (value) { showError(value); }
    finally { setBusy(false); }
  }, [mutationPermission, page, pageInfos, pendingSignature, record, refreshPage, showError]);

  const removeSignature = useCallback(async (signature: SignatureDelta) => {
    const client = clientRef.current;
    if (!client) return;
    const allow = mutationPermission();
    if (allow === null) return;
    const delta = { ...signature, placement: { ...signature.placement, allowInvalidateDigitalSignatures: allow } };
    setBusy(true);
    try {
      await client.removeSignature(delta);
      record({ description: 'Remove signature', actions: [{ kind: 'signature-remove', delta }] });
      await refreshPage();
      setStatus('Signature removed.');
    } catch (value) { showError(value); }
    finally { setBusy(false); }
  }, [mutationPermission, record, refreshPage, showError]);

  const applyHistory = useCallback(async (entry: HistoryEntry, redo: boolean) => {
    const client = clientRef.current;
    if (!client) return;
    const actions = redo ? entry.actions : [...entry.actions].reverse();
    for (const action of actions) {
      if (action.kind === 'content') await client.applyContentDelta(action.delta, redo);
      else if (action.kind === 'signature-add') {
        if (redo) action.delta = await client.restoreSignature(action.delta);
        else await client.removeSignature(action.delta);
      } else if (action.kind === 'signature-remove') {
        if (redo) await client.removeSignature(action.delta);
        else action.delta = await client.restoreSignature(action.delta);
      } else if (redo) {
        await client.removeSignature(action.before);
        action.after = await client.restoreSignature(action.after);
      } else {
        await client.removeSignature(action.after);
        action.before = await client.restoreSignature(action.before);
      }
    }
  }, []);

  const undo = useCallback(async () => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    setBusy(true);
    try {
      await applyHistory(entry, false);
      redoStack.current.push(entry);
      setHistoryVersion((value) => value + 1);
      syncDirty();
      await refreshPage();
      setStatus(`Undid: ${entry.description}.`);
    } catch (value) { undoStack.current.push(entry); showError(value); }
    finally { setBusy(false); }
  }, [applyHistory, refreshPage, showError, syncDirty]);

  const redo = useCallback(async () => {
    const entry = redoStack.current.pop();
    if (!entry) return;
    setBusy(true);
    try {
      await applyHistory(entry, true);
      undoStack.current.push(entry);
      setHistoryVersion((value) => value + 1);
      syncDirty();
      await refreshPage();
      setStatus(`Redid: ${entry.description}.`);
    } catch (value) { redoStack.current.push(entry); showError(value); }
    finally { setBusy(false); }
  }, [applyHistory, refreshPage, showError, syncDirty]);

  const runSearch = useCallback(async () => {
    const requestId = ++searchRequestRef.current;
    const client = clientRef.current;
    if (!client || !query.trim()) { setHits([]); setActiveHit(-1); return; }
    setBusy(true);
    try {
      const result = await client.search(query.trim());
      if (requestId !== searchRequestRef.current) return;
      setHits(result);
      setActiveHit(result.length ? 0 : -1);
      if (result[0]) await refreshPage(result[0].page);
      if (requestId !== searchRequestRef.current) return;
      setStatus(result.length ? `Search result 1 of ${result.length}.` : `No results for “${query.trim()}”.`);
    } catch (value) { showError(value); }
    finally { setBusy(false); }
  }, [query, refreshPage, showError]);

  const clearSearch = useCallback(() => {
    searchRequestRef.current += 1;
    setQuery('');
    setHits([]);
    setActiveHit(-1);
  }, []);

  const selectHit = useCallback(async (requested: number) => {
    if (!hits.length) return;
    const next = (requested + hits.length) % hits.length;
    setActiveHit(next);
    if (hits[next].page !== page) await refreshPage(hits[next].page);
    setStatus(`Search result ${next + 1} of ${hits.length}.`);
  }, [hits, page, refreshPage]);

  const saveCopy = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setBusy(true);
    try {
      const bytes = await client.save();
      const name = `${fileStem(fileName)}_edited.pdf`;
      download(bytes, name);
      savedHistoryKey.current = historyKey();
      setDirty(false);
      setStatus(`Saved ${name}. The original upload remains unchanged.`);
    } catch (value) {
      if (!(value instanceof DOMException && value.name === 'AbortError')) showError(value);
    } finally { setBusy(false); }
  }, [fileName, historyKey, showError]);

  const beginSignature = useCallback(() => {
    setStrokes([]);
    setShowSignature(true);
    window.setTimeout(() => signatureCanvasRef.current?.getContext('2d')?.clearRect(0, 0, 600, 220));
  }, []);

  const drawSignature = useCallback((event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = signatureCanvasRef.current;
    if (!canvas || !drawing) return;
    const rect = canvas.getBoundingClientRect();
    const point = { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
    setStrokes((current) => {
      if (!current.length) return [{ points: [point] }];
      const next = current.map((stroke, index) => index === current.length - 1 ? { points: [...stroke.points, point] } : stroke);
      const currentStroke = next[next.length - 1];
      const context = canvas.getContext('2d');
      if (context) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.strokeStyle = '#000000';
        context.lineWidth = 2;
        context.lineCap = 'round';
        for (const stroke of next) {
          context.beginPath();
          stroke.points.forEach((value, index) => index ? context.lineTo(value.x, value.y) : context.moveTo(value.x, value.y));
          context.stroke();
        }
      }
      return currentStroke ? next : current;
    });
  }, [drawing]);

  const stageSignature = useCallback(() => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const valid = strokes.filter((stroke) => stroke.points.length > 1);
    if (!valid.length) { setStatus('Draw at least one signature stroke first.'); return; }
    const all = valid.flatMap((stroke) => stroke.points);
    const left = Math.min(...all.map((point) => point.x));
    const top = Math.min(...all.map((point) => point.y));
    const width = Math.max(1, Math.max(...all.map((point) => point.x)) - left);
    const height = Math.max(1, Math.max(...all.map((point) => point.y)) - top);
    setPendingSignature({
      strokes: valid.map((stroke) => ({ points: stroke.points.map((point) => ({ x: (point.x - left) / width, y: (point.y - top) / height })) })),
      sourceWidth: width,
      sourceHeight: height,
    });
    setShowSignature(false);
    setTool('signature');
    setStatus('Click the page where you want to place the signature.');
  }, [strokes]);

  const changeTool = useCallback((next: ToolMode) => {
    setTool(next);
    if (next !== 'signature') setPendingSignature(null);
    const messages: Record<ToolMode, string> = {
      select: 'Selection tool active.',
      edit: '',
      move: 'Move: drag text or a signature, or drag empty space to select several items.',
      signature: 'Draw a signature first, then click the page to place it.',
      pan: 'Pan: drag the document canvas.',
    };
    setStatus(messages[next]);
  }, []);

  const zoomTo = useCallback((value: number) => {
    if (!hasDocument) return;
    const next = Math.max(0.25, Math.min(5, value));
    if (next === zoomRef.current) return;
    zoomRef.current = next;
    setZoom(next);
    // The existing raster is intentionally kept on screen while the page
    // scales via CSS. Only the final zoom in a rapid gesture needs a new
    // MuPDF raster, which avoids building a queue of obsolete renders.
    renderSequence.current += 1;
    cancelScheduledZoomRender();
    zoomRenderTimer.current = window.setTimeout(() => {
      zoomRenderTimer.current = null;
      void renderPage(page, next).catch(showError);
    }, ZOOM_RENDER_DEBOUNCE_MS);
  }, [cancelScheduledZoomRender, hasDocument, page, renderPage, showError]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    // Use a native non-passive listener so Chromium allows this cancellation
    // to prevent its page-level Ctrl+wheel zoom gesture.
    const onWheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      zoomTo(zoomRef.current * (event.deltaY < 0 ? 1.1 : 0.9));
    };

    viewport.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => viewport.removeEventListener('wheel', onWheel, { capture: true });
  }, [zoomTo]);

  useEffect(() => {
    if (!clientRef.current) clientRef.current = new PdfWorkerClient();
    return () => {
      cancelScheduledZoomRender();
      clientRef.current?.destroy();
      clientRef.current = null;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      Object.values(thumbnailsRef.current).forEach(URL.revokeObjectURL);
    };
  // URLs are deliberately cleaned when replaced and on final unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelScheduledZoomRender]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const browserTheme = window.matchMedia('(prefers-color-scheme: dark)');
    const followBrowserTheme = (event: MediaQueryListEvent) => {
      if (localStorage.getItem(THEME_STORAGE_KEY) === null) {
        setTheme(event.matches ? 'dark' : 'light');
      }
    };
    browserTheme.addEventListener('change', followBrowserTheme);
    return () => browserTheme.removeEventListener('change', followBrowserTheme);
  }, []);

  useEffect(() => {
    setPageInput(hasDocument ? String(page + 1) : '');
  }, [hasDocument, page]);

  useEffect(() => {
    // Match the desktop sidebar's warm-up: populate the first visible page rows
    // one at a time, while the remaining rows render when the user reaches
    // them. Keeping the worker queue shallow leaves room for interactive page
    // renders such as zoom and navigation.
    let cancelled = false;
    let index = 0;
    let timer: number | null = null;
    const scheduleNext = () => {
      if (cancelled || index >= Math.min(pageInfos.length, 12)) return;
      const pageInfo = pageInfos[index++];
      void loadThumbnail(pageInfo.page).finally(() => {
        if (!cancelled) timer = window.setTimeout(scheduleNext, 50);
      });
    };
    timer = window.setTimeout(scheduleNext, 150);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadThumbnail, pageInfos]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const editableTarget = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchInputRef.current?.focus(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveCopy(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); void (event.shiftKey ? redo() : undo()); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); void redo(); return; }
      if ((event.ctrlKey || event.metaKey) && (event.key === '+' || event.key === '=')) { event.preventDefault(); zoomTo(zoomRef.current + 0.1); return; }
      if ((event.ctrlKey || event.metaKey) && event.key === '-') { event.preventDefault(); zoomTo(zoomRef.current - 0.1); return; }
      if (editableTarget) return;
      if (event.key === 'ArrowRight' && page < pageInfos.length - 1) void refreshPage(page + 1);
      if (event.key === 'ArrowLeft' && page > 0) void refreshPage(page - 1);
      if (event.key === 'Escape') { setPendingSignature(null); setTool('select'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, pageInfos.length, redo, refreshPage, saveCopy, undo, zoomTo]);

  const currentHits = hits.filter((hit) => hit.page === page);

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">✦</span><div><strong>PDF Edit</strong><span>local workspace</span></div></div>
      <div className="top-actions" role="toolbar" aria-label="File actions">
        <button className="button quiet file-action" disabled={busy} onClick={() => fileInputRef.current?.click()}>Open PDF</button>
        <button className="button primary file-action" disabled={!hasDocument || !dirty || busy} onClick={() => void saveCopy()}>Save Copy</button>
        <button
          className="icon-button theme-toggle"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={() => {
            const nextTheme = theme === 'dark' ? 'light' : 'dark';
            localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
            setTheme(nextTheme);
          }}
        >{theme === 'dark' ? '☀' : '☾'}</button>
      </div>
    </header>

    <div className="command-strip">
      <div className="top-toolbar" role="toolbar" aria-label="Document tools">
        <button className={`tool-button ${tool === 'edit' ? 'active' : ''}`} disabled={!hasDocument} onClick={() => changeTool('edit')}>Edit text</button>
        <button className={`tool-button ${tool === 'move' ? 'active' : ''}`} disabled={!hasDocument} onClick={() => changeTool('move')}>Move text</button>
        <button className={`tool-button ${tool === 'pan' ? 'active' : ''}`} disabled={!hasDocument} onClick={() => changeTool('pan')}>Pan</button>
        <button className={`tool-button ${tool === 'signature' ? 'active' : ''}`} disabled={!hasDocument} onClick={beginSignature}>Signature</button>
        <button className="tool-button" disabled={!canUndo} onClick={() => void undo()}>Undo</button>
        <button className="tool-button" disabled={!canRedo} onClick={() => void redo()}>Redo</button>
        <span className="toolbar-divider" />
        <button className="icon-button" aria-label="Previous page" disabled={page <= 0 || busy} onClick={() => void refreshPage(page - 1)}>←</button>
        <div className="page-jump" aria-label="Page navigation">
          <input
            aria-label="Page number"
            className="page-number-input"
            disabled={!hasDocument || busy}
            inputMode="numeric"
            max={pageInfos.length || undefined}
            min="1"
            onBlur={jumpToPage}
            onChange={(event) => setPageInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); jumpToPage(); }
              if (event.key === 'Escape') { setPageInput(String(page + 1)); event.currentTarget.blur(); }
            }}
            type="number"
            value={pageInput}
          />
          <span className="page-indicator">/ {pageInfos.length || '—'}</span>
        </div>
        <button className="icon-button" aria-label="Next page" disabled={page >= pageInfos.length - 1 || busy} onClick={() => void refreshPage(page + 1)}>→</button>
        <button className="icon-button" aria-label="Zoom out" disabled={!hasDocument} onClick={() => zoomTo(zoom - 0.1)}>−</button>
        <button className="zoom-label" disabled={!hasDocument} onClick={() => zoomTo(1)}>{Math.round(zoom * 100)}%</button>
        <button className="icon-button" aria-label="Zoom in" disabled={!hasDocument} onClick={() => zoomTo(zoom + 0.1)}>+</button>
        <button className="tool-button" onClick={() => zoomTo(Math.min(5, Math.max(.25, (window.innerHeight - 210) / (pageInfos[page]?.height || 800))))} disabled={!hasDocument}>Fit page</button>
        <button className="tool-button" onClick={() => zoomTo(Math.min(5, Math.max(.25, ((viewportRef.current?.clientWidth ?? 800) - 90) / (pageInfos[page]?.width || 600))))} disabled={!hasDocument}>Fit width</button>
      </div>
      <div className="command-group search-command">
        <div className={`search-results ${hits.length > 0 ? 'has-results' : ''}`} aria-live="polite">
          {hits.length > 0 && <><span className="search-count">{activeHit + 1} / {hits.length}</span><button className="icon-button" aria-label="Previous search result" onClick={() => void selectHit(activeHit - 1)}>←</button><button className="icon-button" aria-label="Next search result" onClick={() => void selectHit(activeHit + 1)}>→</button></>}
        </div>
        <div className="search-entry">
          <div className="search-field">
            <input ref={searchInputRef} aria-label="Search PDF" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void (event.shiftKey ? selectHit(activeHit - 1) : runSearch()); }} placeholder="Search PDF" />
            <button className={`icon-button search-clear ${query || hits.length > 0 ? 'visible' : ''}`} aria-label="Clear search" title="Clear search" disabled={!query && hits.length === 0} onClick={clearSearch}>×</button>
          </div>
          <button className="tool-button search-submit" disabled={!hasDocument || busy} onClick={() => void runSearch()}>Search</button>
        </div>
      </div>
      <input ref={fileInputRef} aria-label="Choose a PDF" hidden type="file" accept="application/pdf,.pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) openFile(file); event.target.value = ''; }} />
    </div>

    <main className="workspace">
      <aside className="sidebar" aria-label="Document pages">
        <div className="sidebar-section pages-section">
          <div className="file-card"><span className="file-icon">PDF</span><div className="file-meta"><strong>{fileName || 'No document open'}</strong><span>{pageInfos.length ? `${pageInfos.length} pages · ${dirty ? 'unsaved edits' : 'saved state'}` : 'Ready for a local file'}</span></div></div>
          <div className="section-label pages-label">PAGES</div>
          {pageInfos.length > 0 ? <div className="thumbnail-list">{pageInfos.map((pageInfo) =>
            <button key={pageInfo.page} className={`thumbnail ${page === pageInfo.page ? 'active' : ''}`} onClick={() => void refreshPage(pageInfo.page)} onFocus={() => void loadThumbnail(pageInfo.page)} onMouseEnter={() => void loadThumbnail(pageInfo.page)}>
              <span className="thumbnail-number">{pageInfo.page + 1}</span>
              <span className="thumbnail-preview" style={{ aspectRatio: `${pageInfo.width} / ${pageInfo.height}` }}>
                {thumbnails[pageInfo.page] ? <img src={thumbnails[pageInfo.page]} alt="" /> : <span className="thumbnail-placeholder">{pageInfo.page + 1}</span>}
              </span>
            </button>,
          )}</div> : <p className="hint">Open a PDF to see its pages here.</p>}
        </div>
        {signatures.length > 0 && <div className="sidebar-section"><div className="section-label">SIGNATURES</div>{signatures.map((signature) =>
          <div className="signature-row" key={signature.annotationObject}><span>Ink {signature.annotationObject}</span><button className="button tiny outline" onClick={() => void removeSignature(signature)}>Remove</button></div>,
        )}</div>}
      </aside>

      <section className="viewer-column" aria-label="PDF viewer">
        <div
          ref={viewportRef}
          className={`dropzone ${dragging ? 'is-dragging' : ''} ${hasDocument ? 'has-document' : ''} ${tool === 'pan' ? 'pan-active' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) openFile(file); }}
          onPointerDown={(event) => {
            if ((event.button !== 1 && tool !== 'pan') || !viewportRef.current) return;
            panRef.current = { x: event.clientX, y: event.clientY, left: viewportRef.current.scrollLeft, top: viewportRef.current.scrollTop };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!panRef.current || !viewportRef.current) return;
            viewportRef.current.scrollLeft = panRef.current.left - (event.clientX - panRef.current.x);
            viewportRef.current.scrollTop = panRef.current.top - (event.clientY - panRef.current.y);
          }}
          onPointerUp={() => { panRef.current = null; }}
          onPointerCancel={() => { panRef.current = null; }}
        >
          {!hasDocument ? <div className="empty-state"><div className="empty-icon">↥</div><h2>Open a PDF to start</h2><p>Choose a file from your device or drag it here. Nothing is uploaded.</p><div className="empty-actions"><button className="button primary file-action" disabled={busy} onClick={() => fileInputRef.current?.click()}>Open PDF</button></div></div>
            : imageUrl && pageInfos[page] ? <PageSurface
              pageInfo={pageInfos[page]}
              pageNumber={page}
              zoom={zoom}
              imageUrl={imageUrl}
              textRuns={textRuns}
              signatures={signatures}
              hits={currentHits}
              activeHit={activeHit >= 0 ? hits[activeHit] : undefined}
              tool={tool}
              signaturePending={Boolean(pendingSignature)}
              busy={busy}
              onEdit={editRun}
              onMove={moveTargets}
              onResizeSignature={resizeSignature}
              onPlaceSignature={addSignatureAt}
              onStatus={setStatus}
            /> : <div className="loading-state">Rendering page…</div>}
        </div>
      </section>
    </main>

    <footer><span>Privacy: All document processing stays in this browser tab.</span><span>{sourceHash ? `Source SHA-256: ${sourceHash.slice(0, 16)}… · ` : ''}{info?.hasDigitalSignatures ? 'Signed document warning enabled · ' : ''}PDF Edit Web · no server required · MuPDF.js · local-only processing</span></footer>

    {showSignature && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Draw signature"><div className="modal">
      <h2>Draw your signature</h2><p>Use a mouse, touch screen, or pen. It will be stored as vector ink.</p>
      <canvas
        ref={signatureCanvasRef}
        width={600}
        height={220}
        className="signature-canvas"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDrawing(true); setStrokes((current) => [...current, { points: [] }]); }}
        onPointerMove={drawSignature}
        onPointerUp={() => setDrawing(false)}
        onPointerCancel={() => setDrawing(false)}
      />
      <div className="modal-actions"><button className="button outline" onClick={() => setShowSignature(false)}>Cancel</button><button className="button quiet" onClick={() => { setStrokes([]); signatureCanvasRef.current?.getContext('2d')?.clearRect(0, 0, 600, 220); }}>Clear</button><button className="button accent" onClick={stageSignature}>Place on page</button></div>
    </div></div>}
  </div>;
}
