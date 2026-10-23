import { useCallback, useEffect, useRef, useState } from 'react';
import { probeApi } from '../../lib/api';
import type { ServerBulkFailure, ServerBulkJob, ServerSelection, ServerQuery } from '../../lib/types';

const SELECTION_KEY = 'probe_server_bulk_selection';
const JOB_KEY = 'probe_server_bulk_job';
const PENDING_KEY = 'probe_server_bulk_pending';

function readSession<T>(key: string): T | null {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as T | null; }
  catch { return null; }
}

export function serverSelectionFilters(query: ServerQuery) {
  return {
    q: query.q?.trim() ?? '',
    ...(query.group !== undefined ? { group: query.group } : {}),
    ...(query.label !== undefined ? { label: query.label } : {}),
    ...(query.groupIds?.length ? { groupIds: [...query.groupIds] } : {}),
    ...(query.tagId !== undefined ? { tagId: query.tagId } : {}),
    ...(query.includeTagIds?.length ? { includeTagIds: [...query.includeTagIds] } : {}),
    ...(query.excludeTagIds?.length ? { excludeTagIds: [...query.excludeTagIds] } : {}),
    ...(query.tagMode ? { tagMode: query.tagMode } : {}),
    conn: query.conn,
  };
}

type PendingSubmission = { selectionId: string; operation: 'update' | 'delete'; payload: Record<string, unknown>; idempotencyKey: string; ids?: number[]; retryJobId?: string };

export function useServerBulk(active: boolean) {
  const [selection, setSelection] = useState<ServerSelection | null>(() => readSession(SELECTION_KEY));
  const [job, setJob] = useState<ServerBulkJob | null>(() => readSession(JOB_KEY));
  const [failures, setFailures] = useState<ServerBulkFailure[]>([]);
  const [failureCursor, setFailureCursor] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingSubmission | null>(() => readSession(PENDING_KEY));
  const [error, setError] = useState<string | null>(null);
  const failuresLoadedFor = useRef<string | null>(null);

  useEffect(() => { selection ? sessionStorage.setItem(SELECTION_KEY, JSON.stringify(selection)) : sessionStorage.removeItem(SELECTION_KEY); }, [selection]);
  useEffect(() => { job ? sessionStorage.setItem(JOB_KEY, JSON.stringify(job)) : sessionStorage.removeItem(JOB_KEY); }, [job]);
  useEffect(() => { pending ? sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending)) : sessionStorage.removeItem(PENDING_KEY); }, [pending]);

  const refreshSelection = useCallback(async () => {
    if (!selection) return;
    const next = await probeApi.serverSelection(selection.selectionId);
    setSelection(next);
  }, [selection?.selectionId]);
  const refreshJob = useCallback(async () => {
    if (!job) return;
    const next = await probeApi.serverBulkJob(job.jobId);
    setJob(next);
  }, [job?.jobId]);

  useEffect(() => {
    if (!active || (!selection || !['queued', 'building'].includes(selection.state)) && (!job || !['queued', 'running'].includes(job.state))) return;
    const timer = window.setInterval(() => {
      if (selection && ['queued', 'building'].includes(selection.state)) void refreshSelection().catch((cause) => setError(cause instanceof Error ? cause.message : '选择快照状态读取失败'));
      if (job && ['queued', 'running'].includes(job.state)) void refreshJob().catch((cause) => setError(cause instanceof Error ? cause.message : '批量任务状态读取失败'));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [active, selection?.selectionId, selection?.state, job?.jobId, job?.state, refreshSelection, refreshJob]);

  useEffect(() => {
    if (!active || !job || !['done', 'partial', 'failed'].includes(job.state) || failuresLoadedFor.current === job.jobId) return;
    failuresLoadedFor.current = job.jobId;
    void probeApi.serverBulkFailures(job.jobId).then((result) => {
      setFailures(result.items); setFailureCursor(result.nextCursor);
    }).catch((cause) => {
      failuresLoadedFor.current = null;
      setError(cause instanceof Error ? cause.message : '失败明细读取失败');
    });
  }, [active, job?.jobId, job?.state]);

  const freezeAllMatching = useCallback(async (query: ServerQuery) => {
    setError(null);
    try {
      const next = await probeApi.createServerSelection({ allMatching: true, ...serverSelectionFilters(query) });
      setSelection(next);
      return next;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '创建选择快照失败';
      setError(message); throw cause;
    }
  }, []);

  const submit = useCallback(async (operation: 'update' | 'delete', payload: Record<string, unknown>, ids?: number[]) => {
    let target = selection;
    const pendingMatches = !!pending && !pending.retryJobId && pending.operation === operation && JSON.stringify(pending.payload) === JSON.stringify(payload) && JSON.stringify(pending.ids ?? null) === JSON.stringify(ids ?? null);
    if (ids && pendingMatches) target = { selectionId: pending!.selectionId, state: 'ready', count: ids.length, processed: ids.length, createdAt: '', updatedAt: '', expiresAt: '', error: null };
    else if (ids) target = await probeApi.createServerSelection({ ids });
    if (!target || target.state !== 'ready') throw new Error('选择快照尚未就绪');
    const isSame = pendingMatches && pending?.selectionId === target.selectionId;
    const request = isSame ? pending! : { selectionId: target.selectionId, operation, payload, idempotencyKey: crypto.randomUUID(), ...(ids ? { ids: [...ids] } : {}) };
    setPending(request); setError(null);
    try {
      const next = await probeApi.createServerBulkJob({ selectionId: request.selectionId, operation: request.operation, payload: request.payload, idempotencyKey: request.idempotencyKey });
      setPending(null); setJob(next); setFailures([]); setFailureCursor(null);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交批量任务失败');
      throw cause;
    }
  }, [pending, selection]);

  const retryFailed = useCallback(async () => {
    if (!job) return;
    const request = pending?.retryJobId === job.jobId ? pending : { selectionId: job.selectionId, operation: job.operation, payload: {}, idempotencyKey: crypto.randomUUID(), retryJobId: job.jobId };
    setPending(request); setError(null);
    try {
      const next = await probeApi.retryServerBulkFailures(job.jobId, request.idempotencyKey);
      setPending(null); setJob(next); setFailures([]); setFailureCursor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重试失败项提交失败');
      throw cause;
    }
  }, [job?.jobId, job?.selectionId, job?.operation, pending]);

  const retryPending = useCallback(async () => {
    if (!pending) return;
    if (pending.retryJobId) {
      try {
        const next = await probeApi.retryServerBulkFailures(pending.retryJobId, pending.idempotencyKey);
        setPending(null); setJob(next); setFailures([]); setFailureCursor(null); setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '重试失败项提交失败');
        throw cause;
      }
      return;
    }
    await submit(pending.operation, pending.payload, pending.ids);
  }, [pending, submit]);

  const loadMoreFailures = useCallback(async () => {
    if (!job || failureCursor === null) return;
    const next = await probeApi.serverBulkFailures(job.jobId, failureCursor);
    setFailures((current) => [...current, ...next.items]); setFailureCursor(next.nextCursor);
  }, [failureCursor, job?.jobId]);

  const clearSelection = useCallback(() => { setSelection(null); setJob(null); setFailures([]); setFailureCursor(null); setPending(null); setError(null); }, []);

  return { selection, job, failures, failureCursor, pending, error, freezeAllMatching, submit, retryPending, retryFailed, loadMoreFailures, clearSelection, refreshSelection, refreshJob };
}
