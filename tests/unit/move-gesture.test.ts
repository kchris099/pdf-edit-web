import { describe, expect, it } from 'vitest';
import { constrainMovePoint } from '../../src/components/move-gesture';

describe('constrainMovePoint', () => {
  const start = { x: 10, y: 20 };

  it('leaves a move unconstrained when Shift is not pressed', () => {
    expect(constrainMovePoint(start, { x: 18, y: 26 }, false)).toEqual({ x: 18, y: 26 });
  });

  it('snaps a mostly horizontal move to the horizontal axis', () => {
    expect(constrainMovePoint(start, { x: 24, y: 25 }, true)).toEqual({ x: 24, y: 20 });
  });

  it('snaps a mostly vertical move to the vertical axis', () => {
    expect(constrainMovePoint(start, { x: 14, y: 35 }, true)).toEqual({ x: 10, y: 35 });
  });
});
