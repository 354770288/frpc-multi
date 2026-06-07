import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  KeyRound,
  ShieldAlert,
  Terminal,
  Trash2,
  UploadCloud,
  X,
  XCircle
} from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Panel } from '../../components/ui/Panel';
import type { Node, NodeInstall, NodeInstanceHealth, ToastKind } from '../../lib/types';

export type NodeConfirmAction = 'rotate' | 'upgrade' | 'delete';

const EMPTY_HEALTH: NodeInstanceHealth = {
  total: 0,
  running: 0,
  stopped: 0,
  error: 0,
  disabled: 0
};

export function healthOrEmpty(health?: NodeInstanceHealth): NodeInstanceHealth {
  return health || EMPTY_HEALTH;
}

export function StatusBadge({ node }: { node: Node }) {
  if (node.online || node.status === 'online') {
    return (
      <Badge tone="success">
        <CheckCircle2 size={12} />
        在线
      </Badge>
    );
  }
  if (node.status === 'pending') {
    return <Badge tone="warning">待连接</Badge>;
  }
  if (node.status === 'offline' || node.status === 'error') {
    return (
      <Badge tone="danger">
        <XCircle size={12} />
        离线
      </Badge>
    );
  }
  return <Badge tone="muted">未知</Badge>;
}

export function NodeHealthSummary({ health }: { health?: NodeInstanceHealth }) {
  const summary = healthOrEmpty(health);
  return (
    <div className="flex min-w-[180px] flex-wrap items-center gap-1.5">
      <HealthChip label="实例" value={summary.total} />
      <HealthChip label="运行" value={summary.running} tone="success" />
      <HealthChip label="异常" value={summary.error} tone={summary.error ? 'danger' : 'muted'} />
      {summary.disabled > 0 && <HealthChip label="停用" value={summary.disabled} tone="warning" />}
    </div>
  );
}

function HealthChip({
  label,
  value,
  tone = 'muted'
}: {
  label: string;
  value: number;
  tone?: 'success' | 'warning' | 'danger' | 'muted';
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
      : tone === 'warning'
        ? 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]'
        : tone === 'danger'
          ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
          : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]';
  return (
    <span className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] ${toneClass}`}>
      <span>{label}</span>
      <span className="font-mono font-semibold tabular-nums">{value}</span>
    </span>
  );
}

export function OfflineHint({ node }: { node: Node }) {
  if (node.online || node.status === 'online') return null;
  return (
    <div className="mt-1 max-w-[300px] text-[11px] leading-4 text-[var(--color-fg-muted)]">
      运行安装命令后 Agent 会主动连回主控，目标机无需开放入站端口。
    </div>
  );
}

export function ConnectionGuidePanel({ offlineCount }: { offlineCount: number }) {
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Terminal size={14} />
          节点接入模型
        </span>
      }
    >
      <div className="flex flex-col gap-3 text-[12px] leading-5 text-[var(--color-fg-muted)]">
        <p>
          节点由 Agent 在目标机器上出站连接主控。创建节点后先复制安装命令，到目标机运行，状态会从待连接变为在线。
        </p>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
          <div className="text-[11px] text-[var(--color-fg-muted)]">当前未在线节点</div>
          <div className="mt-1 font-mono text-[18px] font-semibold text-[var(--color-fg)] tabular-nums">
            {offlineCount}
          </div>
        </div>
        <p>
          如果安装命令里出现 <code className="font-mono text-[11px] text-[var(--color-fg)]">&lt;主控地址:端口&gt;</code>，
          请替换成 Agent 能访问的主控地址，或配置 <code className="font-mono text-[11px] text-[var(--color-fg)]">CONSOLE_PUBLIC_HOST</code>。
        </p>
        <p>Agent 升级只对在线节点开放；离线节点需要先重新接入或在目标机手动处理。</p>
      </div>
    </Panel>
  );
}

export function InstallPanel({
  nodeName,
  info,
  onClose,
  toast
}: {
  nodeName: string;
  info: NodeInstall;
  onClose: () => void;
  toast: (kind: ToastKind, text: string) => void;
}) {
  async function copy(text: string, label: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        toast('success', `${label}已复制`);
        return;
      } catch {
        // 降级到 execCommand，兼容非安全上下文。
      }
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      toast(ok ? 'success' : 'error', ok ? `${label}已复制` : '复制失败，请手动选择文本复制');
    } catch {
      toast('error', '复制失败，请手动选择文本复制');
    }
  }

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Terminal size={14} />
          安装命令
        </span>
      }
      actions={
        <button
          type="button"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          aria-label="关闭安装命令"
          title="关闭"
        >
          <X size={14} />
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-[var(--color-fg)]">{nodeName}</div>
          <div className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
            在目标机器上运行命令后，Agent 会主动连回主控。
          </div>
        </div>
        {!info.serverConfigured && (
          <div className="flex items-start gap-2 rounded-md bg-[var(--color-warning-soft)] p-2 text-[12px] text-[var(--color-warning)]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              主控未配置对外可达地址，命令里的 <code className="font-mono text-[11px]">{info.server}</code> 需手动替换。
            </span>
          </div>
        )}
        <div className="relative">
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 pr-10 font-mono text-[11px] leading-relaxed text-[var(--color-fg)]">
            {info.installCommand}
          </pre>
          <button
            type="button"
            onClick={() => copy(info.installCommand, '安装命令')}
            className="absolute right-2 top-2 rounded p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            title="复制"
            aria-label="复制安装命令"
          >
            <ClipboardCopy size={14} />
          </button>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
          <MetaItem label="主控地址" value={info.server} />
          <MetaItem label="UUID" value={info.uuid} />
          <MetaItem label="TLS" value={info.tls ? 'wss（已启用）' : 'ws（未启用）'} />
          <MetaItem label="镜像" value={info.image} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => copy(info.installCommand, '安装命令')}>
            <ClipboardCopy size={13} />
            复制命令
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
          密钥会随安装命令展示，请只在可信环境中复制和保存。
        </p>
      </div>
    </Panel>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-[var(--color-fg-muted)]">{label}</span>
      <span className="min-w-0 break-all font-mono text-[var(--color-fg)]">{value}</span>
    </>
  );
}

export function ConfirmNodeAction({
  action,
  node,
  health,
  onCancel,
  onConfirm
}: {
  action: NodeConfirmAction;
  node: Node;
  health?: NodeInstanceHealth;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typedName, setTypedName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const summary = healthOrEmpty(health);
  const meta = useMemo(() => confirmMeta(action), [action]);
  const requiresName = action === 'delete';
  const canConfirm = !requiresName || typedName === node.name;

  useEffect(() => {
    setTypedName('');
  }, [action, node.id]);

  useEffect(() => {
    if (requiresName) inputRef.current?.focus();
  }, [requiresName]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') onCancel();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4 py-6"
      role="presentation"
      onKeyDown={handleKeyDown}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-confirm-title"
        className="w-full max-w-[520px] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
      >
        <header className="flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3">
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${meta.iconClass}`}>
            {meta.icon}
          </span>
          <div className="min-w-0">
            <h2 id="node-confirm-title" className="text-[14px] font-semibold text-[var(--color-fg)]">
              {meta.title}
            </h2>
            <p className="mt-1 text-[12px] leading-5 text-[var(--color-fg-muted)]">
              目标节点：<span className="font-semibold text-[var(--color-fg)]">{node.name}</span>
            </p>
          </div>
        </header>
        <div className="space-y-4 p-4">
          <p className="text-[12px] leading-5 text-[var(--color-fg-muted)]">{meta.description}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <RiskMetric label="实例" value={summary.total} />
            <RiskMetric label="运行" value={summary.running} />
            <RiskMetric label="异常" value={summary.error} />
            <RiskMetric label="停用" value={summary.disabled} />
          </div>
          <ul className="space-y-2 text-[12px] leading-5 text-[var(--color-fg-muted)]">
            {meta.impacts.map((impact) => (
              <li key={impact} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-fg-subtle)]" />
                <span>{impact}</span>
              </li>
            ))}
          </ul>
          {requiresName && (
            <div className="rounded-md border border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] p-3">
              <label className="text-[12px] font-medium text-[var(--color-danger)]">
                输入节点名确认删除
              </label>
              <Input
                ref={inputRef}
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                placeholder={node.name}
                className="mt-2 bg-white"
              />
              <p className="mt-2 text-[11px] leading-4 text-[var(--color-danger)]">
                离线节点删除只会移除主控记录；目标机上的 Agent 和实例容器需要手动清理。
              </p>
            </div>
          )}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3">
          <Button onClick={onCancel}>取消</Button>
          <Button variant={meta.variant} onClick={onConfirm} disabled={!canConfirm}>
            {meta.buttonIcon}
            {meta.confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  );
}

function RiskMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white p-2">
      <div className="text-[10px] text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 font-mono text-[14px] font-semibold text-[var(--color-fg)] tabular-nums">
        {value}
      </div>
    </div>
  );
}

function confirmMeta(action: NodeConfirmAction): {
  title: string;
  description: string;
  confirmLabel: string;
  impacts: string[];
  icon: ReactNode;
  buttonIcon: ReactNode;
  iconClass: string;
  variant: 'danger' | 'primary';
} {
  if (action === 'rotate') {
    return {
      title: '轮换节点密钥',
      description: '轮换后旧 Agent 会失去连接能力，需要用新安装命令重新部署或更新密钥。',
      confirmLabel: '轮换密钥',
      impacts: ['生成新的 Agent secret 并展示新的安装命令。', '旧安装命令里的密钥将不再适用于后续连接。'],
      icon: <KeyRound size={16} />,
      buttonIcon: <KeyRound size={13} />,
      iconClass: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
      variant: 'primary'
    };
  }
  if (action === 'upgrade') {
    return {
      title: '升级 Agent',
      description: '主控会要求在线 Agent 拉取当前镜像标签并重建自身容器，过程中节点会短暂离线。',
      confirmLabel: '发起升级',
      impacts: ['仅在线节点可执行。', '升级期间该节点实例操作可能暂时不可用。'],
      icon: <UploadCloud size={16} />,
      buttonIcon: <UploadCloud size={13} />,
      iconClass: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
      variant: 'primary'
    };
  }
  return {
    title: '删除节点',
    description: '这是破坏性操作。后端会在节点在线时尝试清理实例和 Agent；节点离线时只能删除主控记录。',
    confirmLabel: '删除节点',
    impacts: [
      '该节点下的所有已知 frpc 实例会从主控范围移除。',
      '若 Agent 在线，后端会尝试停止并删除实例容器、配置目录和 Agent 容器。',
      '若 Agent 离线，请到目标机手动清理残留容器和配置目录。'
    ],
    icon: <ShieldAlert size={16} />,
    buttonIcon: <Trash2 size={13} />,
    iconClass: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
    variant: 'danger'
  };
}
