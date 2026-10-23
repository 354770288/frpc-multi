import { useCallback, useEffect, useRef, useState } from 'react';
import { probeApi } from '../../lib/api';
import type { ServerImportFailure, ServerImportJob } from '../../lib/types';

const JOB_KEY = 'probe_server_import_job';
const PENDING_KEY = 'probe_server_import_pending';
const RETRY_KEY = 'probe_server_import_retry';
const POLL_MS = 1000;
const FAILURE_LIMIT = 100;
export type PendingServerImport = { text: string; group?: string; idempotencyKey: string };
type PendingRetry = { jobId: string; idempotencyKey: string };

function readSession<T>(key: string): T | null {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as T | null; }
  catch { return null; }
}

function persistSession<T>(key: string, value: T | null): boolean {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

function saveJob(job: ServerImportJob | null) { persistSession(JOB_KEY, job); }
const isTerminal = (state: ServerImportJob['state']) => ['done', 'partial', 'failed'].includes(state);
const isActive = (job: ServerImportJob | null) => !!job && ['queued', 'running'].includes(job.state);

export function useServerImport(onCompleted?: () => void) {
  const [job, setJob] = useState<ServerImportJob | null>(() => readSession(JOB_KEY));
  const [pendingRequest, setPendingRequest] = useState<PendingServerImport | null>(() => readSession(PENDING_KEY));
  const [pendingRetry, setPendingRetry] = useState<PendingRetry | null>(() => readSession(RETRY_KEY));
  const [failures, setFailures] = useState<ServerImportFailure[]>([]);
  const [failureCursor, setFailureCursor] = useState<string | null>(null);
  const [loadingFailuresJob, setLoadingFailuresJob] = useState<string | null>(null);
  const [failureLoadError, setFailureLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionLock = useRef(false);
  const retryLock = useRef(false);
  const pollLocks = useRef(new Set<string>());
  const failureLocks = useRef(new Set<string>());
  const callbackRef = useRef(onCompleted);
  callbackRef.current = onCompleted;
  const currentJobId = useRef(job?.jobId ?? null);
  const completedJob = useRef<string | null>(null);
  const failuresJob = useRef<string | null>(null);

  const savePendingRequest = useCallback((request: PendingServerImport | null) => {
    if (!persistSession(PENDING_KEY, request)) return false;
    setPendingRequest(request);
    return true;
  }, []);
  const savePendingRetry = useCallback((retry: PendingRetry | null) => {
    if (!persistSession(RETRY_KEY, retry)) return false;
    setPendingRetry(retry);
    return true;
  }, []);

  useEffect(() => { saveJob(job); }, [job]);

  const refreshJob = useCallback(async () => {
    if (!job) return;
    const requestedJobId = job.jobId;
    if (pollLocks.current.has(requestedJobId)) return;
    pollLocks.current.add(requestedJobId);
    try {
      const next = await probeApi.serverImportJob(requestedJobId);
      if (currentJobId.current !== requestedJobId) return;
      saveJob(next);
      setJob(next);
      setError(null);
      if (isTerminal(next.state) && completedJob.current !== next.jobId) {
        completedJob.current = next.jobId;
        callbackRef.current?.();
      }
    } catch (cause) {
      if (currentJobId.current === requestedJobId) setError(cause instanceof Error ? cause.message : '导入任务状态读取失败');
    } finally { pollLocks.current.delete(requestedJobId); }
  }, [job?.jobId]);

  useEffect(() => {
    if (job) void refreshJob();
  }, [job?.jobId, refreshJob]);

  useEffect(() => {
    if (!isActive(job)) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshJob();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [job?.jobId, job?.state, refreshJob]);

  const loadFailures = useCallback(async (append = false) => {
    if (!job || !isTerminal(job.state) || (append && failureCursor === null)) return;
    const requestedJobId = job.jobId;
    if (failureLocks.current.has(requestedJobId)) return;
    failureLocks.current.add(requestedJobId);
    setLoadingFailuresJob(requestedJobId);
    try {
      const page = await probeApi.serverImportFailures(requestedJobId, append ? failureCursor ?? undefined : undefined, FAILURE_LIMIT);
      if (currentJobId.current !== requestedJobId) return;
      setFailures((current) => append ? [...current, ...page.items] : page.items);
      setFailureCursor(page.nextCursor);
      failuresJob.current = job.jobId;
      setFailureLoadError(null);
      setError(null);
    } catch (cause) {
      if (currentJobId.current === requestedJobId) setFailureLoadError(cause instanceof Error ? cause.message : '失败明细读取失败');
    } finally {
      failureLocks.current.delete(requestedJobId);
      setLoadingFailuresJob((current) => current === requestedJobId ? null : current);
    }
  }, [job?.jobId, job?.state, failureCursor]);

  useEffect(() => {
    if (!job || !isTerminal(job.state) || !job.failed || failuresJob.current === job.jobId) return;
    void loadFailures();
  }, [job?.jobId, job?.state, job?.failed, loadFailures]);

  const acceptJob = useCallback((next: ServerImportJob) => {
    currentJobId.current = next.jobId;
    saveJob(next);
    setJob(next);
    setFailures([]);
    setFailureCursor(null);
    setFailureLoadError(null);
    failuresJob.current = null;
    completedJob.current = null;
  }, []);

  const submit = useCallback(async (text: string, group?: string) => {
    if (submissionLock.current || isActive(job) || pendingRequest || pendingRetry) return;
    submissionLock.current = true;
    setSubmitting(true);
    const request = { text, ...(group ? { group } : {}), idempotencyKey: crypto.randomUUID() };
    if (!savePendingRequest(request)) {
      submissionLock.current = false;
      setSubmitting(false);
      setError('无法保存待提交内容，请检查当前浏览器会话存储空间后重试');
      throw new Error('无法保存待提交内容，请检查当前浏览器会话存储空间后重试');
    }
    setError(null);
    try {
      const next = await probeApi.createServerImportJob(request);
      savePendingRequest(null);
      acceptJob(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交导入任务失败');
      throw cause;
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  }, [acceptJob, job?.jobId, job?.state, pendingRequest, pendingRetry, savePendingRequest]);

  const retrySubmit = useCallback(async () => {
    const request = pendingRequest;
    if (!request || submissionLock.current || isActive(job) || pendingRetry) return;
    submissionLock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const next = await probeApi.createServerImportJob(request);
      savePendingRequest(null);
      acceptJob(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交导入任务失败');
      throw cause;
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  }, [acceptJob, job?.jobId, job?.state, pendingRequest, pendingRetry, savePendingRequest]);

  const retryFailed = useCallback(async () => {
    if (!job || !isTerminal(job.state) || !job.retryableFailed || job.retryableFailed <= 0 || retryLock.current || pendingRequest || (pendingRetry && pendingRetry.jobId !== job.jobId)) return;
    retryLock.current = true;
    setRetrying(true);
    setError(null);
    const request = pendingRetry?.jobId === job.jobId ? pendingRetry : { jobId: job.jobId, idempotencyKey: crypto.randomUUID() };
    if (!pendingRetry || pendingRetry.jobId !== job.jobId) {
      if (!savePendingRetry(request)) {
        retryLock.current = false;
        setRetrying(false);
        setError('无法保存失败项重试请求，请检查当前浏览器会话存储空间后重试');
        return;
      }
    }
    try {
      const next = await probeApi.retryServerImportFailures(request.jobId, request.idempotencyKey);
      savePendingRetry(null);
      acceptJob(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重试失败项提交失败');
    } finally {
      retryLock.current = false;
      setRetrying(false);
    }
  }, [acceptJob, job?.jobId, job?.state, job?.retryableFailed, pendingRequest, pendingRetry, savePendingRetry]);

  const clearJob = useCallback(() => {
    if (pendingRequest || pendingRetry) return;
    currentJobId.current = null;
    setJob(null);
    setFailures([]);
    setFailureCursor(null);
    setFailureLoadError(null);
    setError(null);
    failuresJob.current = null;
    completedJob.current = null;
    saveJob(null);
  }, [pendingRequest, pendingRetry]);

  return {
    job, failures, failureCursor, loadingFailures: loadingFailuresJob === job?.jobId, failureLoadError, submitting, retrying, error,
    pendingRequest, pendingRetry, hasPendingSubmission: !!pendingRequest, hasPendingRetry: !!pendingRetry,
    unresolvedRequest: !!pendingRequest || !!pendingRetry,
    submit, retrySubmit, retryFailed, retryLoadFailures: () => loadFailures(failures.length > 0), loadMoreFailures: () => loadFailures(true), refreshJob, clearJob,
    isActive: isActive(job), canStartNew: !isActive(job) && !pendingRequest && !pendingRetry,
  };
}
