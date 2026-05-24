// Minimal TOML helpers focused on frpc's `[[proxies]]` blocks.
// We deliberately avoid a full TOML library: only proxy arrays of tables
// need round-tripping. Top-level config is preserved verbatim.

export type ProxyDraft = {
  name: string;
  type: string;
  localIP: string;
  localPort: string;
  remotePort: string;
  subdomain: string;
  customDomains: string;
};

export const PROXY_TYPES = ['tcp', 'udp', 'http', 'https', 'stcp', 'xtcp'] as const;

const STRING_FIELDS = new Set([
  'name',
  'type',
  'localIP',
  'subdomain',
  'serverName'
]);

const ARRAY_FIELDS = new Set(['customDomains']);

const INT_FIELDS = new Set(['localPort', 'remotePort']);

const PROXY_BLOCK_RE = /^\s*\[\[proxies\]\]\s*$/;

export function createEmptyProxy(): ProxyDraft {
  return {
    name: '',
    type: 'tcp',
    localIP: '127.0.0.1',
    localPort: '',
    remotePort: '',
    subdomain: '',
    customDomains: ''
  };
}

/**
 * Split a TOML document at the first `[[proxies]]` line. Everything before
 * the line is preserved as the "preface"; everything from the line on is the
 * proxies section we will rewrite.
 */
export function splitTomlAtProxies(text: string): { preface: string; proxiesBody: string } {
  const lines = text.split(/\r?\n/);
  let cutAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (PROXY_BLOCK_RE.test(lines[i])) {
      cutAt = i;
      break;
    }
  }
  const preface = lines.slice(0, cutAt).join('\n');
  const proxiesBody = lines.slice(cutAt).join('\n');
  return { preface, proxiesBody };
}

/**
 * Parse the proxies portion of a frpc.toml file into a list of editable drafts.
 * Handles the common subset of fields (strings, integers, simple string arrays)
 * and silently ignores fields outside that subset (they are still preserved in
 * raw mode; the structured editor only round-trips known keys).
 */
export function parseProxies(proxiesBody: string): ProxyDraft[] {
  if (!proxiesBody.trim()) return [];
  const lines = proxiesBody.split(/\r?\n/);
  const drafts: ProxyDraft[] = [];
  let current: ProxyDraft | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (PROXY_BLOCK_RE.test(raw)) {
      current = createEmptyProxy();
      drafts.push(current);
      continue;
    }
    if (line.startsWith('[')) {
      // Some other table header (e.g. `[proxies.metas]`) – stop populating.
      current = null;
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const valueRaw = line.slice(eq + 1).trim();
    if (STRING_FIELDS.has(key)) {
      (current as Record<string, string>)[key] = parseTomlString(valueRaw);
    } else if (INT_FIELDS.has(key)) {
      const parsed = parseTomlInt(valueRaw);
      (current as Record<string, string>)[key] = parsed === null ? '' : String(parsed);
    } else if (ARRAY_FIELDS.has(key)) {
      (current as Record<string, string>)[key] = parseTomlStringArray(valueRaw).join(', ');
    }
  }
  return drafts;
}

/**
 * Serialize proxy drafts back into TOML. Only known fields are emitted; empty
 * fields are skipped. Drops invalid proxies (no name) silently — the caller
 * should validate first.
 */
export function serializeProxies(drafts: ProxyDraft[]): string {
  if (drafts.length === 0) return '';
  const blocks: string[] = [];
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) continue;
    const lines: string[] = ['[[proxies]]'];
    lines.push(`name = ${tomlString(name)}`);
    if (draft.type) lines.push(`type = ${tomlString(draft.type.trim())}`);
    if (draft.localIP.trim()) lines.push(`localIP = ${tomlString(draft.localIP.trim())}`);
    if (draft.localPort.trim()) {
      const port = Number(draft.localPort.trim());
      if (Number.isFinite(port)) lines.push(`localPort = ${port}`);
    }
    if (draft.remotePort.trim()) {
      const port = Number(draft.remotePort.trim());
      if (Number.isFinite(port)) lines.push(`remotePort = ${port}`);
    }
    if (draft.subdomain.trim()) lines.push(`subdomain = ${tomlString(draft.subdomain.trim())}`);
    const domains = draft.customDomains
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (domains.length) {
      lines.push(`customDomains = [${domains.map(tomlString).join(', ')}]`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Replace the proxies section of a TOML document with the structured drafts,
 * preserving everything before the first `[[proxies]]` line. If the source has
 * no proxies section, the new section is appended.
 */
export function rewriteProxies(text: string, drafts: ProxyDraft[]): string {
  const { preface } = splitTomlAtProxies(text);
  const proxiesText = serializeProxies(drafts);
  const trimmed = preface.replace(/\s+$/u, '');
  if (!proxiesText) return trimmed + '\n';
  return `${trimmed}\n\n${proxiesText}\n`;
}

export function validateProxy(draft: ProxyDraft, others: ProxyDraft[]): string[] {
  const errors: string[] = [];
  const name = draft.name.trim();
  if (!name) errors.push('代理名不能为空');
  else if (others.some((other) => other !== draft && other.name.trim() === name)) {
    errors.push('代理名重复');
  }
  if (!draft.type) errors.push('请选择代理类型');
  if (draft.localPort.trim() && !isPortString(draft.localPort)) {
    errors.push('本地端口须是 1-65535 的整数');
  }
  if (draft.remotePort.trim() && !isPortString(draft.remotePort)) {
    errors.push('远端端口须是 1-65535 的整数');
  }
  if (draft.type === 'tcp' && !draft.remotePort.trim()) {
    errors.push('TCP 代理必须配置远端端口');
  }
  return errors;
}

function isPortString(value: string): boolean {
  const num = Number(value.trim());
  return Number.isInteger(num) && num > 0 && num < 65536;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseTomlString(raw: string): string {
  let value = raw.trim();
  // Strip trailing comments (simple heuristic — TOML allows # outside strings).
  const commentIdx = findCommentStart(value);
  if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseTomlInt(raw: string): number | null {
  let value = raw.trim();
  const commentIdx = findCommentStart(value);
  if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
  const num = Number(value);
  return Number.isInteger(num) ? num : null;
}

function parseTomlStringArray(raw: string): string[] {
  let value = raw.trim();
  const commentIdx = findCommentStart(value);
  if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return [];
  const inner = value.slice(1, -1);
  const result: string[] = [];
  let buf = '';
  let inString = false;
  let quote = '"';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      if (ch === '\\' && i + 1 < inner.length) {
        buf += ch + inner[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        result.push(safeJsonParse(buf));
        buf = '';
        inString = false;
        continue;
      }
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    }
  }
  return result;
}

function safeJsonParse(buf: string): string {
  try {
    return JSON.parse(`"${buf.replace(/"/g, '\\"')}"`);
  } catch {
    return buf;
  }
}

function findCommentStart(value: string): number {
  let inString = false;
  let quote = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inString) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) inString = false;
    } else if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === '#') {
      return i;
    }
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────
// Full frpc.toml round-trip for the create form.
// Recognized fields: serverAddr, serverPort, [auth].method, [auth].token,
// and [[proxies]]. Everything else (including [log]) is dropped on
// re-serialize — the form provides a default [log] block instead.
// ─────────────────────────────────────────────────────────────────────────

export type FrpcConfigDraft = {
  serverAddr: string;
  serverPort: string;
  authToken: string;
  proxies: ProxyDraft[];
};

export function emptyFrpcConfig(): FrpcConfigDraft {
  return {
    serverAddr: '',
    serverPort: '',
    authToken: '',
    proxies: []
  };
}

export function parseFrpcConfig(text: string): FrpcConfigDraft {
  const { preface, proxiesBody } = splitTomlAtProxies(text);
  const proxies = parseProxies(proxiesBody);

  let serverAddr = '';
  let serverPort = '';
  let authToken = '';
  let section: string | null = null;

  for (const raw of preface.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']') && !line.startsWith('[[')) {
      section = line.slice(1, -1).trim();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (section === null) {
      if (key === 'serverAddr') {
        serverAddr = parseTomlString(value);
      } else if (key === 'serverPort') {
        const parsed = parseTomlInt(value);
        serverPort = parsed === null ? '' : String(parsed);
      }
    } else if (section === 'auth') {
      if (key === 'token') authToken = parseTomlString(value);
    }
  }

  return { serverAddr, serverPort, authToken, proxies };
}

export function serializeFrpcConfig(draft: FrpcConfigDraft): string {
  const lines: string[] = [];
  const serverAddr = draft.serverAddr.trim();
  if (serverAddr) {
    lines.push(`serverAddr = ${tomlString(serverAddr)}`);
  } else {
    lines.push('# serverAddr 必填，请填写 frps 服务器地址');
    lines.push('serverAddr = ""');
  }

  const portInput = draft.serverPort.trim();
  const portNumber = portInput ? Number(portInput) : 7000;
  const safePort = Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536 ? portNumber : 7000;
  lines.push(`serverPort = ${safePort}`);

  lines.push('');
  const token = draft.authToken.trim();
  if (token) {
    lines.push('[auth]');
    lines.push('method = "token"');
    lines.push(`token = ${tomlString(token)}`);
  } else {
    lines.push('# 未配置认证密钥；若 frps 端要求 token，请取消下面三行的注释并填写 token');
    lines.push('# [auth]');
    lines.push('# method = "token"');
    lines.push('# token = ""');
  }

  lines.push('');
  lines.push('[log]');
  lines.push('to = "console"');
  lines.push('level = "info"');
  lines.push('maxDays = 3');

  const proxiesText = serializeProxies(draft.proxies);
  if (proxiesText) {
    lines.push('');
    lines.push(proxiesText);
  }

  return lines.join('\n') + '\n';
}

export function validateFrpcDraft(draft: FrpcConfigDraft): string[] {
  const errors: string[] = [];
  if (!draft.serverAddr.trim()) errors.push('请填写 frps 服务器地址');
  if (draft.serverPort.trim()) {
    const port = Number(draft.serverPort.trim());
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      errors.push('frps 端口须是 1-65535 的整数');
    }
  }
  draft.proxies.forEach((proxy, index) => {
    const issues = validateProxy(proxy, draft.proxies);
    if (issues.length) {
      const name = proxy.name.trim() || `#${index + 1}`;
      errors.push(`代理 ${name}: ${issues.join('，')}`);
    }
  });
  return errors;
}
