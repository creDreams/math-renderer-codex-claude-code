import type { Terminal } from '@xterm/xterm';

export interface CellLocation { row: number; column: number }
export interface ScreenLine {
  text: string;
  startRow: number;
  endRow: number;
  locations: CellLocation[];
}
export interface ScreenSnapshot { lines: ScreenLine[]; cols: number; buffer: 'normal' | 'alternate' }

/** Read public cell APIs, preserving soft wraps, wide cells and combining code points. */
export function readScreen(terminal: Terminal, maxRows = 600): ScreenSnapshot {
  const buffer = terminal.buffer.active;
  const lines: ScreenLine[] = [];
  let current: ScreenLine | undefined;
  // Bound work around the current viewport; scrollback remains usable without a full scan.
  const end = Math.min(buffer.length, buffer.viewportY + terminal.rows + 120);
  for (let row = Math.max(0, end - maxRows); row < end; row++) {
    const source = buffer.getLine(row);
    if (!source) continue;
    if (!source.isWrapped || !current) {
      current = { text: '', startRow: row, endRow: row, locations: [] };
      lines.push(current);
    }
    const wrappedNext = buffer.getLine(row + 1)?.isWrapped;
    const text = source.translateToString(!wrappedNext);
    let physical = '';
    for (let column = 0; column < terminal.cols && physical.length < text.length; column++) {
      const cell = source.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      physical += chars;
      for (let index = 0; index < chars.length; index++) current.locations.push({ row, column });
    }
    current.text += physical;
    current.endRow = row;
  }
  return { lines, cols: terminal.cols, buffer: buffer.type };
}
