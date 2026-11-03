/* UCL CS Learning System, on every page: the theme (system, light or dark), and on module pages the header and module switcher.
   Settings has its own page, settings.html. */
(function () {
  const THEME_KEY = 'ucl-cs-theme';
  const root = document.documentElement;
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function storedTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || 'system';
    } catch (err) {
      return 'system';
    }
  }

  function updateToggles() {
    const dark = root.dataset.theme === 'dark';
    document.querySelectorAll('.theme-toggle').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(dark));
      btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    });
  }

  function applyTheme(pref) {
    const dark = pref === 'dark' || (pref === 'system' && media !== null && media.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    updateToggles();
    document.dispatchEvent(new CustomEvent('portal:theme', { detail: pref }));
  }

  function setTheme(pref) {
    try {
      localStorage.setItem(THEME_KEY, pref);
    } catch (err) {
      // storage blocked: the choice still applies to this page
    }
    applyTheme(pref);
  }

  // This runs in <head>, before the page is drawn, so there is no flash of the wrong theme.
  applyTheme(storedTheme());
  if (media) media.addEventListener('change', () => storedTheme() === 'system' && applyTheme('system'));
  window.addEventListener('storage', (e) => e.key === THEME_KEY && applyTheme(storedTheme()));
  document.addEventListener('DOMContentLoaded', updateToggles);

  document.addEventListener('click', (e) => {
    if (e.target.closest('.theme-toggle')) setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  // ---------- module pages: the header that stays at the top, and the module switcher ----------

  function setUpModuleHead() {
    const head = document.querySelector('.site-head');
    if (!head) return;
    // Shrink a little after the header reaches the top, grow back only near the very top,
    // so the change in height can't make it flip back and forth.
    let compact = false;
    const update = () => {
      const next = compact ? window.scrollY > 8 : window.scrollY > 48;
      if (next !== compact) head.classList.toggle('compact', (compact = next));
    };
    window.addEventListener('scroll', update, { passive: true });
    update();

    const menus = head.querySelectorAll('.mod-switch, .src-menu');
    if (!menus.length) return;
    document.addEventListener('click', (e) => {
      menus.forEach((menu) => {
        if (menu.open && !menu.contains(e.target)) menu.open = false;
      });
    });
    menus.forEach((menu) => {
      menu.addEventListener('toggle', () => {
        if (!menu.open) return;
        menus.forEach((other) => {
          if (other !== menu && other.open) other.open = false;
        });
      });
      menu.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !menu.open) return;
        menu.open = false;
        const summary = menu.querySelector('summary');
        if (summary) summary.focus();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', setUpModuleHead);

  window.portal = { theme: storedTheme, setTheme };
})();
