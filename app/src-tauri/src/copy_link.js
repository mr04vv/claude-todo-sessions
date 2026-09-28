// Runs in every page of the browser pane: ⌘L copies the page's URL, as the
// pane has no address bar of its own that a page could focus.
(() => {
  if (window.__todoSessionsCopyLink) return;
  window.__todoSessionsCopyLink = true;
  const TOAST_MS = 1400;
  const toast = () => {
    const d = document.createElement("div");
    d.textContent = "リンクをコピーしました";
    d.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:6px 12px;border-radius:6px;background:rgba(20,21,24,.92);color:#fff;font:12px -apple-system,sans-serif;pointer-events:none";
    document.documentElement.appendChild(d);
    setTimeout(() => d.remove(), TOAST_MS);
  };
  // Pages that block the Clipboard API still allow a copy from a selection.
  const copyBySelection = (text) => {
    const t = document.createElement("textarea");
    t.value = text;
    t.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== "l") return;
      e.preventDefault();
      e.stopPropagation();
      const url = location.href;
      const write = navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject(new Error("no clipboard"));
      write.catch(() => copyBySelection(url)).then(toast);
    },
    true,
  );
})();
