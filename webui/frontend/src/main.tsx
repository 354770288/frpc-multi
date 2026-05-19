import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Archive,
  Boxes,
  Cpu,
  FileCode2,
  Gauge,
  HardDrive,
  Home,
  LogOut,
  Menu,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Trash2
} from 'lucide-react';
import './styles/app.css';

type Instance = {
  name: string;
  displayName: string;
  enabled: boolean;
  description: string;
  configPath: string;
  createdAt: string;
  updatedAt: string;
};

type InstanceDetail = Instance & {
  summary: {
    serverAddr?: string;
    serverPort?: number;
    authMethod?: string;
    tokenMasked?: string;
    proxyCount: number;
    proxyTypes: Record<string, number>;
    remotePorts: number[];
  };
  warnings: string[];
  errors: string[];
};

type InstanceStats = {
  service: string;
  containerName: string;
  containerId: string;
  state: string;
  status: string;
  health: string;
  exitCode: number | null;
  cpuPercent: string;
  memUsage: string;
  memPercent: string;
  netIO: string;
  blockIO: string;
  pids: string;
  restartCount: number;
};

type StatsMap = Record<string, InstanceStats>;

type StatsResponse = {
  available: boolean;
  error: string;
  containers: StatsMap;
};

type SystemInfo = {
  projectDir: string;
  webuiHost: string;
  webuiPort: number;
  version: string;
  disk: { total: number; used: number; free: number };
};

type Page = 'overview' | 'detail' | 'config' | 'create' | 'backups' | 'system';

type AuthState = {
  token: string;
  username: string;
  expiresAt: number;
};

const TOKEN_STORAGE_KEY = 'frpc-webui-auth';

const emptyConfig = `serverAddr = "frps.example.com"
serverPort = 7000

[auth]
method = "token"
token = "CHANGE_ME_STRONG_TOKEN"

[log]
to = "console"
level = "info"
maxDays = 3

[[proxies]]
name = "ssh-22"
type = "tcp"
localIP = "host.docker.internal"
localPort = 22
remotePort = 6001
`;

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

function loadAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as AuthState;
    if (!data.token || !data.expiresAt) return null;
    if (data.expiresAt * 1000 <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function saveAuth(state: AuthState) {
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(state));
}

function clearAuth() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

let onUnauthorized: () => void = () => {};
let currentToken: string | null = null;

function setAuthToken(token: string | null) {
  currentToken = token;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) || {})
  };
  if (currentToken) {
    headers.Authorization = `Bearer ${currentToken}`;
  }
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    onUnauthorized();
    throw new AuthError('登录已过期，请重新登录');
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

function Login({ onSuccess }: { onSuccess: (state: AuthState) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!username || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setLoading(true);
    try {
      const result = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (!result.ok) {
        const text = await result.text();
        let detail = '登录失败';
        try {
          const data = JSON.parse(text);
          if (typeof data?.detail === 'string') detail = data.detail;
        } catch {
          if (text) detail = text;
        }
        throw new Error(detail);
      }
      const data = (await result.json()) as { token: string; username: string; expiresAt: number };
      onSuccess({ token: data.token, username: data.username, expiresAt: data.expiresAt });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <Boxes size={32} />
          <div>
            <strong>frpc 多实例管理</strong>
            <span>WebUI 控制台登录</span>
          </div>
        </div>
        <label>用户名</label>
        <input
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="admin"
        />
        <label>密码</label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="请输入密码"
        />
        {error && <p className="login-error">{error}</p>}
        <button className="primary" type="submit" disabled={loading}>
          <ShieldCheck size={16} />
          {loading ? '登录中...' : '登录'}
        </button>
        <p className="login-hint">默认凭证由 .env 中的 WEBUI_USERNAME / WEBUI_PASSWORD 控制。</p>
      </form>
    </div>
  );
}

function Sidebar({ page, onPage }: { page: Page; onPage: (page: Page) => void }) {
  const items = [
    ['overview', Home, '总览'],
    ['create', Plus, '创建实例'],
    ['config', FileCode2, '配置'],
    ['backups', Archive, '备份'],
    ['system', Settings, '系统']
  ] as const;

  return (
    <aside className="sidebar">
      <div className="brand">
        <Boxes size={26} />
        <strong>frpc 多实例管理</strong>
      </div>
      <nav>
        {items.map(([key, Icon, label]) => (
          <button className={page === key ? 'active' : ''} key={key} onClick={() => onPage(key)}>
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="system-card">
        <strong>系统信息</strong>
        <p>主机名 vps-node-01</p>
        <p>系统 Debian / Ubuntu</p>
        <p>面板端口 8081</p>
        <p>项目目录 /opt/frpc-multi</p>
      </div>
    </aside>
  );
}

function Topbar({ onRefresh, username, onLogout }: { onRefresh: () => void; username: string; onLogout: () => void }) {
  return (
    <header className="topbar">
      <button className="icon-button">
        <Menu size={18} />
      </button>
      <div className="crumb">控制台 / frpc WebUI</div>
      <div className="top-actions">
        <button onClick={onRefresh}>
          <RefreshCw size={16} />
          刷新
        </button>
        <span className="avatar">{username || 'admin'}</span>
        <button onClick={onLogout} title="退出登录">
          <LogOut size={16} />
          退出
        </button>
      </div>
    </header>
  );
}

function MetricCard({ icon, title, value, hint, tone = 'blue' }: { icon: React.ReactNode; title: string; value: string; hint: string; tone?: string }) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{hint}</p>
      <div className={`bar ${tone}`} />
    </div>
  );
}

function parsePercent(value: string): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value.replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function instanceStateLabel(stat: InstanceStats | undefined, enabled: boolean): { label: string; cls: string } {
  if (!stat || !stat.state) return { label: enabled ? '未运行' : '未启用', cls: 'status stopped' };
  const state = stat.state;
  if (state === 'running') return { label: '运行中', cls: 'status ok' };
  if (state === 'restarting') return { label: '重启中', cls: 'status' };
  if (state === 'paused') return { label: '已暂停', cls: 'status' };
  if (state === 'exited' || state === 'dead') {
    if (stat.exitCode !== null && stat.exitCode !== 0) {
      return { label: `异常退出 (${stat.exitCode})`, cls: 'status' };
    }
    return { label: '已停止', cls: 'status stopped' };
  }
  return { label: stat.status || state, cls: 'status' };
}

function bytesToHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

function Overview({
  instances,
  stats,
  dockerAvailable,
  dockerError,
  system,
  onSelect,
  onPage,
  onAction
}: {
  instances: Instance[];
  stats: StatsMap;
  dockerAvailable: boolean;
  dockerError: string;
  system: SystemInfo | null;
  onSelect: (name: string) => void;
  onPage: (page: Page) => void;
  onAction: (name: string, action: string) => void;
}) {
  const [keyword, setKeyword] = useState('');

  let running = 0;
  let stopped = 0;
  let error = 0;
  let restartTotal = 0;
  let cpuTotal = 0;
  let memTotal = 0;
  let cpuSamples = 0;
  let memSamples = 0;
  for (const item of instances) {
    const stat = stats[item.name];
    const state = stat?.state || '';
    if (state === 'running') running += 1;
    else if ((state === 'exited' || state === 'dead') && stat?.exitCode && stat.exitCode !== 0) error += 1;
    else stopped += 1;
    restartTotal += stat?.restartCount || 0;
    if (stat?.cpuPercent) {
      cpuTotal += parsePercent(stat.cpuPercent);
      cpuSamples += 1;
    }
    if (stat?.memPercent) {
      memTotal += parsePercent(stat.memPercent);
      memSamples += 1;
    }
  }

  const lower = keyword.toLowerCase();
  const filtered = lower
    ? instances.filter((item) =>
        item.name.toLowerCase().includes(lower) || (item.displayName || '').toLowerCase().includes(lower)
      )
    : instances;

  const diskRatio = system && system.disk.total > 0 ? (system.disk.used / system.disk.total) * 100 : 0;

  return (
    <main className="content">
      <h2>运行摘要 <span>共 {instances.length} 个 frpc 实例</span></h2>
      <section className="metrics">
        <MetricCard icon={<Server size={20} />} title="运行中" value={String(running)} hint="docker compose ps 状态" />
        <MetricCard icon={<AlertTriangle size={20} />} title="异常" value={String(error)} hint="exited 且 exitCode 非 0" tone="orange" />
        <MetricCard icon={<Square size={20} />} title="已停止" value={String(stopped)} hint="未运行的实例数" tone="gray" />
        <MetricCard icon={<RotateCcw size={20} />} title="累计重启" value={String(restartTotal)} hint="docker inspect 中 RestartCount 累加" tone="purple" />
        <MetricCard
          icon={<HardDrive size={20} />}
          title="内存占用"
          value={memSamples ? `${memTotal.toFixed(1)}%` : '0%'}
          hint={memSamples ? `${memSamples} 个容器汇总` : '暂无运行容器'}
          tone="green"
        />
        <MetricCard
          icon={<Cpu size={20} />}
          title="CPU 占用"
          value={cpuSamples ? `${cpuTotal.toFixed(1)}%` : '0%'}
          hint={cpuSamples ? `${cpuSamples} 个容器汇总` : '暂无运行容器'}
        />
      </section>

      <section className="dashboard-grid">
        <div className="panel large">
          <div className="panel-head">
            <h3>实例列表</h3>
            <div className="search">
              <Search size={16} />
              <input
                placeholder="搜索实例名"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>实例名</th>
                <th>状态</th>
                <th>CPU</th>
                <th>内存</th>
                <th>重启次数</th>
                <th>配置路径</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const stat = stats[item.name];
                const { label, cls } = instanceStateLabel(stat, item.enabled);
                return (
                  <tr key={item.name}>
                    <td>
                      <button className="link" onClick={() => { onSelect(item.name); onPage('detail'); }}>
                        {item.displayName || item.name}
                      </button>
                    </td>
                    <td><span className={cls} />{label}</td>
                    <td>{stat?.cpuPercent || '--'}</td>
                    <td>{stat?.memUsage || '--'}</td>
                    <td>{stat ? stat.restartCount : '--'}</td>
                    <td>{item.configPath}</td>
                    <td className="row-actions">
                      <button onClick={() => onAction(item.name, 'start')}>启动</button>
                      <button onClick={() => onAction(item.name, 'stop')}>停止</button>
                      <button onClick={() => onAction(item.name, 'restart')}>重启</button>
                      <button onClick={() => { onSelect(item.name); onPage('detail'); }}>日志</button>
                      <button onClick={() => { onSelect(item.name); onPage('config'); }}>编辑配置</button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">没有匹配的实例</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <aside className="side-stack">
          <div className="panel">
            <h3>健康检查</h3>
            <p className="check ok">实例目录 可读取</p>
            <p className="check ok">配置文件 可读取</p>
            <p className={dockerAvailable ? 'check ok' : 'check'}>
              Docker 状态 {dockerAvailable ? '已连接' : '未连接'}
            </p>
            {!dockerAvailable && dockerError && (
              <p className="muted" style={{ marginTop: 4 }}>{dockerError}</p>
            )}
          </div>
          <div className="panel">
            <h3>磁盘使用</h3>
            {system ? (
              <>
                <div className="donut">{diskRatio.toFixed(0)}%</div>
                <p className="muted">
                  已用 {bytesToHuman(system.disk.used)} / 总 {bytesToHuman(system.disk.total)}
                </p>
              </>
            ) : (
              <div className="donut">--</div>
            )}
          </div>
          <div className="panel">
            <h3>最近告警</h3>
            {error > 0 ? (
              <p className="check">检测到 {error} 个实例异常退出</p>
            ) : (
              <p className="muted">暂无告警</p>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}

function Detail({
  name,
  stats,
  onPage,
  onAction
}: {
  name: string;
  stats: StatsMap;
  onPage: (page: Page) => void;
  onAction: (name: string, action: string) => void;
}) {
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    if (!name) return;
    api<InstanceDetail>(`/api/instances/${name}`).then(setDetail).catch(console.error);
    api<{ lines: string[] }>(`/api/instances/${name}/logs?tail=300`).then((data) => setLogs(data.lines)).catch(() => setLogs([]));
  }, [name]);

  if (!name) return <main className="content"><h2>请选择实例</h2></main>;

  const visibleLogs = keyword ? logs.filter((line) => line.toLowerCase().includes(keyword.toLowerCase())) : logs;
  const stat = stats[name];
  const stateInfo = instanceStateLabel(stat, detail?.enabled ?? false);

  return (
    <main className="content">
      <button className="back" onClick={() => onPage('overview')}>返回</button>
      <h2>实例详情：{name} <span>{stateInfo.label}</span></h2>
      <section className="summary-card">
        <div><span className={stateInfo.cls} />{detail?.displayName || name}</div>
        <div><small>CPU 占用</small><strong>{stat?.cpuPercent || '--'}</strong></div>
        <div><small>内存占用</small><strong>{stat?.memUsage || '--'}</strong></div>
        <div><small>重启次数</small><strong>{stat ? stat.restartCount : '--'}</strong></div>
        <div><small>配置路径</small><strong>{detail?.configPath || '--'}</strong></div>
      </section>

      <section className="detail-grid">
        <div className="panel log-panel">
          <div className="panel-head">
            <h3>最近日志</h3>
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索日志内容" />
          </div>
          <pre>{visibleLogs.length ? visibleLogs.join('\n') : '暂无日志或 Docker 未连接'}</pre>
        </div>
        <div className="panel actions-panel">
          <h3>操作区</h3>
          <button className="primary" onClick={() => onAction(name, 'start')}><Play size={16} />启动</button>
          <button onClick={() => onAction(name, 'stop')}><Square size={16} />停止</button>
          <button onClick={() => onAction(name, 'restart')}><RefreshCw size={16} />重启</button>
          <button onClick={() => onAction(name, 'recreate')}><RotateCcw size={16} />重新创建容器</button>
          <button onClick={() => api(`/api/instances/${name}/config/backup`, { method: 'POST' })}><Archive size={16} />备份配置</button>
        </div>
      </section>

      <section className="panel">
        <h3>配置摘要</h3>
        <div className="summary-table">
          <span>服务端地址</span><strong>{detail?.summary.serverAddr || '--'}</strong>
          <span>服务端端口</span><strong>{detail?.summary.serverPort || '--'}</strong>
          <span>认证方式</span><strong>{detail?.summary.authMethod || '--'}</strong>
          <span>代理数量</span><strong>{detail?.summary.proxyCount ?? '--'}</strong>
        </div>
      </section>
    </main>
  );
}

type ValidationData = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    serverAddr?: string;
    serverPort?: number;
    authMethod?: string;
    tokenMasked?: string;
    proxyCount: number;
    proxyTypes: Record<string, number>;
    remotePorts: number[];
  };
};

type BackupItem = {
  id: string;
  instance: string;
  path: string;
  size: number;
  mtime: number;
};

function formatBackupTime(mtime: number): string {
  const date = new Date(mtime * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function ConfigEditor({ name }: { name: string }) {
  const [configText, setConfigText] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [validation, setValidation] = useState<ValidationData | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recreateAfterSave, setRecreateAfterSave] = useState(false);
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [backups, setBackups] = useState<BackupItem[]>([]);

  async function loadBackups() {
    if (!name) return;
    const data = await api<BackupItem[]>(`/api/backups?instance=${encodeURIComponent(name)}`).catch(() => []);
    setBackups(data);
  }

  useEffect(() => {
    if (!name) return;
    setMessage('');
    setErrorMessage('');
    api<{ configText: string; validation: ValidationData }>(`/api/instances/${name}/config`)
      .then((data) => {
        setConfigText(data.configText);
        setOriginalText(data.configText);
        setValidation(data.validation);
      })
      .catch(() => {
        setConfigText('');
        setOriginalText('');
        setValidation(null);
      });
    loadBackups();
  }, [name]);

  useEffect(() => {
    if (!name) return;
    if (configText === originalText && validation) return;
    const handle = window.setTimeout(async () => {
      setValidating(true);
      try {
        const result = await api<ValidationData>(`/api/instances/${name}/config/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: configText
        });
        setValidation(result);
      } catch {
        // 校验失败不致命
      } finally {
        setValidating(false);
      }
    }, 500);
    return () => window.clearTimeout(handle);
  }, [name, configText, originalText]);

  const dirty = configText !== originalText;

  async function save() {
    setSaving(true);
    setMessage('');
    setErrorMessage('');
    try {
      await api<{ validation: ValidationData }>(`/api/instances/${name}/config`, {
        method: 'PUT',
        body: JSON.stringify({ configText, backupBeforeSave: true, recreateAfterSave })
      });
      setOriginalText(configText);
      setMessage(recreateAfterSave ? '已保存并重新创建容器' : '已保存（已自动备份原配置）');
      await loadBackups();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setConfigText(originalText);
    setMessage('');
    setErrorMessage('');
  }

  async function backupNow() {
    setMessage('');
    setErrorMessage('');
    try {
      await api(`/api/instances/${name}/config/backup`, { method: 'POST' });
      setMessage('已创建一份配置备份');
      await loadBackups();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '备份失败');
    }
  }

  async function restore(backup: BackupItem) {
    if (!window.confirm(`确认用 ${backup.id} 还原当前配置？当前内容会先被自动备份。`)) return;
    setMessage('');
    setErrorMessage('');
    try {
      await api(`/api/instances/${name}/config/restore`, {
        method: 'POST',
        body: JSON.stringify({ backupId: backup.id, recreateAfterRestore: false })
      });
      const data = await api<{ configText: string; validation: ValidationData }>(`/api/instances/${name}/config`);
      setConfigText(data.configText);
      setOriginalText(data.configText);
      setValidation(data.validation);
      setMessage(`已从 ${backup.id} 还原`);
      await loadBackups();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '还原失败');
    }
  }

  async function removeBackup(backup: BackupItem) {
    if (!window.confirm(`确认删除备份 ${backup.id}？该操作不可恢复。`)) return;
    setMessage('');
    setErrorMessage('');
    try {
      await api(`/api/backups/${encodeURI(backup.id)}`, { method: 'DELETE' });
      await loadBackups();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '删除失败');
    }
  }

  if (!name) return <main className="content"><h2>请选择需要编辑的实例</h2></main>;

  const errors = validation?.errors || [];
  const warnings = validation?.warnings || [];
  const summary = validation?.summary;

  return (
    <main className="content">
      <h2>
        编辑配置：{name} / frpc.toml{' '}
        <span>{validating ? '校验中…' : dirty ? '未保存' : '已同步'}</span>
      </h2>
      <section className="editor-layout">
        <div className="panel editor-panel">
          <div className="panel-head">
            <h3>配置内容</h3>
            <div className="row-actions">
              <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={recreateAfterSave}
                  onChange={(event) => setRecreateAfterSave(event.target.checked)}
                  style={{ width: 'auto' }}
                />
                保存后重新创建容器
              </label>
              <button onClick={reset} disabled={!dirty || saving}>
                <RotateCcw size={16} />重置
              </button>
              <button onClick={backupNow} disabled={saving}>
                <Archive size={16} />立即备份
              </button>
              <button
                className="primary"
                onClick={save}
                disabled={!dirty || saving || !!errors.length}
              >
                <Save size={16} />{saving ? '保存中…' : '保存并备份'}
              </button>
            </div>
          </div>
          <textarea
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
            spellCheck={false}
          />
          {message && <p className="check ok">{message}</p>}
          {errorMessage && <p className="login-error">{errorMessage}</p>}
        </div>
        <aside className="side-stack">
          <div className={errors.length ? 'panel' : 'panel success-panel'}>
            <h3>校验结果</h3>
            {!validation ? (
              <p className="muted">等待校验…</p>
            ) : errors.length === 0 ? (
              <p className="check ok">配置合法，可保存</p>
            ) : (
              errors.map((item, index) => (
                <p key={`err-${index}`} className="login-error" style={{ marginTop: 6 }}>{item}</p>
              ))
            )}
            {warnings.map((item, index) => (
              <p key={`warn-${index}`} className="check" style={{ color: '#a96400' }}>⚠ {item}</p>
            ))}
          </div>
          {summary && (
            <div className="panel">
              <h3>配置摘要</h3>
              <div className="summary-table">
                <span>服务端</span><strong>{summary.serverAddr || '--'}</strong>
                <span>端口</span><strong>{summary.serverPort ?? '--'}</strong>
                <span>认证方式</span><strong>{summary.authMethod || '--'}</strong>
                <span>代理数量</span><strong>{summary.proxyCount}</strong>
              </div>
            </div>
          )}
          <div className="panel">
            <h3>历史备份 <span className="muted">({backups.length})</span></h3>
            {backups.length === 0 ? (
              <p className="muted">暂无备份</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                {backups.map((backup) => (
                  <li key={backup.id} style={{ borderBottom: '1px solid #edf2f7', paddingBottom: 8 }}>
                    <div style={{ fontFamily: 'SFMono-Regular, Consolas, monospace', fontSize: 12 }}>
                      {backup.id}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {formatBackupTime(backup.mtime)} · {(backup.size / 1024).toFixed(1)} KB
                    </div>
                    <div className="row-actions" style={{ marginTop: 6 }}>
                      <button onClick={() => restore(backup)}>还原</button>
                      <button onClick={() => removeBackup(backup)}>
                        <Trash2 size={14} />删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}

function CreateInstance({ onCreated }: { onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [configText, setConfigText] = useState(emptyConfig);
  const [message, setMessage] = useState('');

  async function create() {
    await api('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ name, displayName, configText, enabled: true, startAfterCreate: false })
    });
    setMessage('实例创建成功，已生成配置和动态 Compose。');
    onCreated(name);
  }

  return (
    <main className="content">
      <h2>创建 frpc 实例</h2>
      <section className="editor-layout">
        <div className="panel create-panel">
          <label>实例名</label>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="client-001" />
          <label>显示名称</label>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="家里 NAS" />
          <label>frpc.toml</label>
          <textarea value={configText} onChange={(event) => setConfigText(event.target.value)} spellCheck={false} />
          <button className="primary" onClick={create}><Plus size={16} />创建实例</button>
          {message && <p className="muted">{message}</p>}
        </div>
        <aside className="side-stack">
          <div className="panel">
            <h3>创建后会自动完成</h3>
            <p className="check ok">写入 instances/name/frpc.toml</p>
            <p className="check ok">写入 meta.json</p>
            <p className="check ok">重新生成 compose.generated.yaml</p>
          </div>
        </aside>
      </section>
    </main>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <main className="content">
      <h2>{title}</h2>
      <div className="panel">
        <p className="muted">第一版先实现核心实例管理；该页面会继续补充。</p>
      </div>
    </main>
  );
}

function Console({ auth, onLogout }: { auth: AuthState; onLogout: () => void }) {
  const [page, setPage] = useState<Page>('overview');
  const [instances, setInstances] = useState<Instance[]>([]);
  const [stats, setStats] = useState<StatsMap>({});
  const [dockerAvailable, setDockerAvailable] = useState(false);
  const [dockerError, setDockerError] = useState('');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [selected, setSelected] = useState('');

  async function loadInstances() {
    const data = await api<Instance[]>('/api/instances').catch(() => []);
    setInstances(data);
    if (!selected && data[0]) setSelected(data[0].name);
  }

  async function loadStats() {
    try {
      const data = await api<StatsResponse>('/api/stats');
      setStats(data.containers || {});
      setDockerAvailable(!!data.available);
      setDockerError(data.error || '');
    } catch {
      setStats({});
      setDockerAvailable(false);
      setDockerError('无法访问 /api/stats');
    }
  }

  async function loadSystem() {
    const data = await api<SystemInfo>('/api/system').catch(() => null);
    setSystem(data);
  }

  async function refreshAll() {
    await Promise.all([loadInstances(), loadStats(), loadSystem()]);
  }

  useEffect(() => {
    refreshAll();
    const timer = window.setInterval(loadStats, 5000);
    return () => window.clearInterval(timer);
  }, []);

  async function action(name: string, verb: string) {
    await api(`/api/instances/${name}/${verb}`, { method: 'POST' });
    await Promise.all([loadInstances(), loadStats()]);
  }

  const body = useMemo(() => {
    if (page === 'overview') return <Overview instances={instances} stats={stats} dockerAvailable={dockerAvailable} dockerError={dockerError} system={system} onSelect={setSelected} onPage={setPage} onAction={action} />;
    if (page === 'detail') return <Detail name={selected} stats={stats} onPage={setPage} onAction={action} />;
    if (page === 'config') return <ConfigEditor name={selected} />;
    if (page === 'create') return <CreateInstance onCreated={(name) => { setSelected(name); refreshAll(); }} />;
    if (page === 'backups') return <Placeholder title="备份管理" />;
    return <Placeholder title="系统设置" />;
  }, [page, instances, stats, dockerAvailable, dockerError, system, selected]);

  return (
    <div className="app-shell">
      <Sidebar page={page} onPage={setPage} />
      <div className="main-shell">
        <Topbar onRefresh={refreshAll} username={auth.username} onLogout={onLogout} />
        {body}
      </div>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const cached = loadAuth();
    if (cached) setAuthToken(cached.token);
    return cached;
  });

  useEffect(() => {
    onUnauthorized = () => {
      clearAuth();
      setAuthToken(null);
      setAuth(null);
    };
    return () => {
      onUnauthorized = () => {};
    };
  }, []);

  function handleLogin(state: AuthState) {
    saveAuth(state);
    setAuthToken(state.token);
    setAuth(state);
  }

  function handleLogout() {
    clearAuth();
    setAuthToken(null);
    setAuth(null);
  }

  if (!auth) {
    return <Login onSuccess={handleLogin} />;
  }
  return <Console auth={auth} onLogout={handleLogout} />;
}

createRoot(document.getElementById('root')!).render(<App />);
