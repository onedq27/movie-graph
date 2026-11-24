// Light / dark theme. <html data-theme> is first set by the inline script in
// index.html (before first paint); this module keeps it in sync afterwards.
// Until the user presses the toggle the app follows the system; after that
// their choice is kept in localStorage.

export const THEME_KEY = 'theme';
export const THEME_BAR = { light: '#f4f5f8', dark: '#0e1014' };   // --bg of each theme
export const THEME_EVENT = 'themechange';                          // on document, after every switch

const valid = (t) => t === 'dark' || t === 'light';

export function savedTheme(storage) {
  try {
    const t = storage.getItem(THEME_KEY);
    return valid(t) ? t : null;
  } catch { return null; }   // storage may be unavailable
}

// The saved choice wins; without one, the system setting decides.
export function pickTheme(saved, systemDark) {
  return valid(saved) ? saved : (systemDark ? 'dark' : 'light');
}

export const otherTheme = (theme) => (theme === 'dark' ? 'light' : 'dark');

// Wires the toggle. Everything it touches is passed in, so it runs under node too.
export function initTheme({ doc, storage, systemDark, button, meta, labels }) {
  const root = doc.documentElement;
  const apply = (theme) => {
    root.dataset.theme = theme;
    if (meta) meta.content = THEME_BAR[theme];
    const label = labels[otherTheme(theme)];   // the button says what it switches to
    button.setAttribute('aria-label', label);
    button.title = label;
    doc.dispatchEvent(new Event(THEME_EVENT));
  };
  apply(pickTheme(savedTheme(storage), systemDark.matches));
  button.addEventListener('click', () => {
    const next = otherTheme(root.dataset.theme);
    try { storage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    apply(next);
  });
  systemDark.addEventListener('change', () => {
    if (!savedTheme(storage)) apply(pickTheme(null, systemDark.matches));
  });
}
