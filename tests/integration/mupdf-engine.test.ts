import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MuPdfEngine } from '../../src/pdf/engine';

const fixture = path.resolve(process.cwd(), '..', 'pdf-edit', 'samples', 'Generated', 'editable-embedded-font.pdf');

describe('MuPDF Phase 0 engine', () => {
  it('opens, searches, renders, rewrites, saves, and reopens the fixture', async () => {
    const original = fs.readFileSync(fixture);
    const engine = new MuPdfEngine();
    expect(engine.open(original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) as ArrayBuffer).pageCount).toBe(1);
    expect(engine.search('Client Name')).toHaveLength(1);
    expect(engine.render(0, 1).png.byteLength).toBeGreaterThan(100);
    const edit = await engine.editText({ page: 0, originalText: 'Client Name', replacementText: 'Client ID' });
    expect(edit.changed).toBe(true);
    const saved = engine.save();
    const reopened = new MuPdfEngine();
    reopened.open(saved);
    expect(reopened.search('Client ID')).toHaveLength(1);
    expect(reopened.search('Client Name')).toHaveLength(0);
    expect(reopened.render(0, 1).png.byteLength).toBeGreaterThan(100);
    engine.close(); reopened.close();
  });

  it('moves text and round-trips vector ink signatures', () => {
    const engine = new MuPdfEngine();
    engine.open(fs.readFileSync(fixture).buffer.slice(0), undefined);
    const beforeText = engine.inspectText(0).find((run) => run.text === 'Client Name')?.bounds.y ?? 0;
    const moved = engine.moveText({ page: 0, originalText: 'Client Name', deltaX: 12, deltaY: 4 });
    expect(moved.changed).toBe(true);
    expect(moved.delta?.after.byteLength).toBeGreaterThan(moved.delta?.before.byteLength ?? 0);
    const afterText = engine.inspectText(0).find((run) => run.text === 'Client Name')?.bounds.y ?? 0;
    expect(afterText).toBeCloseTo(beforeText - 4, 1);

    const signature = engine.addSignature({
      page: 0,
      bounds: { x: 100, y: 100, width: 120, height: 40 },
      ink: { strokes: [{ points: [{ x: 0, y: 0 }, { x: 60, y: 20 }, { x: 110, y: 5 }] }] },
    });
    const inspected = engine.inspectSignatures(0);
    expect(inspected).toHaveLength(1);

    engine.moveSignature(inspected[0], 25, 15);
    const movedInspection = engine.inspectSignatures(0);
    expect(movedInspection[0].placement.bounds.x - inspected[0].placement.bounds.x).toBeCloseTo(25, 1);
    expect(movedInspection[0].placement.bounds.y - inspected[0].placement.bounds.y).toBeCloseTo(15, 1);

    const movedBounds = movedInspection[0].placement.bounds;
    const resizedSignature = engine.resizeSignature(movedInspection[0], movedBounds.width * 1.5, movedBounds.height * 1.5);
    const resizedInspection = engine.inspectSignatures(0)[0];
    const originalPoints = movedInspection[0].placement.ink.strokes[0].points;
    const resizedPoints = resizedInspection.placement.ink.strokes[0].points;
    const pointRange = (points: typeof originalPoints, axis: 'x' | 'y') =>
      Math.max(...points.map((point) => point[axis])) - Math.min(...points.map((point) => point[axis]));
    expect(pointRange(resizedPoints, 'x') / pointRange(originalPoints, 'x')).toBeCloseTo(1.5, 1);
    expect(pointRange(resizedPoints, 'y') / pointRange(originalPoints, 'y')).toBeCloseTo(1.5, 1);

    engine.removeSignature(resizedSignature);
    expect(engine.inspectSignatures(0)).toHaveLength(0);
    const restored = engine.restoreSignature(signature);
    expect(engine.inspectSignatures(0)[0].annotationObject).toBe(restored.annotationObject);
    engine.close();
  });
});
