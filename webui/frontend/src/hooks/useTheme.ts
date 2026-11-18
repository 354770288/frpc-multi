import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';
const THEME_EVENT = 'frpc-theme-change';

function resolveIsDark(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

function applyTheme(theme: Theme) {
  const dark = resolveIsDark(theme);
  const root = document.documentElement;
  root.classList.add('theme-transition-off');
  root.classList.toggle('dark', dark);
  void root.offsetWidth; // 强制 reflow，让 transition:none 在换色同一帧生效
  requestAnimationFrame(() => root.classList.remove('theme-transition-off'));
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme) || 'system',
  );
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    resolveIsDark((localStorage.getItem(STORAGE_KEY) as Theme) || 'system') ? 'dark' : 'light',
  );

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    setThemeState(next);
    setResolved(resolveIsDark(next) ? 'dark' : 'light');
    window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: next }));
  }, []);

  useEffect(() => {
    applyTheme(theme);
    setResolved(resolveIsDark(theme) ? 'dark' : 'light');
    const onSync = (event: Event) => {
      const next = (event as CustomEvent<Theme>).detail;
      if (next) {
        setThemeState(next);
        setResolved(resolveIsDark(next) ? 'dark' : 'light');
      }
    };
    window.addEventListener(THEME_EVENT, onSync);
    if (theme !== 'system') {
      return () => window.removeEventListener(THEME_EVENT, onSync);
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      applyTheme('system');
      setResolved(media.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', onChange);
    return () => {
      window.removeEventListener(THEME_EVENT, onSync);
      media.removeEventListener('change', onChange);
    };
  }, [theme]);

  return { theme, resolved, setTheme };
}
