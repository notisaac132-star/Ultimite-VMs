// Gets a Windows ISO link by running Microsoft's own download page in a real browser window.
//
// Microsoft's download protection turns away plain web requests, but not the page's own scripts running in a
// real browser. So the page is loaded (hidden) and its edition and language boxes are filled in for the user.
// If that doesn't work (the page changed, or it wants the person to prove they're human), the window is shown
// instead and the user clicks through it themselves. Either way the ISO link is taken the moment it appears,
// and the app downloads it itself (with progress, resume and the rest).
const { BrowserWindow, session } = require("electron");

// The Windows 10 page only offers an ISO to non-Windows browsers (Windows visitors get the Media Creation Tool).
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BLOCKED = /unable to complete your request|banned from using this service|sentinel/i;

// options:
//   page        the Microsoft download page
//   languages   language names to try in order, e.g. ["French", "English"]
//   interactive show the window and let the user click through (otherwise it stays hidden)
//   onStatus    called with short progress text
//   signal      AbortSignal
// Resolves { url, language }. Rejects with an Error; error.blocked is set when Microsoft is refusing this internet connection.
function getIsoLink({ page, languages = ["English"], interactive = false, onStatus = () => {}, signal, timeoutMs }) {
  const ses = session.fromPartition("persist:microsoft-download");
  ses.setUserAgent(USER_AGENT);
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 820,
    title: "Microsoft: download Windows",
    autoHideMenuBar: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true },
  });

  return new Promise((resolve, reject) => {
    let done = false;
    let chosenLanguage = languages[0];
    const finish = (err, value) => {
      if (done) return;
      done = true;
      ses.removeListener("will-download", onDownload);
      signal?.removeEventListener("abort", onAbort);
      // Closed on the next turn: destroying a window while a page call is still in flight can crash Electron.
      setImmediate(() => { if (!win.isDestroyed()) win.destroy(); });
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("Cancelled"));
    // The user clicked a download button themselves: take its link and cancel the browser's own download.
    const onDownload = (event, item) => {
      event.preventDefault();
      finish(null, { url: item.getURL(), language: chosenLanguage });
    };
    // A click on the download button may arrive as a download or as a navigation to the .iso: take the link either way.
    const isIso = (u) => /\.iso(\?|$)/i.test(u) && /microsoft/i.test(u);
    const onNavigate = (event, url) => {
      if (!isIso(url)) return;
      event.preventDefault?.();
      finish(null, { url, language: chosenLanguage });
    };
    win.webContents.on("will-navigate", onNavigate);
    win.webContents.on("will-redirect", onNavigate);
    win.webContents.on("did-start-navigation", (details) => onNavigate({}, details.url));
    signal?.addEventListener("abort", onAbort);
    ses.on("will-download", onDownload);
    win.on("closed", () => finish(new Error(interactive ? "The Microsoft window was closed before a download started." : "The browser window closed.")));

    const run = (code) => (win.isDestroyed() ? Promise.reject(new Error("closed")) : win.webContents.executeJavaScript(code, true));
    const deadline = Date.now() + (timeoutMs || (interactive ? 15 * 60_000 : 90_000));

    // Polls `code` until it returns something truthy.
    const until = async (code, what, ms = 30_000) => {
      const end = Math.min(Date.now() + ms, deadline);
      while (!done && Date.now() < end) {
        if (await run(`document.body ? /${BLOCKED.source}/i.test(document.body.innerText) : false`).catch(() => false)) {
          throw Object.assign(new Error("Microsoft is refusing automatic Windows downloads from this internet connection."), { blocked: true });
        }
        const value = await run(code).catch(() => null);
        if (value) return value;
        await wait(500);
      }
      if (!done) throw new Error(`Microsoft's page didn't show ${what}.`);
    };

    // The ISO link: any .iso link on the page; 64-bit preferred.
    const FIND_LINK = `(() => {
      const links = [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /\\.iso(\\?|$)/i.test(h));
      return links.find((h) => /x64|64/i.test(h)) || links[0] || null;
    })()`;

    (async () => {
      try {
        onStatus("Opening Microsoft's download page…");
        await win.loadURL(page);
        if (done) return;
        if (interactive) {
          win.show();
          onStatus("Waiting for you on Microsoft's page: pick the edition, language, then “64-bit Download”.");
        }

        const drive = async () => {
          onStatus("Choosing the Windows edition…");
          await until(`(() => { const s = document.querySelector('#product-edition'); return !!s && [...s.options].some((o) => o.value); })()`, "the Windows edition list");
          await run(`(() => {
            const s = document.querySelector('#product-edition');
            const o = [...s.options].find((o) => o.value && /ISO/i.test(o.text)) || [...s.options].find((o) => o.value);
            s.value = o.value;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('#submit-product-edition').click();
          })()`);

          onStatus("Choosing the language…");
          await until(`(() => { const s = document.querySelector('#product-languages'); return !!s && [...s.options].some((o) => o.value); })()`, "the language list");
          chosenLanguage = await run(`(() => {
            const names = ${JSON.stringify(languages)};
            const s = document.querySelector('#product-languages');
            const opts = [...s.options].filter((o) => o.value);
            const o = names.map((n) => opts.find((o) => o.text.trim() === n)).find(Boolean) || opts[0];
            s.value = o.value;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('#submit-sku').click();
            return o.text.trim();
          })()`);
        };

        if (interactive) {
          await drive().catch(() => {}); // best effort; the user can do any step the page didn't accept
        } else {
          await drive();
        }

        onStatus("Getting the download link from Microsoft…");
        const url = await until(FIND_LINK, "a download link", interactive ? 15 * 60_000 : 45_000);
        if (url) finish(null, { url, language: chosenLanguage });
      } catch (err) {
        finish(err);
      }
    })();
  });
}

module.exports = { getIsoLink };
