import type { AuthState } from './types';

const TOKEN_STORAGE_KEY = 'frpc-webui-auth';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export function loadAuth(): AuthState | null {
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

export function saveAuth(state: AuthState) {
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(state));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

let currentToken: string | null = null;
let onUnauthorizedHandler: () => void = () => {};

export function setAuthToken(token: string | null) {
  currentToken = token;
}

export function getAuthToken(): string | null {
  return currentToken;
}

export function setOnUnauthorized(fn: () => void) {
  onUnauthorizedHandler = fn;
}

export function notifyUnauthorized() {
  onUnauthorizedHandler();
}
