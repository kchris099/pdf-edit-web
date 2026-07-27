export interface MovePoint {
  x: number;
  y: number;
}

export function constrainMovePoint(start: MovePoint, current: MovePoint, constrain: boolean): MovePoint {
  if (!constrain) return current;

  const deltaX = current.x - start.x;
  const deltaY = current.y - start.y;
  return Math.abs(deltaX) >= Math.abs(deltaY)
    ? { x: current.x, y: start.y }
    : { x: start.x, y: current.y };
}
