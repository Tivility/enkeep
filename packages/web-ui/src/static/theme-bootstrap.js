/**
 * Enkeep Web Console - Early Theme Bootstrap Script
 *
 * Runs synchronously in <head> before DOM body paint to eliminate Flash of Unstyled Content (FOUC).
 * Safe under CSP `script-src 'self'`.
 *
 * Persistence hierarchy (pre-bootstrap / unauthenticated):
 * 1. Explicit pre-login preference: localStorage "enkeep.theme.prelogin" ('dark' | 'light' | 'eye-care')
 * 2. Window matchMedia ('(prefers-color-scheme: light)') -> 'light' : 'dark' (eye-care never automatic)
 * 3. Default fallback: 'dark'
 */
(function () {
  var VALID_THEMES = ['dark', 'light', 'eye-care'];
  var theme = 'dark';

  function getSystemTheme() {
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }

  try {
    // Backward-compatible one-time migration: migrate legacy 'enkeep.theme' to 'enkeep.theme.prelogin'
    var legacy = localStorage.getItem('enkeep.theme');
    if (legacy) {
      if (VALID_THEMES.indexOf(legacy) !== -1 && !localStorage.getItem('enkeep.theme.prelogin')) {
        localStorage.setItem('enkeep.theme.prelogin', legacy);
      }
      localStorage.removeItem('enkeep.theme');
    }

    var stored = localStorage.getItem('enkeep.theme.prelogin');
    if (stored && VALID_THEMES.indexOf(stored) !== -1) {
      theme = stored;
    } else {
      theme = getSystemTheme();
    }
  } catch (e) {
    // Fail-safe default on storage access exceptions
    theme = getSystemTheme();
  }

  document.documentElement.dataset.theme = theme;
})();
