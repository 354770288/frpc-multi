import { describe, expect, it } from 'vitest';
import { batchTagDialogTitle, canFreezeServerSelection, canRemoveLegacyLabels, canSubmitServerBatch, legacyServerBatchPayload } from './serverBulkUi';

describe('Server Library bulk UI contracts', () => {
  it('allows empty-ID snapshot submissions and preserves group and label payloads', () => {
    expect(canSubmitServerBatch(0, true, false)).toBe(true);
    expect(canSubmitServerBatch(0, false, false)).toBe(false);
    expect(canSubmitServerBatch(0, true, true)).toBe(false);
    expect(legacyServerBatchPayload('group', 'edge', [], [], true)).toEqual({ group: 'edge' });
    expect(legacyServerBatchPayload('label', '', ['keep'], ['remove'], true)).toEqual({ addLabels: ['keep'], removeLabels: [] });
  });

  it('hides legacy-label removals for snapshots and offers them for explicit selections', () => {
    expect(canRemoveLegacyLabels(true)).toBe(false);
    expect(canRemoveLegacyLabels(false)).toBe(true);
    expect(legacyServerBatchPayload('label', '', [], ['remove'], false)).toEqual({ addLabels: [], removeLabels: ['remove'] });
  });

  it('shows the frozen count in the category-tag dialog and hides removals', () => {
    expect(batchTagDialogTitle(274)).toBe('批量调整分类标签（274 台）');
    expect(canRemoveLegacyLabels(true)).toBe(false);
  });

  it('blocks freezing until visible search and matching count are current', () => {
    expect(canFreezeServerSelection('198.51', '', 20, false, null, false, null)).toBe(false);
    expect(canFreezeServerSelection('198.51', '198.51', null, true, null, false, null)).toBe(false);
    expect(canFreezeServerSelection('198.51', '198.51', 20, false, null, false, null)).toBe(true);
  });
});
