import { NgModule } from '@angular/core';
import { TerminalDecorator } from 'tabby-terminal';
import { TabContextMenuItemProvider } from 'tabby-core';
import type { Terminal } from '@xterm/xterm';
import { FormulaOverlay, type FormulaRegion } from '../../xterm-addon/src/overlay.js';
import { readScreen } from '../../xterm-addon/src/snapshot.js';
import { matchCodex, type MatchResult, type CodexSession } from '../../adapter-codex/src/matcher.js';
import { SessionStore, sameDirectory } from '../../adapter-codex/src/sessions.js';

interface Attachment {
  terminal: Terminal; overlay: FormulaOverlay; diagnosticRegions: FormulaRegion[];
  sessions: CodexSession[]; match: MatchResult; timer: ReturnType<typeof setInterval>;
  disposed: boolean;
}
const attachments = new Map<any, Attachment>();
const store = new SessionStore();

class MathDecorator extends TerminalDecorator {
  attach(tab: any): void {
    if (attachments.has(tab)) return;
    const terminal = tab.frontend?.xterm as Terminal | undefined;
    if (!terminal?.onWriteParsed || !terminal.buffer || !terminal.element) {
      console.warn('[Agent Math] Unsupported terminal frontend');
      return;
    }
    const attachment: Attachment = { terminal, diagnosticRegions: [], overlay: undefined!,
      sessions: [], match: { regions: [], sourceRanges: [], state: 'waiting' }, timer: undefined!, disposed: false };
    attachment.overlay = new FormulaOverlay(terminal, () => {
      if (attachment.diagnosticRegions.length) return attachment.diagnosticRegions;
      attachment.match = matchCodex(readScreen(terminal), attachment.sessions);
      return attachment.match.regions;
    });
    attachments.set(tab, attachment);
    const update = async () => {
      try {
        const [sessions, cwd] = await Promise.all([store.refresh(), tab.session?.getWorkingDirectory()]);
        if (attachment.disposed) return;
        attachment.sessions = sessions.filter(x => typeof cwd === 'string' && sameDirectory(x.cwd, cwd));
        attachment.overlay.invalidate();
      } catch {
        if (!attachment.disposed) {
          attachment.sessions = [];
          attachment.overlay.invalidate();
        }
      }
    };
    attachment.timer = setInterval(() => void update(), 2000);
    void update();
  }

  detach(tab: any): void {
    const attachment = attachments.get(tab);
    if (attachment) {
      attachment.disposed = true;
      clearInterval(attachment.timer);
      attachment.overlay.dispose();
    }
    attachments.delete(tab);
    super.detach(tab);
  }
}

class MathMenu extends TabContextMenuItemProvider {
  weight = 1;
  async getItems(tab: any, tabHeader = false): Promise<any[]> {
    if (tabHeader) return [];
    const entry = attachments.get(tab);
    if (!entry) return [];
    const state = entry.match.state === 'matched' ? '已匹配 Codex 会话' :
      entry.match.state === 'ambiguous' ? '多个会话匹配，保留原文' : '等待可确认的 Codex 回答';
    return [{ label: '公式：启用渲染', type: 'checkbox', checked: entry.overlay.enabled,
      click: () => { entry.overlay.enabled = !entry.overlay.enabled; entry.overlay.invalidate(); } },
    { label: `公式：${state}（已显示 ${entry.overlay.status.rendered}）`, enabled: false }];
  }
}

const decorator = new MathDecorator();
if (process.env.AGENT_MATH_DIAGNOSTICS === '1') {
  // Explicit development flag only; never enabled in the packaged launcher.
  (globalThis as any).__agentMath = { attachments, decorator };
}
class AgentMathModule {}
NgModule({ providers: [
  { provide: TerminalDecorator, useValue: decorator, multi: true },
  { provide: TabContextMenuItemProvider, useFactory: () => new MathMenu(), multi: true },
] })(AgentMathModule);
export default AgentMathModule;
