import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { PdfPageInfo, SearchHit, SignatureDelta, TextRun } from '../domain/pdf-models';
import { constrainMovePoint } from './move-gesture';

export type ToolMode = 'select' | 'edit' | 'move' | 'signature' | 'pan';
export type MoveTarget =
  | { id: string; kind: 'text'; bounds: TextRun['bounds']; run: TextRun }
  | { id: string; kind: 'signature'; bounds: SignatureDelta['placement']['bounds']; signature: SignatureDelta };

interface Props {
  pageInfo: PdfPageInfo;
  pageNumber: number;
  zoom: number;
  imageUrl: string;
  textRuns: TextRun[];
  signatures: SignatureDelta[];
  hits: SearchHit[];
  activeHit?: SearchHit;
  tool: ToolMode;
  signaturePending: boolean;
  busy: boolean;
  onEdit(run: TextRun, replacement: string): Promise<void>;
  onMove(targets: MoveTarget[], deltaX: number, deltaY: number): Promise<void>;
  onResizeSignature(signature: SignatureDelta, width: number, height: number): Promise<void>;
  onPlaceSignature(x: number, y: number): Promise<void>;
  onStatus(message: string): void;
}

type Gesture =
  | { kind: 'move'; startX: number; startY: number; targets: MoveTarget[] }
  | { kind: 'resize-signature'; signature: SignatureDelta; startWidth: number; startHeight: number }
  | { kind: 'marquee'; startX: number; startY: number };

function rectStyle(bounds: { x: number; y: number; width: number; height: number }, zoom: number): CSSProperties {
  return { left: bounds.x * zoom, top: bounds.y * zoom, width: bounds.width * zoom, height: bounds.height * zoom };
}

function hitTest<T extends MoveTarget>(targets: T[], x: number, y: number, tolerance: number): T | undefined {
  return targets
    .filter(({ bounds }) => x >= bounds.x - tolerance && x <= bounds.x + bounds.width + tolerance && y >= bounds.y - tolerance && y <= bounds.y + bounds.height + tolerance)
    .sort((a, b) => {
      const aContainsPoint = x >= a.bounds.x && x <= a.bounds.x + a.bounds.width && y >= a.bounds.y && y <= a.bounds.y + a.bounds.height;
      const bContainsPoint = x >= b.bounds.x && x <= b.bounds.x + b.bounds.width && y >= b.bounds.y && y <= b.bounds.y + b.bounds.height;
      if (aContainsPoint !== bContainsPoint) return aContainsPoint ? -1 : 1;
      return a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height;
    })[0];
}

function quadBounds(quad: number[]): { x: number; y: number; width: number; height: number } {
  const xs = quad.filter((_, index) => index % 2 === 0);
  const ys = quad.filter((_, index) => index % 2 === 1);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

function signatureResizePoint(
  bounds: SignatureDelta['placement']['bounds'],
  pageInfo: PdfPageInfo,
  point: { x: number; y: number },
): { x: number; y: number } {
  const widthScale = (point.x - bounds.x) / bounds.width;
  const heightScale = (point.y - bounds.y) / bounds.height;
  const diagonalWeight = bounds.width ** 2 + bounds.height ** 2;
  const projectedScale = (
    widthScale * bounds.width ** 2
    + heightScale * bounds.height ** 2
  ) / diagonalWeight;
  const minimumScale = 12 / Math.max(bounds.width, bounds.height);
  const maximumScale = Math.min(
    (pageInfo.width - bounds.x) / bounds.width,
    (pageInfo.height - bounds.y) / bounds.height,
  );
  const scale = Math.max(minimumScale, Math.min(maximumScale, projectedScale));
  return { x: bounds.x + bounds.width * scale, y: bounds.y + bounds.height * scale };
}

export function PageSurface({
  pageInfo, pageNumber, zoom, imageUrl, textRuns, signatures, hits, activeHit, tool,
  signaturePending, busy, onEdit, onMove, onResizeSignature, onPlaceSignature, onStatus,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<TextRun | null>(null);
  const [editValue, setEditValue] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!activeHit) return;
    const activeHighlight = surfaceRef.current?.querySelector<HTMLElement>('.search-highlight.active');
    activeHighlight?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }, [activeHit, pageNumber]);

  const targets = useMemo<MoveTarget[]>(() => [
    ...textRuns.filter((run) => run.editable && run.text.trim()).map((run) => ({ id: `text:${run.id}`, kind: 'text' as const, bounds: run.bounds, run })),
    ...signatures.map((signature) => ({ id: `signature:${signature.annotationObject}`, kind: 'signature' as const, bounds: signature.placement.bounds, signature })),
  ], [signatures, textRuns]);

  const editableTextRuns = useMemo(() => textRuns.filter((run) => run.text.trim()), [textRuns]);

  useEffect(() => {
    if (tool !== 'edit') setEditing(null);
    if (tool !== 'move') {
      setSelectedIds([]);
      setGesture(null);
    }
  }, [tool]);

  useEffect(() => {
    if (editing && !textRuns.some((run) => run.id === editing.id)) setEditing(null);
  }, [editing, textRuns]);

  const localPoint = (event: PointerEvent<HTMLDivElement>) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  };

  const openEditor = (run: TextRun) => {
    if (!run.editable) {
      onStatus(run.unsupportedReason ?? 'This text object cannot be edited safely.');
      return;
    }
    setSelectedIds([]);
    setEditing(run);
    setEditValue(run.text);
  };

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (busy || event.button !== 0) return;
    const point = localPoint(event);
    if (tool === 'signature' && signaturePending) {
      void onPlaceSignature(point.x, point.y);
      return;
    }
    if (tool === 'edit') {
      const textTarget = hitTest(
        editableTextRuns.map((value) => ({ id: value.id, kind: 'text' as const, bounds: value.bounds, run: value })),
        point.x, point.y, 6 / zoom,
      );
      const run = textTarget?.kind === 'text' ? textTarget.run : undefined;
      if (!run) {
        onStatus(editableTextRuns.length ? 'No text object at this location.' : 'This page has no editable text layer.');
        return;
      }
      openEditor(run);
      return;
    }
    if (tool !== 'move') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = hitTest(targets, point.x, point.y, 6 / zoom);
    if (target) {
      const chosen = selectedIds.includes(target.id) ? targets.filter((item) => selectedIds.includes(item.id)) : [target];
      setSelectedIds(chosen.map((item) => item.id));
      setGesture({ kind: 'move', startX: point.x, startY: point.y, targets: chosen });
      setPointer(point);
      onStatus(chosen.length > 1 ? `Drag to move ${chosen.length} items. Hold Shift to constrain the direction.` : 'Drag to move the selected item.');
    } else {
      setSelectedIds([]);
      setGesture({ kind: 'marquee', startX: point.x, startY: point.y });
      setPointer(point);
      onStatus('Drag a rectangle around text and signatures to select them together.');
    }
  };

  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!gesture) return;
    const point = localPoint(event);
    if (gesture.kind === 'resize-signature') {
      const bounds = gesture.signature.placement.bounds;
      setPointer(signatureResizePoint(bounds, pageInfo, point));
      return;
    }
    setPointer(
      gesture.kind === 'move'
        ? constrainMovePoint({ x: gesture.startX, y: gesture.startY }, point, event.shiftKey)
        : point,
    );
  };

  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!gesture) return;
    const finished = gesture;
    const rawPoint = localPoint(event);
    const point = finished.kind === 'move'
      ? constrainMovePoint({ x: finished.startX, y: finished.startY }, rawPoint, event.shiftKey)
      : finished.kind === 'resize-signature'
        ? signatureResizePoint(finished.signature.placement.bounds, pageInfo, rawPoint)
        : rawPoint;
    setPointer(point);
    setGesture(null);
    if (finished.kind === 'resize-signature') {
      const bounds = finished.signature.placement.bounds;
      const width = Math.max(1, point.x - bounds.x);
      const height = width * finished.startHeight / finished.startWidth;
      if (Math.abs(width - finished.startWidth) >= 0.5) {
        void onResizeSignature(finished.signature, width, height);
      }
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture may already be released */ }
      return;
    }
    if (finished.kind === 'move') {
      const dx = point.x - finished.startX;
      const dy = point.y - finished.startY;
      if (Math.hypot(dx, dy) >= 0.5) void onMove(finished.targets, dx, dy);
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture may already be released */ }
      return;
    }
    const left = Math.min(finished.startX, point.x);
    const top = Math.min(finished.startY, point.y);
    const right = Math.max(finished.startX, point.x);
    const bottom = Math.max(finished.startY, point.y);
    const selected = targets.filter(({ bounds }) => bounds.x <= right && bounds.x + bounds.width >= left && bounds.y <= bottom && bounds.y + bounds.height >= top);
    setSelectedIds(selected.map((item) => item.id));
    onStatus(selected.length ? `Selected ${selected.length} item${selected.length === 1 ? '' : 's'}. Drag a selected item to move the group.` : 'Nothing was inside the selection.');
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture may already be released */ }
  };

  const dx = gesture?.kind === 'move' ? (pointer.x - gesture.startX) * zoom : 0;
  const dy = gesture?.kind === 'move' ? (pointer.y - gesture.startY) * zoom : 0;
  const resizingSignature = gesture?.kind === 'resize-signature' ? gesture.signature : null;
  const marquee = gesture?.kind === 'marquee' ? {
    x: Math.min(gesture.startX, pointer.x),
    y: Math.min(gesture.startY, pointer.y),
    width: Math.abs(pointer.x - gesture.startX),
    height: Math.abs(pointer.y - gesture.startY),
  } : null;

  const commitEdit = () => {
    if (!editing) return;
    const run = editing;
    const replacement = editValue;
    setEditing(null);
    if (replacement !== run.text) {
      // Let the click that blurred the editor finish before an edit marks the
      // app busy. Otherwise React can disable the clicked toolbar control
      // between pointer-down and click, leaving the old tool selected.
      window.setTimeout(() => void onEdit(run, replacement), 0);
    }
  };

  const cancelEdit = () => {
    setEditValue(editing?.text ?? '');
    setEditing(null);
    onStatus('Text edit cancelled.');
  };

  return <div className="page-shell">
    <div
      ref={surfaceRef}
      className={`page-surface tool-${tool}`}
      style={{ width: pageInfo.width * zoom, height: pageInfo.height * zoom }}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={() => setGesture(null)}
      data-page={pageNumber}
    >
      <img src={imageUrl} alt={`Page ${pageNumber + 1}`} draggable={false} />
      <div className="interaction-layer">
        {hits.flatMap((hit, hitIndex) => hit.quads.map((quad, quadIndex) =>
          <span key={`${hitIndex}:${quadIndex}`} className={`search-highlight ${hit === activeHit ? 'active' : ''}`} style={rectStyle(quadBounds(quad), zoom)} />,
        ))}
        {tool === 'edit' && editableTextRuns.map((run) =>
          <button
            type="button"
            key={run.id}
            className={`text-hitbox ${run.editable ? '' : 'unsupported'}`}
            style={rectStyle(run.bounds, zoom)}
            aria-label={`Edit text: ${run.text.trim()}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (!busy) openEditor(run);
            }}
          />,
        )}
        {targets.map((target) => {
          const selected = selectedIds.includes(target.id);
          if (!selected) return null;
          const moving = gesture?.kind === 'move' && gesture.targets.some((item) => item.id === target.id);
          const resizing = target.kind === 'signature' && resizingSignature?.annotationObject === target.signature.annotationObject;
          const resizeStyle = resizing ? {
            width: (pointer.x - target.bounds.x) * zoom,
            height: (pointer.y - target.bounds.y) * zoom,
          } : {};
          return <span key={target.id} className={`move-box ${selected ? 'selected' : ''} ${target.kind}`} style={{ ...rectStyle(target.bounds, zoom), ...resizeStyle, transform: moving ? `translate(${dx}px, ${dy}px)` : undefined }}>
            {selected && target.kind === 'signature' && <span
              className="signature-resize-handle"
              aria-label="Resize signature"
              onPointerDown={(event) => {
                if (busy) return;
                event.stopPropagation();
                surfaceRef.current?.setPointerCapture(event.pointerId);
                setGesture({
                  kind: 'resize-signature',
                  signature: target.signature,
                  startWidth: target.bounds.width,
                  startHeight: target.bounds.height,
                });
                setPointer({ x: target.bounds.x + target.bounds.width, y: target.bounds.y + target.bounds.height });
              }}
            />}
          </span>;
        })}
        {marquee && <span className="selection-marquee" style={rectStyle(marquee, zoom)} />}
        {editing && <div
          className="inline-editor-panel"
          style={{
            left: Math.min(
              Math.max(6, editing.bounds.x * zoom),
              Math.max(6, pageInfo.width * zoom - 376),
            ),
            top: editing.bounds.y * zoom,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="inline-editor-title">EDIT TEXT</span>
          <input
            autoFocus
            className="inline-text-editor"
            value={editValue}
            aria-label={`Edit ${editing.text}`}
            onChange={(event) => setEditValue(event.target.value)}
            onPointerDown={(event) => event.stopPropagation()}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitEdit(); }
              if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); }
            }}
            onBlur={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.parentElement?.contains(event.relatedTarget)) return;
              commitEdit();
            }}
          />
          <button type="button" className="inline-editor-save" onMouseDown={(event) => event.preventDefault()} onClick={commitEdit}>Save</button>
          <button type="button" className="inline-editor-cancel" onMouseDown={(event) => event.preventDefault()} onClick={cancelEdit}>Cancel</button>
        </div>}
      </div>
    </div>
    <div className="page-caption">Page {pageNumber + 1} · {textRuns.length} text runs · {signatures.length} signatures</div>
  </div>;
}
