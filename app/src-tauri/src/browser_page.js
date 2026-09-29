// Runs in every page of the browser pane, which has no browser chrome of its
// own: ⌘L moves to the app's address bar and ⌘R reloads.
(() => {
  if (window.__todoSessionsPage) return;
  window.__todoSessionsPage = true;

  // The app cancels this navigation and focuses its address bar.
  const FOCUS_URL = "todo-sessions://focus-url";

  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "r") {
        e.preventDefault();
        location.reload();
      } else if (key === "l") {
        e.preventDefault();
        e.stopPropagation();
        location.href = FOCUS_URL;
      }
    },
    true,
  );
})();
