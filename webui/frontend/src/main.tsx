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

function Overview({
  instances,
  onSelect,
  onPage,
  onAction
}: {
  instances: Instance[];
  onSelect: (name: string) => void;
  onPage: (page: Page) => void;
  onAction: (name: string, action: string) => void;
}) {
  const running = instances.filter((item) => item.enabled).length;
  const stopped = instances.length - running;

  return (
    <main className="content">
      <h2>运行摘要 <span>共 {instances.length} 个 frpc 实例</span></h2>
      <section className="metrics">
        <MetricCard icon={<Server size={20} />} title="已启用" value={String(running)} hint="配置已纳入 Compose" />
        <MetricCard icon={<AlertTriangle size={20} />} title="异常" value="0" hint="等待接入实时 Docker 状态" tone="orange" />
        <MetricCard icon={<Square size={20} />} title="未启用" value={String(stopped)} hint="未写入动态运行清单" tone="gray" />
        <MetricCard icon={<RotateCcw size={20} />} title="重启次数" value="--" hint="接入 Docker 后统计" tone="purple" />
        <MetricCard icon={<HardDrive size={20} />} title="内存占用" value="--" hint="docker stats 快照" tone="green" />
        <MetricCard icon={<Cpu size={20} />} title="CPU 占用" value="--" hint="docker stats 快照" />
      </section>

      <section className="dashboard-grid">
        <div className="panel large">
          <div className="panel-head">
            <h3>实例列表</h3>
            <div className="search">
              <Search size={16} />
              <input placeholder="搜索实例名" />
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
              {instances.map((item) => (
                <tr key={item.name}>
                  <td><button className="link" onClick={() => { onSelect(item.name); onPage('detail'); }}>{item.displayName || item.name}</button></td>
                  <td><span className={item.enabled ? 'status ok' : 'status stopped'} />{item.enabled ? '已启用' : '未启用'}</td>
                  <td>--</td>
                  <td>--</td>
                  <td>--</td>
                  <td>{item.configPath}</td>
                  <td className="row-actions">
                    <button onClick={() => onAction(item.name, 'start')}>启动</button>
                    <button onClick={() => onAction(item.name, 'stop')}>停止</button>
                    <button onClick={() => onAction(item.name, 'restart')}>重启</button>
                    <button onClick={() => { onSelect(item.name); onPage('detail'); }}>日志</button>
                    <button onClick={() => { onSelect(item.name); onPage('config'); }}>编辑配置</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="side-stack">
          <div className="panel">
            <h3>健康检查</h3>
            <p className="check ok">实例目录 可读取</p>
            <p className="check ok">配置文件 可读取</p>
            <p className="check">Docker 状态 待连接</p>
          </div>
          <div className="panel">
            <h3>磁盘使用</h3>
            <div className="donut">--</div>
          </div>
          <div className="panel">
            <h3>最近告警</h3>
            <p className="muted">暂无告警</p>
          </div>
        </aside>
      </section>
    </main>
  );
}

function Detail({ name, onPage, onAction }: { name: string; onPage: (page: Page) => void; onAction: (name: string, action: string) => void }) {
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

  return (
    <main className="content">
      <button className="back" onClick={() => onPage('overview')}>返回</button>
      <h2>实例详情：{name}</h2>
      <section className="summary-card">
        <div><span className="status ok" />{detail?.displayName || name}</div>
        <div><small>CPU 占用</small><strong>--</strong></div>
        <div><small>内存占用</small><strong>--</strong></div>
        <div><small>重启次数</small><strong>--</strong></div>
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

function ConfigEditor({ name }: { name: string }) {
  const [configText, setConfigText] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!name) return;
    api<{ configText: string }>(`/api/instances/${name}/config`).then((data) => setConfigText(data.configText)).catch(() => setConfigText(''));
  }, [name]);

  async function save() {
    const result = await api<{ validation: unknown }>(`/api/instances/${name}/config`, {
      method: 'PUT',
      body: JSON.stringify({ configText, backupBeforeSave: true, recreateAfterSave: false })
    });
    setMessage(`保存成功：${JSON.stringify(result.validation)}`);
  }

  if (!name) return <main className="content"><h2>请选择需要编辑的实例</h2></main>;

  return (
    <main className="content">
      <h2>编辑配置：{name} / frpc.toml</h2>
      <section className="editor-layout">
        <div className="panel editor-panel">
          <div className="panel-head">
            <h3>配置内容</h3>
            <button className="primary" onClick={save}><Save size={16} />保存并备份</button>
          </div>
          <textarea value={configText} onChange={(event) => setConfigText(event.target.value)} spellCheck={false} />
        </div>
        <aside className="side-stack">
          <div className="panel success-panel">
            <h3>保存前备份</h3>
            <p>保存配置前会自动创建备份文件。</p>
          </div>
          <div className="panel">
            <h3>校验提示</h3>
            <p className="check ok">TOML 语法</p>
            <p className="check ok">必填字段</p>
            <p className="check">端口占用</p>
            {message && <p className="muted">{message}</p>}
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
  const [selected, setSelected] = useState('');

  async function loadInstances() {
    const data = await api<Instance[]>('/api/instances').catch(() => []);
    setInstances(data);
    if (!selected && data[0]) setSelected(data[0].name);
  }

  useEffect(() => {
    loadInstances();
  }, []);

  async function action(name: string, verb: string) {
    await api(`/api/instances/${name}/${verb}`, { method: 'POST' });
    await loadInstances();
  }

  const body = useMemo(() => {
    if (page === 'overview') return <Overview instances={instances} onSelect={setSelected} onPage={setPage} onAction={action} />;
    if (page === 'detail') return <Detail name={selected} onPage={setPage} onAction={action} />;
    if (page === 'config') return <ConfigEditor name={selected} />;
    if (page === 'create') return <CreateInstance onCreated={(name) => { setSelected(name); loadInstances(); }} />;
    if (page === 'backups') return <Placeholder title="备份管理" />;
    return <Placeholder title="系统设置" />;
  }, [page, instances, selected]);

  return (
    <div className="app-shell">
      <Sidebar page={page} onPage={setPage} />
      <div className="main-shell">
        <Topbar onRefresh={loadInstances} username={auth.username} onLogout={onLogout} />
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
