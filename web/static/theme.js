// Applies the saved light/dark theme before the page is drawn (no flash of the
// wrong theme); app.js owns the toggle.
try {
  if (JSON.parse(localStorage.getItem("dea.theme")) === "light") document.documentElement.dataset.theme = "light";
} catch {}
