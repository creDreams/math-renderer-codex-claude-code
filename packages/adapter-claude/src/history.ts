import path from 'node:path';
import type { HistoryAdapter } from '../../adapter-codex/src/history-index.js';
import { claudeSourceKeys, claudeVisibleKeys, matchClaudeText } from './matcher.js';
export function claudeRecord(record: any): {
    id?: string;
    cwd?: string;
    text?: string;
} {
    if (record?.type !== 'assistant' || record.isSidechain === true || record.isCompactSummary === true ||
        record.message?.role !== 'assistant' || typeof record.sessionId !== 'string' || typeof record.cwd !== 'string')
        return {};
    const text = (Array.isArray(record.message.content) ? record.message.content : [])
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('\n');
    return { id: record.sessionId, cwd: record.cwd, text: text || undefined };
}
export const claudeHistoryAdapter: HistoryAdapter = {
    version: 'claude-v5', directory: home => path.resolve(home, 'projects'),
    directoryEntry: (_name, depth) => depth === 0,
    fileEntry: name => /^[a-f0-9-]{36}\.jsonl$/i.test(name),
    record: claudeRecord, sourceKeys: claudeSourceKeys, keyLength: key => key.length - 'claude:'.length,
    visibleKeys: claudeVisibleKeys, match: matchClaudeText,
};
