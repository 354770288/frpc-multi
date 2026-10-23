export function canFreezeServerSelection(inputSearch: string, appliedSearch: string | undefined, totalCount: number | null, countLoading: boolean, countError: string | null, pageLoading: boolean, pageError: string | null) {
  return inputSearch === (appliedSearch ?? '') && totalCount !== null && totalCount > 0
    && !countLoading && !countError && !pageLoading && !pageError;
}

export function canSubmitServerBatch(idsCount: number, hasBulkSubmit: boolean, applyDiscover: boolean) {
  return idsCount > 0 || (hasBulkSubmit && !applyDiscover);
}

export function canRemoveLegacyLabels(snapshotMode: boolean) {
  return !snapshotMode;
}

export function batchTagDialogTitle(count: number) {
  return `批量调整分类标签（${count} 台）`;
}

export function legacyServerBatchPayload(kind: 'group' | 'label', group: string, addLabels: string[], removeLabels: string[], snapshotMode: boolean): Record<string, unknown> {
  return kind === 'group' ? { group } : { addLabels, removeLabels: snapshotMode ? [] : removeLabels };
}
