// Small logo tiles for each operating system (simple shapes, no trademarked artwork files).
window.osLogo = (logo, size = 48) => {
  const glyphs = {
    windows: `<path d="M4 4h7.5v7.5H4zM12.5 4H20v7.5h-7.5zM4 12.5h7.5V20H4zM12.5 12.5H20V20h-7.5z" fill="#fff"/>`,
    apple: `<path fill="#fff" d="M12 7.6c-1.9-1.4-4.9-1-6.1 1.5-1.4 2.9-.3 7.2 1.8 9.4.9 1 2 1.3 3 .8.9-.4 1.8-.4 2.7 0 1 .5 2.1.2 3-.8.8-.8 1.6-2.1 2-3.3-1.5-.8-2.4-2.2-2.4-3.9 0-1.4.7-2.7 1.8-3.5-1.4-1.6-3.9-1.7-5.8-.2z"/><path fill="#fff" d="M12.3 6.6c-.1-1.8 1.2-3.3 2.9-3.6.2 1.8-1.2 3.4-2.9 3.6z"/>`,
    ubuntu: `<circle cx="12" cy="12" r="5.2" fill="none" stroke="#fff" stroke-width="2.2"/><circle cx="17.6" cy="12" r="2.1" fill="#fff" stroke="#e95420" stroke-width="1"/><circle cx="9.2" cy="7.2" r="2.1" fill="#fff" stroke="#e95420" stroke-width="1"/><circle cx="9.2" cy="16.8" r="2.1" fill="#fff" stroke="#e95420" stroke-width="1"/>`,
    fedora: `<circle cx="12" cy="12" r="7.5" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M14.8 8.2h-1.6a2 2 0 0 0-2 2V17M9.2 12.2h4.6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`,
    debian: `<path d="M15.6 8.6a5 5 0 1 0 .8 5.4M13.9 13.2a2.2 2.2 0 1 1-.4-3" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`,
    mint: `<path d="M6 7v6.5a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V9.5M10 7v6.5M10 9.5a2 2 0 0 1 4 0v4M14 9.5a2 2 0 0 1 4 0" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>`,
    chrome: `<circle cx="12" cy="12" r="7.6" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="12" r="3" fill="#fff"/><path d="M12 9h6.9M9.4 13.5 5.9 7.5M14.6 13.5l-3.4 6" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`,
    disc: `<circle cx="12" cy="12" r="7.5" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="12" r="2" fill="#fff"/><path d="M12 6.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity=".7"/>`,
  };
  return `<span class="logo logo-${logo}" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" aria-hidden="true">${glyphs[logo] || glyphs.disc}</svg></span>`;
};
