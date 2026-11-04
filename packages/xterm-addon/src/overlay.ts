import type { Terminal, IDisposable } from '@xterm/xterm';
import { MathRenderer } from '../../core/src/renderer.js';

export interface FormulaRegion {
  tex: string;
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
  kind?: 'inline';
  /** A character display without visible delimiters belongs to the preview. */
  requiresPreview?: boolean;
  /** Verified plain mathematical notation may use text-style limits when its
   * display layout cannot fit the available rows at a readable scale. */
  compactFallback?: boolean;
  visibleText?: string;
}
export type RegionSource = () => FormulaRegion[];

/** A DOM sibling of xterm's renderers; never writes to the terminal. */
export class FormulaOverlay {
  private readonly plane = document.createElement('div');
  private readonly subscriptions: IDisposable[] = [];
  private readonly resize: ResizeObserver;
  private frame = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  enabled = true;
  status = { rendered: 0, skipped: 0 };

  constructor(private readonly terminal: Terminal, private readonly source: RegionSource,
    private readonly renderer = new MathRenderer()) {
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) throw new Error('Unsupported xterm DOM: no screen');
    this.plane.className = 'agent-math-plane';
    Object.assign(this.plane.style, { position: 'absolute', inset: '0', overflow: 'hidden',
      pointerEvents: 'none', zIndex: '8' });
    this.plane.setAttribute('aria-hidden', 'true');
    screen.append(this.plane);
    const invalidate = () => this.invalidate();
    this.subscriptions.push(terminal.onWriteParsed(invalidate), terminal.onScroll(invalidate), terminal.onRender(invalidate),
      terminal.onResize(invalidate), terminal.onSelectionChange(invalidate),
      terminal.buffer.onBufferChange(invalidate));
    this.resize = new ResizeObserver(invalidate);
    this.resize.observe(screen);
    this.invalidate();
  }

  invalidate(): void {
    if (this.disposed) return;
    // Remove immediately: stale async results must never cover new output.
    this.plane.replaceChildren();
    if (!this.frame && !this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); });
    }, 50);
  }

  private paint(): void {
    this.status = { rendered: 0, skipped: 0 };
    if (!this.enabled || this.disposed || this.terminal.hasSelection()) return;
    const terminal = this.terminal;
    const screen = this.plane.parentElement!;
    const width = screen.clientWidth / terminal.cols;
    const height = screen.clientHeight / terminal.rows;
    if (!(width > 0 && height > 0)) return;
    const theme = terminal.options.theme;
    const background = theme?.background ?? '#1e1e1e';
    const foreground = theme?.foreground ?? '#dddddd';
    for (const region of this.source()) {
      const row = region.startRow - terminal.buffer.active.viewportY;
      const rows = region.endRow - region.startRow + 1;
      // Partial regions stay as source, including those crossing the viewport edge.
      if (row < 0 || row + rows > terminal.rows) continue;
      const cursorRow = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
      if (cursorRow >= region.startRow && cursorRow <= region.endRow) continue;
      try {
        const rendered = this.renderer.render(region.tex);
        const availableWidth = (region.endColumn - region.startColumn) * width;
        const availableHeight = rows * height;
        const preferred = (terminal.options.fontSize ?? 16) / 16;
        const scale = Math.min(preferred, (availableWidth - 12) / rendered.width,
          (availableHeight - 8) / rendered.height);
        if (scale < preferred * 0.75) { this.status.skipped++; continue; }
        const block = document.createElement('div');
        block.className = 'agent-math-formula';
        Object.assign(block.style, { position: 'absolute', left: `${region.startColumn * width}px`,
          top: `${row * height}px`, width: `${availableWidth}px`, height: `${availableHeight}px`,
          background, color: foreground, display: 'flex', alignItems: 'center',
          justifyContent: 'flex-start', paddingLeft: '6px', boxSizing: 'border-box' });
        block.innerHTML = rendered.svg;
        const svg = block.querySelector('svg')!;
        svg.style.width = `${rendered.width * scale}px`;
        svg.style.height = `${rendered.height * scale}px`;
        svg.style.flex = 'none';
        this.plane.append(block);
        this.status.rendered++;
      } catch { this.status.skipped++; }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.timer);
    this.resize.disconnect();
    this.subscriptions.forEach(x => x.dispose());
    this.plane.remove();
  }
}
