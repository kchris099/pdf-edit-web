export interface ByteDelta { streamObject: number; before: Uint8Array; after: Uint8Array }

export class UndoRedo<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  push(command: T): void { this.undoStack.push(command); this.redoStack = []; }
  undo(): T | undefined { const value = this.undoStack.pop(); if (value) this.redoStack.push(value); return value; }
  redo(): T | undefined { const value = this.redoStack.pop(); if (value) this.undoStack.push(value); return value; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  clear(): void { this.undoStack = []; this.redoStack = []; }
}
