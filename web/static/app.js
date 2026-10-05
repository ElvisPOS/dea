"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const store = {
  get(k, def) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const state = {
  agents: [],
  stores: [],
  server: null, // this server: role, hostname, version, stats
  filter: "all", // "all" | "online" | "offline" | "warn"
  sort: store.get("dea.sort", "az"), // "az" | "store"
  query: "",
  selected: new Set(), // agent keys
  collapsed: new Set(store.get("dea.collapsed", [])), // store ids
  lastExec: new Map(), // agent key -> {cmd, result}, from this browser
  tabs: new Map(), // tab key -> TermTab | LogsTab | DeviceTab
  active: "fleet",
  pollTimer: null,
};

// An agent's address on this server: "pos" (direct) or "store/pos".
const keyOf = (a) => (a.store ? `${a.store}/${a.id}` : a.id);

// ---------- API ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    ...opts,
  });
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new Error("not logged in");
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- login ----------

function showLogin() {
  clearInterval(state.pollTimer);
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-form").password.focus();
}

async function showApp() {
  state.me = await api("/api/me");
  fillMe();
  $("#login").hidden = true;
  $("#app").hidden = false;
  await refreshAgents();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshAgents, 3000);
}

// Server-provided texts in the "Add store or POS" dialog (re-run after a
// language change, which re-creates the translated markup).
function fillMe() {
  const me = state.me;
  if (!me) return;
  $("#upstream-card").hidden = !me.upstream;
  const up = $("#upstream-url"), id = $("#upstream-id");
  if (up) up.textContent = me.upstream || "";
  if (id) id.textContent = me.store_id || "";
  $("#store-setup-card").hidden = !me.store_setup;
  $("#store-setup").textContent = me.store_setup || "";
  $("#install-title").textContent = me.store_setup ? t("addPos.titleDirect") : t("addPos.title");
}

$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const err = $("#login-error");
  err.hidden = true;
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ user: f.user.value, password: f.password.value }) });
    f.password.value = "";
    await showApp();
  } catch (e) {
    err.textContent = tErr(e.message);
    err.hidden = false;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  for (const t of [...state.tabs.values()]) t.close();
  showLogin();
});

// ---------- fleet data ----------

function ago(iso) {
  if (!iso || iso.startsWith("0001")) return t("time.never");
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}${t("unit.s")}`;
  if (s < 3600) return `${Math.floor(s / 60)}${t("unit.m")}`;
  if (s < 86400) return `${Math.floor(s / 3600)}${t("unit.h")}`;
  return `${Math.floor(s / 86400)}${t("unit.d")}`;
}

async function refreshAgents() {
  let data;
  try {
    data = await api("/api/agents");
  } catch {
    return;
  }
  state.agents = data.agents;
  state.stores = data.stores;
  state.server = data.server || null;
  const known = new Set(state.agents.map(keyOf));
  for (const k of state.selected) if (!known.has(k)) state.selected.delete(k);
  renderFleet();
}

function storeById(id) {
  return state.stores.find((s) => s.id === id);
}

// Name from system.store for a store path ("12" or "12/sub"), if known.
function storeName(path) {
  if (!path) return "";
  const st = storeById(path.split("/")[0]);
  return (st && st.name) || (state.server?.role === "store" && path === state.server.store_id ? state.server.store_name || "" : "");
}

// A POS is shown by its system.devices description, or its id (hostname) when unknown.
function agentName(a) {
  return (a && (a.name || a.id)) || "";
}

// "001707 AMACO Fiume Veneto › #3 4POS VM" for an agent key such as "12/memphis-pos-169".
function keyLabel(key) {
  const i = key.lastIndexOf("/");
  const a = state.agents.find((x) => keyOf(x) === key);
  const pos = a ? agentName(a) : key.slice(i + 1);
  if (i < 0) return pos;
  const s = key.slice(0, i);
  return `${storeName(s) || s} › ${pos}`;
}

async function forget(path, what) {
  if (!confirm(t("confirm.forget", { what }))) return;
  await api(path, { method: "DELETE" }).catch((e) => alert(tErr(e.message)));
  refreshAgents();
}

// ---------- sorting ----------

function collator() {
  return new Intl.Collator(lang, { numeric: true, sensitivity: "base" });
}

function compareIds(a, b) {
  const x = Number(a), y = Number(b);
  if (a !== "" && b !== "" && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return collator().compare(a, b);
}

// Stores: by name (A–Z) or numeric id.
function compareStores(x, y) {
  if (state.sort === "store") return compareIds(x.id, y.id);
  return collator().compare(x.name || x.id, y.name || y.id) || compareIds(x.id, y.id);
}

// POS in a store: by name (A–Z) or by device id, POS without one last.
function compareAgents(a, b) {
  if (state.sort === "store") {
    const x = a.device_id ? Number(a.device_id) : Infinity;
    const y = b.device_id ? Number(b.device_id) : Infinity;
    if (x !== y) return x - y;
  }
  return collator().compare(agentName(a), agentName(b)) || collator().compare(a.id, b.id);
}

// ---------- resources ----------

const WARN_AT = 80, CRIT_AT = 90; // % of CPU, memory or the fullest disk
const LATE_MS = 150_000; // a report older than this is late (reports every 60 s, relayed by stores every 30 s)

const pct = (used, total) => (total ? (100 * used) / total : 0);
const diskPct = (d) => pct(d.used, d.used + d.avail);
const levelOf = (p) => (p >= CRIT_AT ? "crit" : p >= WARN_AT ? "warn" : "");

function humanBytes(n) {
  if (!n) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

function duration(sec) {
  if (!sec) return "–";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}${t("unit.d")} ${h}${t("unit.h")}`;
  if (h) return `${h}${t("unit.h")} ${m}${t("unit.m")}`;
  return `${m}${t("unit.m")}`;
}

function worstDisk(st) {
  let w = null;
  for (const d of st?.disks || []) if (!w || diskPct(d) > diskPct(w)) w = d;
  return w;
}

// ---------- fleet tree: this server, its stores, their POS ----------

// Builds the tree from the latest /api/agents answer. Node ids: "server",
// "s:<store id>", "p:<agent key>".
function buildTree() {
  const me = state.server || { role: "central" };
  const selfStore = me.role === "store";
  const root = {
    id: "server", kind: selfStore ? "store" : "central", root: true, online: true, stats: me.stats,
    name: selfStore ? storeName(me.store_id) || t("home.thisStore") : t("home.central"),
    host: me.hostname, version: me.version, storeId: selfStore ? me.store_id : "", upstream: state.me?.upstream, children: [],
  };
  const byStore = new Map();
  for (const s of [...state.stores].sort(compareStores)) {
    const n = {
      id: `s:${s.id}`, kind: "store", parent: root, store: s, online: s.online, stats: s.stats, seen: s.last_seen,
      name: s.name || s.id, host: s.hostname, version: s.version, storeId: s.id,
      addr: (s.remote_addr || "").replace(/:\d+$/, ""), connectedAt: s.connected_at, children: [],
    };
    byStore.set(s.id, n);
    root.children.push(n);
  }
  const direct = [];
  for (const a of [...state.agents].sort(compareAgents)) {
    const parent = byStore.get((a.store || "").split("/")[0]) || root;
    const n = {
      id: `p:${keyOf(a)}`, kind: "pos", parent, agent: a, key: keyOf(a), online: a.online, stats: a.stats, seen: a.last_seen,
      name: agentName(a), host: a.hostname || a.id, ip: (a.ips && a.ips[0]) || (a.remote_addr || "").replace(/:\d+$/, ""),
      deviceId: a.device_id, version: a.version, children: [],
    };
    (parent === root ? direct : parent.children).push(n);
  }
  root.children.push(...direct); // POS connected to this server directly come after the stores
  return root;
}

function walk(n, fn) {
  fn(n);
  for (const c of n.children) walk(c, fn);
}

function findNode(root, id) {
  let hit = null;
  walk(root, (n) => {
    if (n.id === id) hit = n;
  });
  return hit;
}

// Severity of the worst of CPU, memory and the fullest disk: 0, 1 (80–89%) or 2 (90%+).
function sev(n) {
  if (!n.online || !n.stats) return 0;
  const d = worstDisk(n.stats);
  const m = Math.max(n.stats.cpu || 0, pct(n.stats.mem_used, n.stats.mem_total), d ? diskPct(d) : 0);
  return m >= CRIT_AT ? 2 : m >= WARN_AT ? 1 : 0;
}
const isLate = (n) => n.online && n.stats && Date.now() - Date.parse(n.stats.at) > LATE_MS;
const needsAttention = (n) => sev(n) > 0 || isLate(n);

function posOf(n) {
  return n.children.filter((c) => c.kind === "pos");
}

// ---------- fleet home ----------

const CARET = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MORE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

const ICONS = {
  overview: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  terminal: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3M12 15h5"/></svg>',
  logs: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h8"/></svg>',
};

function svgButton(cls, svg) {
  const b = el("button", cls);
  b.type = "button";
  b.innerHTML = svg; // constant markup only
  return b;
}

function matches(n) {
  const q = state.query.toLowerCase();
  if (q) {
    const hay = [n.name, n.host, n.ip, n.addr, n.storeId, n.deviceId, n.key].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (state.filter === "online") return n.online;
  if (state.filter === "offline") return !n.online;
  if (state.filter === "warn") return needsAttention(n) || !n.online;
  return true;
}

function meter(p, title) {
  const m = el("span", "rt-meter" + (p == null ? " is-none" : levelOf(p) ? ` is-${levelOf(p)}` : ""));
  const bar = el("span", "rt-meter__bar");
  if (p != null) {
    const fill = el("span", "rt-meter__fill");
    fill.style.width = `${Math.max(2, Math.min(100, p))}%`;
    bar.append(fill);
  }
  m.append(bar, el("span", "rt-meter__val", p == null ? "—" : `${Math.round(p)}%`));
  if (title) m.title = title;
  return m;
}

function statusDot(n) {
  const d = el("span", "rt-dot" + (!n.online ? " is-off" : isLate(n) ? " is-stale" : ""));
  d.title = !n.online ? t("dot.offline") : isLate(n) ? t("dot.late") : t("dot.online");
  return d;
}

function roleBadge(n) {
  if (n.kind === "pos") return null;
  return el("span", "rt-role", n.kind === "central" ? t("role.central") : t("role.store"));
}

function metaLine(n) {
  if (n.kind === "central") return [n.host, n.version].filter(Boolean).join(" · ");
  if (n.kind === "store") return [n.storeId && `#${n.storeId}`, n.root ? n.host : n.addr, n.version].filter(Boolean).join(" · ");
  return [n.host, n.ip, n.deviceId && `ID ${n.deviceId}`].filter(Boolean).join(" · ");
}

function memText(st) {
  return `${humanBytes(st.mem_used)} / ${humanBytes(st.mem_total)}` + (st.swap_total ? ` · ${t("res.swap")} ${humanBytes(st.swap_used)}` : "");
}

function disksText(st) {
  return (st.disks || []).map((d) => `${d.path}  ${Math.round(diskPct(d))}% ${t("res.of", { size: humanBytes(d.total) })}`).join("\n");
}

// One DeviceRow: select · device · CPU · memory · disk · load · uptime · reported · ⋯
function fleetRow(n, guides, ctx) {
  const row = el("div", `rt-grid rt-row is-${n.kind}` + (n.root ? " is-root" : "") + (n.online ? "" : " is-off"));
  row.dataset.id = n.id;
  row.tabIndex = 0;
  row.setAttribute("role", "row");

  // select
  if (n.kind === "pos") {
    const cb = el("input", "rt-check");
    cb.type = "checkbox";
    cb.checked = state.selected.has(n.key);
    cb.setAttribute("aria-label", t("row.select", { name: n.name }));
    cb.addEventListener("change", () => {
      cb.checked ? state.selected.add(n.key) : state.selected.delete(n.key);
      renderFleet();
    });
    if (cb.checked) row.classList.add("is-selected");
    row.append(cb);
  } else if (posOf(n).length) {
    const kids = posOf(n);
    const k = kids.filter((p) => state.selected.has(p.key)).length;
    const cb = el("input", "rt-check");
    cb.type = "checkbox";
    cb.checked = k > 0 && k === kids.length;
    cb.indeterminate = k > 0 && k < kids.length;
    cb.setAttribute("aria-label", t("row.selectStore", { name: n.name }));
    cb.addEventListener("change", () => {
      for (const p of kids) cb.checked ? state.selected.add(p.key) : state.selected.delete(p.key);
      if (cb.checked && n.storeId) state.collapsed.delete(n.storeId);
      renderFleet();
    });
    row.append(cb);
  } else {
    row.append(el("span"));
  }

  // device
  const dev = el("div", "rt-cell-dev");
  const tree = el("span", "rt-tree");
  for (const g of guides) tree.append(el("i", g));
  dev.append(tree);
  if (n.kind === "store" && !n.root) {
    const caret = svgButton("rt-caret", CARET);
    caret.setAttribute("aria-expanded", String(!state.collapsed.has(n.storeId)));
    caret.setAttribute("aria-label", t("row.expand"));
    caret.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleStore(n.storeId);
    });
    dev.append(caret);
  }
  dev.append(statusDot(n));
  const text = el("span", "rt-dev-text");
  const line = el("span", "rt-dev-line");
  const name = el("span", "rt-name", n.name);
  name.title = n.name;
  line.append(name);
  const badge = roleBadge(n);
  if (badge) line.append(badge);
  const kids = posOf(n);
  if (n.kind === "store" && kids.length) {
    const on = kids.filter((p) => p.online).length;
    const c = el("span", "rt-count" + (on === kids.length ? "" : on === 0 ? " is-down" : " is-partial"), `${on}/${kids.length}`);
    c.title = t("row.countTitle");
    line.append(c);
    if (ctx.collapsed) {
      const w = kids.filter(needsAttention);
      if (w.length) {
        const f = el("span", "rt-flag" + (w.some((p) => sev(p) === 2) ? " is-crit" : ""), `! ${w.length}`);
        f.title = t("row.flagTitle");
        line.append(f);
      }
    }
  }
  text.append(line, el("span", "rt-meta", metaLine(n)));
  dev.append(text);
  row.append(dev);

  // resources
  const st = n.stats;
  if (n.online && st) {
    const d = worstDisk(st);
    row.append(
      meter(st.cpu, t("res.cores", { n: st.cpus })),
      meter(pct(st.mem_used, st.mem_total), memText(st)),
      d ? meter(diskPct(d), disksText(st)) : meter(null),
      el("span", "rt-num", (st.load?.[0] ?? 0).toFixed(2)),
      el("span", "rt-num", duration(st.uptime))
    );
    row.lastChild.previousSibling.title = t("res.loadTitle");
    const late = isLate(n);
    row.append(el("span", "rt-age" + (late ? " is-stale" : ""), t("logs.ago", { ago: ago(st.at) })));
  } else {
    const msg = !n.online ? t("row.offline", { ago: ago(n.seen) }) : n.kind === "pos" || n.version ? t("row.old", { version: n.version || "?" }) : t("res.waiting");
    row.append(el("span", "rt-offtxt", n.online && !st && n.root ? t("res.waiting") : msg), el("span"), el("span"));
    row.append(el("span", "rt-age", n.online ? "–" : ago(n.seen)));
  }

  // shortcuts: overview, terminal + screen, logs
  const acts = el("span", "rt-acts");
  const shortcut = (icon, title, fn, enabled = true) => {
    const b = svgButton("rt-act", ICONS[icon]);
    b.title = title;
    b.setAttribute("aria-label", `${title}: ${n.name}`);
    b.disabled = !enabled;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      fn();
    });
    return b;
  };
  acts.append(shortcut("overview", t("menu.details"), () => openDevice(n.id)));
  if (n.kind === "pos") {
    acts.append(
      shortcut("terminal", t("act.terminal"), () => openTerminal(n.key, n.name), n.online),
      shortcut("logs", t("menu.logs"), () => openLogs(n.key, n.name), n.online)
    );
  }
  row.append(acts);

  // ⋯
  const more = svgButton("rt-more", MORE);
  more.setAttribute("aria-label", t("row.actions", { name: n.name }));
  more.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openMenu(n, more);
  });
  row.append(more);

  row.addEventListener("click", (ev) => {
    if (ev.target.closest("input, button")) return;
    openDevice(n.id);
  });
  return row;
}

function listHead() {
  const h = el("div", "rt-grid rt-head");
  h.setAttribute("role", "row");
  const cols = [["", ""], ["col.device", ""], ["col.cpu", ""], ["col.mem", ""], ["col.disk", ""], ["col.load", "is-num"], ["col.uptime", "is-num"], ["col.reported", "is-num"], ["", ""], ["", ""]];
  for (const [k, cls] of cols) h.append(el("span", cls, k ? t(k) : ""));
  return h;
}

function toggleStore(id, open) {
  const isOpen = !state.collapsed.has(id);
  if (open === undefined) open = !isOpen;
  open ? state.collapsed.delete(id) : state.collapsed.add(id);
  store.set("dea.collapsed", [...state.collapsed]);
  renderFleet();
}

let renderQueued = false;
function renderFleet() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderHome();
    for (const tab of state.tabs.values()) if (tab instanceof DeviceTab) tab.update();
    renderBulk();
  });
}

function renderHome() {
  const root = buildTree();
  state.tree = root;
  const stores = root.children.filter((n) => n.kind === "store");
  const all = [];
  walk(root, (n) => all.push(n));
  const pos = all.filter((n) => n.kind === "pos");

  // summary tiles; each applies the matching filter
  const kpi = (value, label, cls, filter) => {
    const b = el("button", "rt-kpi" + (cls ? ` ${cls}` : ""));
    b.append(el("b", null, value), el("span", null, label));
    b.addEventListener("click", () => setFilter(filter));
    return b;
  };
  const sOn = stores.filter((s) => s.online).length, pOn = pos.filter((p) => p.online).length;
  const nOff = all.filter((n) => !n.online).length;
  const nWarn = all.filter((n) => sev(n) === 1 || (isLate(n) && sev(n) === 0)).length, nCrit = all.filter((n) => sev(n) === 2).length;
  const tiles = [];
  if (stores.length) tiles.push(kpi(`${sOn}/${stores.length}`, t("kpi.storesUp"), sOn === stores.length ? "is-ok" : "", "all"));
  tiles.push(
    kpi(`${pOn}/${pos.length}`, t("kpi.posOnline"), pos.length && pOn === pos.length ? "is-ok" : "", "online"),
    kpi(String(nOff), t("kpi.offline"), "", "offline"),
    kpi(String(nWarn), t("kpi.warn"), nWarn ? "is-warn" : "", "warn"),
    kpi(String(nCrit), t("kpi.crit"), nCrit ? "is-crit" : "", "warn")
  );
  $("#kpis").replaceChildren(...tiles);
  const dot = $("#fleet-tab-dot");
  dot.hidden = !nCrit && !nWarn;
  dot.className = "rt-dot" + (nCrit ? "" : " is-stale");
  if (nCrit) dot.style.background = "var(--crit)";
  else dot.style.background = "";

  // the tree; a matching device always shows with its store and this server above it
  const filtering = !!state.query || state.filter !== "all";
  const rows = [];
  const focusedId = document.activeElement?.closest?.("#fleet-list .rt-row")?.dataset.id;
  const branches = root.children
    .map((n) => {
      const kids = posOf(n).filter(matches);
      const show = !filtering || matches(n) || kids.length > 0;
      return show ? { n, kids: filtering ? kids : posOf(n) } : null;
    })
    .filter(Boolean);
  if (!filtering || matches(root) || branches.length) rows.push(fleetRow(root, [], {}));
  branches.forEach(({ n, kids }, i) => {
    const last = i === branches.length - 1;
    if (n.kind === "pos") {
      rows.push(fleetRow(n, [last ? "is-elbow" : "is-tee"], {}));
      return;
    }
    const collapsed = state.collapsed.has(n.storeId) && !(filtering && kids.length && !matches(n));
    rows.push(fleetRow(n, [last ? "is-elbow" : "is-tee"], { collapsed }));
    if (!collapsed) kids.forEach((p, j) => rows.push(fleetRow(p, [last ? "" : "is-pipe", j === kids.length - 1 ? "is-elbow" : "is-tee"], {})));
  });
  const list = $("#fleet-list");
  if (rows.length) list.replaceChildren(listHead(), ...rows);
  else list.replaceChildren(listHead(), el("div", "empty", t("home.empty")));
  if (focusedId) list.querySelector(`.rt-row[data-id="${CSS.escape(focusedId)}"]`)?.focus();

  document.querySelectorAll("#filter-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter)));
  $("#sort-select").value = state.sort;
  const storeIds = stores.map((s) => s.storeId);
  $("#expand-all").hidden = $("#collapse-all").hidden = storeIds.length === 0;
}

function setFilter(f) {
  state.filter = f;
  activate("fleet");
  renderFleet();
}

$("#search").addEventListener("input", (ev) => {
  state.query = ev.target.value.trim();
  renderFleet();
});
document.querySelectorAll("#filter-seg button").forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));
$("#sort-select").addEventListener("change", (ev) => {
  state.sort = ev.target.value;
  store.set("dea.sort", state.sort);
  renderFleet();
});
$("#expand-all").addEventListener("click", () => {
  state.collapsed.clear();
  store.set("dea.collapsed", []);
  renderFleet();
});
$("#collapse-all").addEventListener("click", () => {
  state.collapsed = new Set(state.stores.map((s) => s.id));
  store.set("dea.collapsed", [...state.collapsed]);
  renderFleet();
});

// keyboard: ↑/↓ move, Enter opens, →/← expand or collapse a store, Space ticks a POS
$("#fleet-list").addEventListener("keydown", (ev) => {
  const row = ev.target.closest?.(".rt-row");
  if (!row || ev.target !== row) return;
  const n = findNode(state.tree, row.dataset.id);
  if (!n) return;
  if (ev.key === "Enter") openDevice(n.id);
  else if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft") && n.kind === "store" && !n.root) toggleStore(n.storeId, ev.key === "ArrowRight");
  else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    const rows = [...document.querySelectorAll("#fleet-list .rt-row")];
    rows[rows.indexOf(row) + (ev.key === "ArrowDown" ? 1 : -1)]?.focus();
  } else if (ev.key === " " && n.kind === "pos") {
    state.selected.has(n.key) ? state.selected.delete(n.key) : state.selected.add(n.key);
    renderFleet();
  } else return;
  ev.preventDefault();
});

// ---------- ⋯ menu ----------

function openMenu(n, anchor) {
  const menu = $("#menu");
  const items = [];
  const item = (label, fn, opts = {}) => {
    const b = el("button", opts.danger ? "is-danger" : null, label);
    b.setAttribute("role", "menuitem");
    b.disabled = !!opts.disabled;
    b.addEventListener("click", () => {
      closeMenu();
      fn();
    });
    items.push(b);
  };
  if (n.kind === "pos") {
    item(t("menu.terminal"), () => openTerminal(n.key, n.name), { disabled: !n.online });
    item(t("menu.screen"), () => openScreen(n.key, n.name), { disabled: !n.online });
    item(t("menu.logs"), () => openLogs(n.key, n.name), { disabled: !n.online });
  }
  item(t("menu.details"), () => openDevice(n.id));
  const removable = !n.online && !n.root && !(n.kind === "pos" && n.parent.kind === "store" && !n.parent.root && !n.parent.online);
  if (removable) {
    items.push(el("hr"));
    if (n.kind === "pos") item(t("agent.forget"), () => forget(`/api/agents/${n.key.split("/").map(encodeURIComponent).join("/")}`, n.key), { danger: true });
    else item(t("agent.forget"), () => forget(`/api/stores/${encodeURIComponent(n.storeId)}`, t("store.forgetWhat", { id: n.storeId })), { danger: true });
  }
  menu.replaceChildren(...items);
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + h + 4 > innerHeight ? r.top - h - 4 : r.bottom + 4}px`;
  menu.querySelector("button:not(:disabled)")?.focus();
}

function closeMenu() {
  $("#menu").hidden = true;
}
document.addEventListener("click", (ev) => {
  if (!ev.target.closest("#menu")) closeMenu();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeMenu();
});
addEventListener("resize", closeMenu);
$("#panes").addEventListener("scroll", closeMenu, true);

// ---------- run a command on the ticked POS ----------

function renderBulk() {
  const n = state.selected.size;
  const bar = $("#bulk");
  bar.hidden = n === 0 || state.active !== "fleet";
  const off = [...state.selected].filter((k) => !state.agents.find((a) => keyOf(a) === k)?.online).length;
  $("#bulk-n").textContent = t("bulk.n", { n }) + (off ? t("bulk.off", { n: off }) : "");
  const btn = $("#exec-run");
  btn.disabled = n === 0 || btn.dataset.busy === "1";
}

async function runCommand(keys, cmd, timeout) {
  const results = await api("/api/exec", { method: "POST", body: JSON.stringify({ agents: keys, cmd, timeout }) });
  for (const r of results) state.lastExec.set(r.id, { cmd, result: r });
  return results;
}

function resultBox(r) {
  const box = el("div", "result");
  const head = el("div", "result-head");
  const good = r.ok && r.code === 0;
  head.append(
    el("b", null, keyLabel(r.id)),
    el("span", good ? "ok" : "fail", r.ok ? t("exec.exit", { code: r.code }) : t("exec.failed")),
    el("span", "muted", r.ms ? `${r.ms} ms` : "")
  );
  const text = (r.output || "") + (r.error ? (r.output ? "\n" : "") + t("exec.error", { msg: tErr(r.error) }) : "");
  box.append(head, el("pre", null, text));
  return box;
}

$("#exec-run").addEventListener("click", async () => {
  const cmd = $("#exec-cmd").value.trim();
  if (!cmd) return $("#exec-cmd").focus();
  const keys = [...state.selected].sort();
  const btn = $("#exec-run");
  const out = $("#exec-results");
  btn.dataset.busy = "1";
  renderBulk();
  $("#exec-panel").hidden = false;
  $("#exec-cmd-shown").textContent = cmd;
  $("#exec-summary").textContent = "";
  out.replaceChildren(el("p", "muted", t("exec.running", { n: keys.length })));
  try {
    const results = await runCommand(keys, cmd, +$("#exec-timeout").value);
    results.sort((a, b) => (a.ok && a.code === 0) - (b.ok && b.code === 0) || a.id.localeCompare(b.id));
    $("#exec-summary").textContent = t("exec.succeeded", { ok: results.filter((r) => r.ok && r.code === 0).length, n: results.length });
    out.replaceChildren(...results.map(resultBox));
  } catch (e) {
    out.replaceChildren(el("p", "error", tErr(e.message)));
  } finally {
    btn.dataset.busy = "";
    renderBulk();
    renderFleet();
  }
});
$("#exec-cmd").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") $("#exec-run").click();
});
$("#bulk-clear").addEventListener("click", () => {
  state.selected.clear();
  renderFleet();
});
$("#exec-close").addEventListener("click", () => ($("#exec-panel").hidden = true));

// ---------- "Add store or POS" ----------

$("#add-btn").addEventListener("click", () => {
  fillMe();
  $("#add-dialog").showModal();
});
$("#add-dialog").addEventListener("click", (ev) => {
  if (ev.target.closest("[data-close-dialog]") || ev.target === $("#add-dialog")) $("#add-dialog").close();
});

async function copyText(codeEl, btn) {
  try {
    await navigator.clipboard.writeText(codeEl.textContent);
  } catch {
    const r = document.createRange();
    r.selectNodeContents(codeEl);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    document.execCommand("copy");
  }
  btn.textContent = t("copied");
  setTimeout(() => (btn.textContent = t("copy")), 1500);
}

document.querySelectorAll("button.copy").forEach((b) => b.addEventListener("click", () => copyText($("#" + b.dataset.copy), b)));

// ---------- device page ----------

function openDevice(id) {
  const key = `dev:${id}`;
  if (!state.tabs.has(key)) {
    const n = findNode(state.tree, id);
    if (!n) return;
    state.tabs.set(key, new DeviceTab(id));
  }
  activate(key);
}

// DeviceTab shows one device: breadcrumbs, resource cards, disks, details and,
// for a POS, a command box; a store's page also lists its POS.
class DeviceTab {
  constructor(id) {
    this.id = id;
    this.key = `dev:${id}`;
    this.tab = el("button", "tab");
    this.tab.dataset.tab = this.key;
    this.dot = el("span", "rt-dot");
    this.kind = el("span", "tab-kind", t("dev.kind"));
    this.label = el("span", "tab-label");
    this.tab.append(this.dot, this.kind, this.label, el("span", "tab-close", "×"));
    $("#tabs").append(this.tab);

    this.pane = el("div", "pane device");
    this.pane.dataset.pane = this.key;
    $("#panes").append(this.pane);
    this.build();
  }

  get node() {
    return findNode(state.tree, this.id);
  }

  get agentKey() {
    return this.node?.key;
  }

  // Static parts (the command box keeps what is being typed); update() fills the rest.
  build() {
    this.crumbs = el("div", "crumbs");
    this.head = el("div", "dhead");
    this.live = el("div");
    this.live.style.display = "contents";
    this.cmdCard = null;
    const parts = [this.crumbs, this.head, this.live];
    const n = this.node;
    if (n?.kind === "pos") {
      this.cmdCard = el("div", "card");
      const box = el("div", "runbox");
      this.cmd = el("input", "rt-input");
      this.cmd.placeholder = "uptime; df -h /";
      this.cmd.spellcheck = false;
      this.timeout = el("select", "rt-input");
      for (const [v, l] of [[10, "10 s"], [30, "30 s"], [120, "2 min"], [600, "10 min"]]) {
        const o = el("option", null, l);
        o.value = v;
        this.timeout.append(o);
      }
      this.timeout.value = "30";
      this.runBtn = el("button", "rt-btn is-primary", t("bulk.run"));
      this.runBtn.addEventListener("click", () => this.run());
      this.cmd.addEventListener("keydown", (ev) => ev.key === "Enter" && this.run());
      box.append(this.cmd, this.timeout, this.runBtn);
      this.out = el("pre", "term-out");
      this.cmdCard.append(el("h3", null, t("dev.lastCmd")), box, this.out);
      parts.push(this.cmdCard);
    }
    this.pane.replaceChildren(...parts);
    this.update();
  }

  async run() {
    const n = this.node;
    const cmd = this.cmd.value.trim();
    if (!n || !cmd) return this.cmd.focus();
    this.running = true;
    this.runBtn.disabled = true;
    this.out.replaceChildren(el("span", "muted", t("exec.running", { n: 1 })));
    try {
      await runCommand([n.key], cmd, +this.timeout.value);
    } catch (e) {
      state.lastExec.set(n.key, { cmd, result: { id: n.key, ok: false, error: e.message } });
    } finally {
      this.running = false;
      this.update();
    }
  }

  update() {
    const n = this.node;
    if (!n) {
      this.label.textContent = this.label.textContent || this.id;
      this.live.replaceChildren(el("p", "offnote", t("dev.gone")));
      return;
    }
    this.dot.className = "rt-dot" + (!n.online ? " is-off" : isLate(n) ? " is-stale" : "");
    this.label.textContent = n.name;
    this.tab.title = n.kind === "pos" ? keyLabel(n.key) : n.name;

    // Fleet › central › store › POS
    const chain = [];
    for (let c = n; c; c = c.parent) chain.unshift(c);
    const fleet = el("a", null, t("tab.fleet"));
    fleet.addEventListener("click", () => activate("fleet"));
    const crumbs = [fleet];
    chain.forEach((c, i) => {
      crumbs.push(el("span", null, "›"));
      if (i === chain.length - 1) crumbs.push(el("span", null, c.name));
      else {
        const a = el("a", null, c.name);
        a.addEventListener("click", () => openDevice(c.id));
        crumbs.push(a);
      }
    });
    this.crumbs.replaceChildren(...crumbs);

    // title and actions
    const h1 = el("h1");
    const role = el("span", "rt-role" + (n.kind === "pos" ? " is-pos" : ""), n.kind === "central" ? t("role.central") : n.kind === "store" ? t("role.store") : t("role.pos"));
    h1.append(statusDot(n), el("span", "rt-name", n.name), role);
    const acts = el("div", "acts");
    if (n.kind === "pos") {
      const btn = (label, fn, primary) => {
        const b = el("button", "rt-btn" + (primary ? " is-primary" : ""), label);
        b.disabled = !n.online;
        b.addEventListener("click", fn);
        return b;
      };
      acts.append(
        btn(t("menu.terminal"), () => openTerminal(n.key, n.name), true),
        btn(t("menu.screen"), () => openScreen(n.key, n.name)),
        btn(t("menu.logs"), () => openLogs(n.key, n.name)),
        btn(t("dev.run"), () => this.cmd.focus())
      );
    }
    this.head.replaceChildren(h1, acts);

    // live content
    const st = n.stats;
    const live = [];
    if (!n.online) live.push(el("div", "offnote", t(st ? "dev.offlineStats" : "dev.offline", { ago: ago(n.seen) })));
    if (st) {
      const card = (title, value, sub, p) => {
        const c = el("div", "card");
        c.append(el("h3", null, title), el("div", "big" + (p != null && levelOf(p) ? ` is-${levelOf(p)}` : ""), value), el("div", "rt-sub", sub));
        if (p != null) c.append(meter(p));
        return c;
      };
      const memP = pct(st.mem_used, st.mem_total);
      const cards = el("div", "cards");
      cards.append(
        card(t("card.cpu"), `${Math.round(st.cpu)}%`, t("res.cores", { n: st.cpus }), st.cpu),
        card(t("card.mem"), `${Math.round(memP)}%`, memText(st), memP),
        card(t("card.load"), (st.load?.[0] ?? 0).toFixed(2), t("card.loadSub", { a: (st.load?.[1] ?? 0).toFixed(2), b: (st.load?.[2] ?? 0).toFixed(2) })),
        card(t("card.uptime"), duration(st.uptime), t("card.reported", { ago: ago(st.at) }))
      );
      live.push(cards);
    } else if (n.online) {
      live.push(el("div", "offnote", n.kind === "pos" || !n.root ? t("row.old", { version: n.version || "?" }) : t("res.waiting")));
    }

    // a store lists its POS
    const kids = posOf(n);
    if (n.kind !== "pos" && kids.length) {
      const sec = el("div");
      const list = el("div", "rt-list");
      list.append(listHead(), ...kids.map((p, i) => fleetRow(p, [i === kids.length - 1 ? "is-elbow" : "is-tee"], {})));
      const wrap = el("div", "rt-list-wrap");
      wrap.append(list);
      sec.append(el("h3", "sec-title", n.kind === "store" ? t("dev.posList") : t("dev.posDirect")), wrap);
      live.push(sec);
    }

    // disks + details
    const two = el("div", "two");
    const disks = el("div", "card");
    disks.append(el("h3", null, n.kind === "store" ? t("dev.storeDisks") : t("dev.disks")));
    if (st && st.disks?.length) {
      const tb = el("table");
      const hr = el("tr");
      hr.append(el("th", null, t("dev.mount")), el("th", null, t("dev.used")), el("th", null, t("dev.free")), el("th", null, t("dev.size")));
      tb.append(hr);
      for (const d of st.disks) {
        const tr = el("tr");
        const used = el("td");
        used.append(meter(diskPct(d)));
        tr.append(el("td", "rt-mono", d.path), used, el("td", "rt-mono", humanBytes(d.avail)), el("td", "rt-mono", humanBytes(d.total)));
        tb.append(tr);
      }
      disks.append(tb);
    } else disks.append(el("p", "rt-sub", t("dev.noReport")));
    const info = [];
    if (n.kind === "pos") {
      const a = n.agent;
      info.push(["det.host", a.hostname], ["det.addr", (a.ips || []).join(", ") || n.ip], ["det.posId", a.device_id], ["det.store", storeName(a.store) || a.store], ["det.os", a.os], ["det.user", a.user], ["det.agent", a.version], ["det.from", a.remote_addr]);
    } else if (n.kind === "store" && !n.root) {
      const s = n.store;
      info.push(["det.storeId", s.id], ["det.host", s.hostname], ["det.addr", n.addr], ["det.version", s.version], ["det.conn", s.online ? t("store.up", { ago: ago(s.connected_at) }) : t("store.offline", { ago: ago(s.last_seen) })]);
    } else {
      info.push(["det.host", n.host], ["det.version", n.version], ["det.storeId", n.storeId], ["det.upstream", n.upstream]);
    }
    const dt = el("table");
    for (const [k, v] of info) {
      if (!v) continue;
      const tr = el("tr");
      tr.append(el("td", "k", t(k)), el("td", "rt-mono", String(v)));
      dt.append(tr);
    }
    const details = el("div", "card");
    details.append(el("h3", null, t("dev.details")), dt);
    two.append(disks, details);
    live.push(two);
    this.live.replaceChildren(...live);

    // last command on this POS (from this browser)
    if (this.cmdCard) {
      this.cmd.disabled = !n.online;
      this.runBtn.disabled = !n.online || this.running;
      const last = state.lastExec.get(n.key);
      if (!this.running) {
        if (last) {
          const r = last.result;
          const prompt = el("span", "p", `${n.agent.user || "elvispos"}@${n.host}:~$ `);
          const text = (r.output || "") + (r.error ? (r.output ? "\n" : "") + t("exec.error", { msg: tErr(r.error) }) : "");
          const status = r.ok ? t("exec.exit", { code: r.code }) : t("exec.failed");
          this.out.replaceChildren(prompt, `${last.cmd}\n${text}`, el("span", r.ok && r.code === 0 ? "muted" : "bad", `\n[${status}]`));
        } else this.out.replaceChildren(el("span", "muted", t("dev.noCmd")));
      }
    }
  }

  translate() {
    this.kind.textContent = t("dev.kind");
    this.build();
  }

  fit() {}

  focus() {}

  close() {
    this.tab.remove();
    this.pane.remove();
    state.tabs.delete(this.key);
    if (state.active === this.key) {
      const keys = [...state.tabs.keys()];
      activate(keys.length ? keys[keys.length - 1] : "fleet");
    }
  }
}

// ---------- tabs & terminals ----------

let tabSeq = 0;
const encoder = new TextEncoder();

function activate(key) {
  state.active = key;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === key));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === key));
  const t = state.tabs.get(key);
  if (t) {
    t.fit();
    t.focus();
  }
  updateLayoutButtons();
  renderFleet();
}

$("#tabs").addEventListener("click", (ev) => {
  const tab = ev.target.closest(".tab");
  if (!tab) return;
  if (ev.target.classList.contains("tab-close")) state.tabs.get(tab.dataset.tab)?.close();
  else activate(tab.dataset.tab);
});
$("#tabs").addEventListener("auxclick", (ev) => {
  const tab = ev.target.closest(".tab");
  if (ev.button === 1 && tab && tab.dataset.tab !== "fleet") state.tabs.get(tab.dataset.tab)?.close();
});

// Store path of an agent key: "12" for "12/pos-1", "" for a POS connected directly.
function storeOf(key) {
  const i = key.lastIndexOf("/");
  return i < 0 ? "" : key.slice(0, i);
}

// Opens a POS. In the current split tab: the pane already showing it, else
// the focused empty pane. Otherwise a new tab split in two, with the terminal
// on the left and the screen on the right.
function openTerminal(agentKey, label, kind = "term") {
  const cur = state.tabs.get(state.active);
  // a terminal tab only holds POS of one store
  if (cur instanceof TermTab && (cur.store === null || cur.store === storeOf(agentKey))) {
    const same = cur.slotOf(agentKey, kind);
    if (same >= 0) {
      cur.setFocus(same);
      cur.focus();
      return;
    }
    const open = cur.slotOf(agentKey);
    if (open >= 0) {
      cur.setFocus(open);
      cur.showKind(open, kind);
      cur.focus();
      return;
    }
    const free = cur.freeSlot();
    if (free >= 0) {
      cur.place(free, agentKey, label, kind);
      renderFleet();
      return;
    }
  }
  const t = new TermTab();
  state.tabs.set(t.key, t);
  activate(t.key);
  t.setLayout(2);
  t.place(0, agentKey, label, "term");
  t.place(1, agentKey, label, "screen");
  t.setFocus(kind === "screen" ? 1 : 0);
  t.focus();
}

function openScreen(agentKey, label) {
  openTerminal(agentKey, label, "screen");
}

function openLogs(agentKey, label) {
  const open = [...state.tabs.values()].find((t) => t instanceof LogsTab && t.agentKey === agentKey);
  if (open) return activate(open.key);
  const t = new LogsTab(agentKey, label);
  state.tabs.set(t.key, t);
  activate(t.key);
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// LogsTab lists a POS's log files and downloads them as a .tar.gz.
class LogsTab {
  constructor(agentKey, label) {
    this.agentKey = agentKey;
    this.key = `t${++tabSeq}`;
    this.files = [];
    this.selected = new Set();

    this.tab = el("button", "tab");
    this.tab.dataset.tab = this.key;
    this.kind = el("span", "tab-kind");
    this.tab.append(this.kind, el("span", "tab-label", label), el("span", "tab-close", "×"));
    $("#tabs").append(this.tab);

    this.pane = el("div", "pane logs");
    this.pane.dataset.pane = this.key;
    $("#panes").append(this.pane);

    const head = el("div", "logs-head");
    const title = el("div", "logs-title");
    this.status = el("span", "muted logs-status");
    title.append(el("h2", null, label), el("span", "muted", keyLabel(agentKey)), this.status);
    this.btnRefresh = el("button", "btn small");
    this.btnSelected = el("button", "btn small");
    this.btnAll = el("button", "btn primary small");
    this.translate();
    this.btnRefresh.addEventListener("click", () => this.load());
    this.btnSelected.addEventListener("click", () => this.download([...this.selected]));
    this.btnAll.addEventListener("click", () => this.download(null));
    head.append(title, el("span", "spacer"), this.btnRefresh, this.btnSelected, this.btnAll);
    this.list = el("div", "logs-list");
    this.pane.append(head, this.list);
    this.load();
  }

  fit() {}
  focus() {}

  translate() {
    this.kind.textContent = t("logs.kind");
    this.tab.title = t("logs.tabTitle", { name: keyLabel(this.agentKey) });
    this.btnRefresh.textContent = t("logs.refresh");
    this.btnSelected.textContent = t("logs.downloadSelected");
    this.btnAll.textContent = t("logs.downloadAll");
    if (this.files.length) this.render();
    else this.update();
  }

  async load() {
    this.list.replaceChildren(el("p", "muted", t("logs.reading")));
    try {
      this.files = await api(`/api/logs?agent=${encodeURIComponent(this.agentKey)}`);
    } catch (e) {
      this.files = [];
      this.list.replaceChildren(el("p", "error", tErr(e.message)));
      this.update();
      return;
    }
    const known = new Set(this.files.map((f) => f.path));
    for (const p of this.selected) if (!known.has(p)) this.selected.delete(p);
    this.render();
  }

  render() {
    if (!this.files.length) {
      this.list.replaceChildren(el("p", "muted", t("logs.none")));
      return this.update();
    }
    const groups = new Map();
    for (const f of this.files) {
      const dir = f.path.slice(0, f.path.lastIndexOf("/"));
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(f);
    }
    const table = el("table", "logs-table");
    const thead = el("tr");
    this.selAll = el("input");
    this.selAll.type = "checkbox";
    this.selAll.addEventListener("change", () => {
      for (const f of this.files) this.selAll.checked ? this.selected.add(f.path) : this.selected.delete(f.path);
      this.render();
    });
    const th0 = el("th");
    th0.append(this.selAll);
    thead.append(th0, el("th", null, t("logs.file")), el("th", "num", t("logs.size")), el("th", null, t("logs.modified")), el("th"));
    table.append(thead);
    for (const [dir, files] of groups) {
      const gr = el("tr", "logs-group");
      const td = el("td", null, dir);
      td.colSpan = 5;
      gr.append(td);
      table.append(gr);
      for (const f of files) {
        const tr = el("tr");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = this.selected.has(f.path);
        cb.addEventListener("change", () => {
          cb.checked ? this.selected.add(f.path) : this.selected.delete(f.path);
          this.update();
        });
        const c0 = el("td");
        c0.append(cb);
        const one = el("button", "row-btn", t("logs.download"));
        one.addEventListener("click", () => this.download([f.path]));
        const c4 = el("td", "act");
        c4.append(one);
        const name = el("td", "mono", f.name.slice(f.name.lastIndexOf("/") + 1));
        name.title = f.path;
        const when = el("td", null, t("logs.ago", { ago: ago(f.mtime) }));
        when.title = new Date(f.mtime).toLocaleString();
        tr.append(c0, name, el("td", "num mono", humanSize(f.size)), when, c4);
        table.append(tr);
      }
    }
    this.list.replaceChildren(table);
    this.update();
  }

  update() {
    const n = this.selected.size;
    const total = this.files.reduce((s, f) => s + f.size, 0);
    const sel = this.files.filter((f) => this.selected.has(f.path)).reduce((s, f) => s + f.size, 0);
    if (!this.busy) {
      this.status.textContent = n ? t("logs.selected", { n, size: humanSize(sel) }) : t("logs.count", { n: this.files.length, size: humanSize(total) });
    }
    this.btnSelected.disabled = this.busy || n === 0;
    this.btnAll.disabled = this.busy || this.files.length === 0;
    if (this.selAll) {
      this.selAll.checked = n > 0 && n === this.files.length;
      this.selAll.indeterminate = n > 0 && n < this.files.length;
    }
  }

  // Fetches the archive (so errors show here instead of as a downloaded file), then saves it.
  async download(paths) {
    const q = new URLSearchParams({ agent: this.agentKey });
    if (paths) paths.forEach((p) => q.append("f", p));
    else q.set("all", "1");
    this.busy = true;
    this.update();
    this.status.textContent = t("logs.compressing");
    try {
      const res = await fetch(`/api/logs/download?${q}`, { credentials: "same-origin" });
      if (res.status === 401) return showLogin();
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        this.status.textContent = t("logs.downloading", { size: humanSize(got) });
      }
      const disp = res.headers.get("Content-Disposition") || "";
      const name = (disp.match(/filename="([^"]+)"/) || [])[1] || "logs.tar.gz";
      const a = el("a");
      a.href = URL.createObjectURL(new Blob(chunks, { type: "application/gzip" }));
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      this.busy = false;
      this.update();
      this.status.textContent = t("logs.saved", { name, size: humanSize(got) });
    } catch (e) {
      this.busy = false;
      this.update();
      this.status.textContent = t("logs.failed", { msg: tErr(e.message) });
    }
  }

  close() {
    this.tab.remove();
    this.pane.remove();
    state.tabs.delete(this.key);
    if (state.active === this.key) {
      const keys = [...state.tabs.keys()];
      activate(keys.length ? keys[keys.length - 1] : "fleet");
    }
  }
}

// Term is one shell session on one POS, drawn into its own element so it can move
// between panes and tabs without reconnecting.
// xterm colours per UI theme; the light one keeps ANSI colours readable on white.
const TERM_THEMES = {
  dark: { background: "#0f1216", foreground: "#e6e9ee", cursor: "#5b9bff", cursorAccent: "#0f1216", selectionBackground: "#1b2a40" },
  light: {
    background: "#ffffff", foreground: "#1f2328", cursor: "#0969da", cursorAccent: "#ffffff", selectionBackground: "#b6d7f7",
    black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#9a6700", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
  },
};
const termTheme = () => TERM_THEMES[currentTheme()];

class Term {
  static live = new Set();

  constructor(agentKey, label, onStatus) {
    this.agentKey = agentKey;
    this.label = label;
    this.onStatus = onStatus;
    this.state = "wait";
    this.el = el("div", "term-host");

    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"),
      fontSize: 14,
      lineHeight: 1.15, // at 1.0 some monospace fonts clip underscores
      scrollback: 10000,
      theme: termTheme(),
    });
    Term.live.add(this);
    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.el);

    // keystrokes go through input(), which a tab may fan out to all its panes
    this.term.onData((d) => {
      if (this.dead) {
        if (d === "\r") this.connect();
        return;
      }
      this.input(encoder.encode(d));
    });
    this.term.onBinary((d) => this.input(Uint8Array.from(d, (c) => c.charCodeAt(0))));
    this.term.onResize(({ cols, rows }) => this.send(JSON.stringify({ type: "resize", cols, rows })));
    this.resizeObs = new ResizeObserver(() => this.fit());
    this.resizeObs.observe(this.el);
  }

  focus() {
    this.term.focus();
  }

  // Only a visible terminal can be measured.
  fit() {
    if (this.el.offsetParent === null) return;
    try {
      this.fitAddon.fit();
    } catch {}
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  input(data) {
    this.onInput ? this.onInput(this, data) : this.send(data);
  }

  status(s) {
    this.state = s;
    this.onStatus?.(this);
  }

  connect() {
    this.dead = false;
    this.live = false;
    this.status("wait");
    this.fit();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = new URLSearchParams({ agent: this.agentKey, cols: this.term.cols, rows: this.term.rows });
    const ws = new WebSocket(`${proto}//${location.host}/api/term?${q}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.term.write(`\x1b[2m[${t("term.connecting", { name: keyLabel(this.agentKey) })}]\x1b[0m\r\n`);

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        if (!this.live) {
          this.live = true;
          this.status("live");
        }
        this.term.write(new Uint8Array(ev.data));
        return;
      }
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === "error") this.term.write(`\r\n\x1b[31m[${t("term.error", { msg: tErr(m.error) })}]\x1b[0m\r\n`);
      if (m.type === "exit") this.term.write(`\r\n\x1b[2m[${t("term.exited", { code: m.code })}]\x1b[0m\r\n`);
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return;
      this.live = false;
      this.dead = true;
      this.status("dead");
      this.term.write(`\r\n\x1b[33m[${t("term.disconnected")}]\x1b[0m\r\n`);
    };
  }

  close() {
    Term.live.delete(this);
    this.closed = true;
    this.ws?.close();
    this.resizeObs.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}

// ScreenView shows a POS screen through its VNC server (x11vnc on the POS),
// view-only until "Take control". The VNC password is asked in the page and
// kept in memory only, for reconnects of this view.
class ScreenView {
  constructor(agentKey, label) {
    this.agentKey = agentKey;
    this.label = label;
    this.state = "wait";
    this.viewOnly = true;
    this.el = el("div", "screen-host");
    this.canvas = el("div", "screen-canvas");
    this.overlay = el("div", "screen-overlay");
    this.el.append(this.canvas, this.overlay);
  }

  status(s) {
    this.state = s;
    this.onStatus?.(this);
  }

  // Shows a message and an optional action over the screen; nothing hides the overlay.
  message(text, action) {
    this.overlay.hidden = !text && !action;
    const box = el("div", "screen-msg");
    if (text) box.append(el("p", null, text));
    if (action) box.append(action);
    this.overlay.replaceChildren(box);
  }

  retryButton() {
    const b = el("button", "btn small", t("screen.retry"));
    b.addEventListener("click", () => this.connect());
    return b;
  }

  async connect() {
    this.disconnectRfb();
    this.status("wait");
    this.message(t("screen.checking"));
    try {
      await api(`/api/vnc/check?agent=${encodeURIComponent(this.agentKey)}`);
    } catch (e) {
      if (this.closed) return;
      this.status("dead");
      return this.message(tErr(e.message), this.retryButton());
    }
    if (this.closed) return;
    if (!window.RFB) {
      this.status("dead");
      return this.message(t("screen.noViewer"), this.retryButton());
    }
    this.message(t("screen.connecting"));
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const rfb = new window.RFB(this.canvas, `${proto}//${location.host}/api/vnc?agent=${encodeURIComponent(this.agentKey)}`);
    rfb.viewOnly = this.viewOnly;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    rfb.addEventListener("connect", () => {
      this.status("live");
      this.message(null);
      this.onChange?.();
    });
    rfb.addEventListener("credentialsrequired", () => {
      if (this.password) return rfb.sendCredentials({ password: this.password });
      this.askPassword(rfb);
    });
    rfb.addEventListener("securityfailure", () => {
      this.password = null;
      this.authFailed = true;
    });
    rfb.addEventListener("disconnect", (e) => {
      if (this.closed || this.rfb !== rfb) return;
      this.rfb = null;
      this.status("dead");
      const text = this.authFailed ? t("screen.wrongPassword") : e.detail.clean ? t("screen.closed") : t("screen.lost");
      this.authFailed = false;
      this.message(text, this.retryButton());
      this.onChange?.();
    });
    this.rfb = rfb;
  }

  askPassword(rfb) {
    const form = el("form", "screen-pass");
    const input = el("input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = t("screen.password");
    const go = el("button", "btn primary small", t("screen.connect"));
    go.type = "submit";
    form.append(input, go);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (!input.value) return;
      this.password = input.value;
      this.message(t("screen.connecting"));
      rfb.sendCredentials({ password: input.value });
    });
    this.message(t("screen.passwordPrompt"), form);
    setTimeout(() => input.focus(), 0);
  }

  setViewOnly(v) {
    this.viewOnly = v;
    if (this.rfb) this.rfb.viewOnly = v;
    if (!v) this.focus();
  }

  ctrlAltDel() {
    this.rfb?.sendCtrlAltDel();
    this.focus();
  }

  fit() {} // the VNC client scales to its pane by itself

  focus() {
    if (!this.viewOnly) this.rfb?.focus();
  }

  disconnectRfb() {
    const r = this.rfb;
    this.rfb = null;
    try {
      r?.disconnect();
    } catch {}
  }

  close() {
    this.closed = true;
    this.disconnectRfb();
    this.el.remove();
  }
}

const LAYOUTS = [1, 2, 4];

// TermTab shows 1, 2 (side by side) or 4 (2x2) terminals. Clicking a POS fills
// the focused empty pane; terminals that no longer fit a smaller layout move to
// their own tabs.
// TermTab holds 1–4 panes, each showing the terminal or the screen of a POS.
// Panes sit on a grid split by two ratios (cx between the columns, cy between
// the rows) that the dividers drag; × removes a pane and the others grow.
class TermTab {
  constructor() {
    this.key = `t${++tabSeq}`;
    this.focused = 0;
    this.slots = [null]; // one entry per pane
    this.cx = 0.5;
    this.cy = 0.5;
    this.sync = false; // "Type in all": keystrokes go to every connected pane

    this.tab = el("button", "tab");
    this.tab.dataset.tab = this.key;
    this.dot = el("span", "dot wait");
    this.kind = el("span", "tab-kind");
    this.label = el("span", "tab-label");
    this.tab.append(this.dot, this.kind, this.label, el("span", "tab-close", "×"));
    $("#tabs").append(this.tab);

    this.pane = el("div", "pane term");
    this.pane.dataset.pane = this.key;
    $("#panes").append(this.pane);
  }

  get layout() {
    return this.slots.length;
  }

  // The store whose POS this tab may show: that of its first POS ("" = POS
  // connected to this server directly), or null while the tab is empty.
  get store() {
    const v = this.terms()[0];
    return v ? storeOf(v.agentKey) : null;
  }

  // The focused POS.
  get agentKey() {
    return this.slots[this.focused]?.agentKey;
  }

  // All views in the tab: terminals and screens.
  terms() {
    return this.slots.filter(Boolean);
  }

  // Terminals only: "Type in all" applies to these.
  shells() {
    return this.terms().filter((x) => x instanceof Term);
  }

  // Index of the pane a newly opened POS should go to, or -1 when full.
  freeSlot() {
    if (!this.slots[this.focused]) return this.focused;
    return this.slots.findIndex((v) => !v);
  }

  place(i, agentKey, label, kind = "term") {
    const v = kind === "screen" ? new ScreenView(agentKey, label) : new Term(agentKey, label, () => this.updateTab());
    this.adopt(i, v);
    v.connect();
    updateLayoutButtons();
  }

  wire(t) {
    t.onStatus = () => this.updateTab();
    t.onChange = () => this.render();
    t.onInput = (src, data) => {
      if (!this.sync) return src.send(data);
      for (const x of this.shells()) if (!x.dead) x.send(data);
    };
  }

  adopt(i, t) {
    this.wire(t);
    if (t.twin) this.wire(t.twin);
    this.slots[i] = t;
    this.focused = i;
    this.render();
    t.focus();
  }

  // The pane showing a POS (as "term" or "screen" when kind is given), or -1.
  slotOf(agentKey, kind) {
    return this.slots.findIndex((v) => v && v.agentKey === agentKey && (!kind || this.kindOf(v) === kind));
  }

  kindOf(v) {
    return v instanceof ScreenView ? "screen" : "term";
  }

  // Shows the terminal or the screen of the POS in pane i. If another pane
  // already shows it, the two panes swap. Otherwise the other view stays
  // connected in the background (the pane's "twin"), so switching back is
  // instant: the shell keeps its state and the screen needs no new password.
  showKind(i, kind) {
    const v = this.slots[i];
    if (!v || this.kindOf(v) === kind) return;
    const j = this.slots.findIndex((x, k) => k !== i && x && x.agentKey === v.agentKey && this.kindOf(x) === kind);
    let w;
    if (j >= 0) {
      w = this.slots[j];
      this.slots[j] = v;
      this.slots[i] = w;
      this.focused = i;
      this.render();
    } else if (v.twin) {
      w = v.twin;
      this.slots[i] = w;
      this.focused = i;
      this.render();
    } else {
      w = kind === "screen" ? new ScreenView(v.agentKey, v.label) : new Term(v.agentKey, v.label, () => this.updateTab());
      w.twin = v;
      v.twin = w;
      this.wire(w);
      this.slots[i] = w;
      this.focused = i;
      this.render();
      w.connect();
    }
    if (this.shells().length < 2) this.setSync(false);
    updateLayoutButtons();
    renderFleet();
    requestAnimationFrame(() => w.focus());
  }

  // Sets the number of panes: new ones start empty; when there are fewer,
  // views are compacted into them and the overflow moves to new tabs.
  setLayout(n) {
    if (n === this.layout) return;
    if (n > this.layout) {
      while (this.slots.length < n) this.slots.push(null);
    } else {
      const terms = this.terms();
      this.slots = terms.slice(0, n);
      while (this.slots.length < n) this.slots.push(null);
      for (const v of terms.slice(n)) {
        const tab = new TermTab();
        state.tabs.set(tab.key, tab);
        tab.adopt(0, v);
      }
    }
    this.focused = Math.min(this.focused, n - 1);
    if (this.shells().length < 2) this.sync = false;
    this.render();
    updateLayoutButtons();
  }

  setSync(on) {
    this.sync = on && this.shells().length > 1;
    this.pane.classList.toggle("sync", this.sync);
    this.tab.classList.toggle("sync", this.sync);
    updateLayoutButtons();
    this.focus();
  }

  // Pane rectangles as fractions [x, y, w, h]: 2 side by side, 3 = one on the
  // left and two stacked on the right, 4 = a 2×2 grid.
  rects() {
    const { cx, cy } = this;
    return [
      [[0, 0, 1, 1]],
      [[0, 0, cx, 1], [cx, 0, 1 - cx, 1]],
      [[0, 0, cx, 1], [cx, 0, 1 - cx, cy], [cx, cy, 1 - cx, 1 - cy]],
      [[0, 0, cx, cy], [cx, 0, 1 - cx, cy], [0, cy, cx, 1 - cy], [cx, cy, 1 - cx, 1 - cy]],
    ][this.layout - 1];
  }

  placeCells() {
    const g = this.layout > 1 ? 2 : 0; // half the gap between panes, in px
    this.rects().forEach(([x, y, w, h], i) => {
      const c = this.cells[i];
      if (!c) return;
      c.style.left = `calc(${x * 100}% + ${g}px)`;
      c.style.top = `calc(${y * 100}% + ${g}px)`;
      c.style.width = `calc(${w * 100}% - ${2 * g}px)`;
      c.style.height = `calc(${h * 100}% - ${2 * g}px)`;
    });
    if (this.vbar) this.vbar.style.left = `calc(${this.cx * 100}% - 4px)`;
    if (this.hbar) {
      this.hbar.style.top = `calc(${this.cy * 100}% - 4px)`;
      this.hbar.style.left = this.layout === 3 ? `${this.cx * 100}%` : "0";
      this.hbar.style.right = "0";
    }
  }

  // A divider: drag to resize, double-click to split evenly again.
  divider(axis) {
    const bar = el("div", `split-bar is-${axis}`);
    bar.title = t("pane.resize");
    bar.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      bar.setPointerCapture(ev.pointerId);
      bar.classList.add("drag");
      this.pane.classList.add("resizing");
      const box = this.pane.getBoundingClientRect();
      const move = (e) => {
        const r = axis === "v" ? (e.clientX - box.left) / box.width : (e.clientY - box.top) / box.height;
        this[axis === "v" ? "cx" : "cy"] = Math.min(0.85, Math.max(0.15, r));
        this.placeCells();
      };
      const up = () => {
        bar.classList.remove("drag");
        this.pane.classList.remove("resizing");
        bar.removeEventListener("pointermove", move);
        this.fit();
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up, { once: true });
    });
    bar.addEventListener("dblclick", () => {
      this[axis === "v" ? "cx" : "cy"] = 0.5;
      this.placeCells();
      requestAnimationFrame(() => this.fit());
    });
    return bar;
  }

  render() {
    const n = this.layout;
    this.pane.className = `pane term split-${n}` + (state.active === this.key ? " on" : "") + (this.sync ? " sync" : "");
    this.cells = [];
    for (let i = 0; i < n; i++) {
      const v = this.slots[i];
      const cell = el("div", "term-cell" + (n > 1 && i === this.focused ? " focused" : ""));
      cell.addEventListener("mousedown", () => this.setFocus(i));
      cell.append(this.cellHead(i, v));
      const body = el("div", "term-body");
      body.append(v ? v.el : this.emptyCell(i));
      cell.append(body);
      this.cells.push(cell);
    }
    this.vbar = n > 1 ? this.divider("v") : null;
    this.hbar = n > 2 ? this.divider("h") : null;
    this.pane.replaceChildren(...this.cells, ...[this.vbar, this.hbar].filter(Boolean));
    this.placeCells();
    requestAnimationFrame(() => this.fit());
    this.updateTab();
  }

  // × in every pane header: closes its view and removes the pane (the last
  // pane closes the tab).
  closeButton(i) {
    const x = el("button", "term-head-close", "×");
    x.title = this.layout > 1 ? t("pane.remove") : t("pane.close");
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.closeSlot(i);
    });
    return x;
  }

  cellHead(i, term) {
    const head = el("div", "term-head");
    if (!term) {
      head.append(el("span", "muted", t("pane.empty")), el("span", "spacer"), this.closeButton(i));
      return head;
    }
    const name = el("span", "term-head-name", keyLabel(term.agentKey));
    name.title = keyLabel(term.agentKey);
    const dot = el("span", "dot " + { wait: "wait", live: "on", dead: "dead" }[term.state]);
    if (term instanceof ScreenView) {
      const ctl = el("button", "term-head-btn" + (term.viewOnly ? "" : " on"), term.viewOnly ? t("screen.control") : t("screen.viewOnly"));
      ctl.title = term.viewOnly ? t("screen.viewOnlyTitle") : t("screen.controlTitle");
      ctl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        term.setViewOnly(!term.viewOnly);
        this.render();
      });
      const cad = el("button", "term-head-btn", t("screen.cad"));
      cad.disabled = term.viewOnly || term.state !== "live";
      cad.addEventListener("click", (ev) => {
        ev.stopPropagation();
        term.ctrlAltDel();
      });
      head.append(dot, this.kindSwitch(i, term), name, el("span", "spacer"), ctl, cad, this.closeButton(i));
      return head;
    }
    const all = el("span", "term-head-sync", t("pane.syncBadge"));
    head.append(dot, this.kindSwitch(i, term), name, el("span", "spacer"), all, this.closeButton(i));
    return head;
  }

  // Terminal | Screen switch for the POS in pane i.
  kindSwitch(i, view) {
    const box = el("div", "kind-switch");
    for (const [kind, label] of [["term", t("pane.openTerm")], ["screen", t("pane.openScreen")]]) {
      const b = el("button", this.kindOf(view) === kind ? "on" : "", label);
      b.title = kind === "term" ? t("pane.toTerm") : t("pane.toScreen");
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.showKind(i, kind);
      });
      box.append(b);
    }
    return box;
  }

  emptyCell(i) {
    const box = el("div", "term-empty");
    const sel = el("select", "rt-input");
    sel.append(new Option(t("pane.choose"), ""));
    const byStore = new Map();
    const only = this.store;
    for (const a of [...state.agents].filter((a) => a.online && (only === null || storeOf(keyOf(a)) === only)).sort(compareAgents)) {
      const g = a.store ? storeName(a.store) || a.store : state.server?.role === "store" ? storeName(state.server.store_id) || t("home.thisStore") : t("home.central");
      if (!byStore.has(g)) byStore.set(g, []);
      byStore.get(g).push(a);
    }
    for (const [g, list] of byStore) {
      const og = document.createElement("optgroup");
      og.label = g;
      for (const a of list) og.append(new Option(agentName(a), keyOf(a)));
      sel.append(og);
    }
    const open = (kind) => {
      const a = state.agents.find((x) => keyOf(x) === sel.value);
      if (a) this.place(i, keyOf(a), agentName(a), kind);
    };
    const term = el("button", "rt-btn", t("pane.openTerm"));
    const screen = el("button", "rt-btn", t("pane.openScreen"));
    term.disabled = screen.disabled = true;
    sel.addEventListener("change", () => (term.disabled = screen.disabled = !sel.value));
    term.addEventListener("click", () => open("term"));
    screen.addEventListener("click", () => open("screen"));
    const row = el("div", "term-empty-actions");
    row.append(term, screen);
    const hint = only === null ? t("pane.hint") : t("pane.hintStore", { store: storeName(only) || only || t("home.thisStore") });
    box.append(el("p", "muted", hint), sel, row);
    return box;
  }

  setFocus(i) {
    if (i === this.focused) return;
    this.focused = i;
    this.pane.querySelectorAll(".term-cell").forEach((c, j) => c.classList.toggle("focused", this.layout > 1 && j === i));
    this.updateTab();
    renderFleet();
  }

  closeSlot(i) {
    this.slots[i]?.twin?.close();
    this.slots[i]?.close();
    if (this.layout === 1) return this.close();
    this.slots.splice(i, 1);
    this.focused = Math.min(this.focused > i ? this.focused - 1 : this.focused, this.layout - 1);
    if (this.shells().length < 2) this.setSync(false);
    this.render();
    renderFleet();
    updateLayoutButtons();
    this.focus();
  }

  updateTab() {
    const terms = this.terms();
    const cur = this.slots[this.focused] || terms[0];
    this.dot.className = "dot " + (cur ? { wait: "wait", live: "on", dead: "dead" }[cur.state] : "");
    const kinds = new Set(terms.map((v) => this.kindOf(v)));
    this.kind.textContent = kinds.size === 2 ? t("tabkind.both") : kinds.has("screen") ? t("screen.kind") : t("tabkind.term");
    const pos = [...new Set(terms.map((v) => v.agentKey))];
    const first = terms[0];
    this.label.textContent = !first ? t("pane.empty") : pos.length > 1 ? `${first.label} +${pos.length - 1}` : first.label;
    this.tab.title = pos.map((k) => keyLabel(k)).join("\n") || t("pane.empty");
    this.label.dataset.all = t("tab.all");
    // refresh the per-pane status dots
    this.pane.querySelectorAll(".term-cell").forEach((c, i) => {
      const v = this.slots[i];
      const d = c.querySelector(".term-head .dot");
      if (v && d) d.className = "dot " + { wait: "wait", live: "on", dead: "dead" }[v.state];
    });
  }

  fit() {
    for (const t of this.terms()) t.fit();
  }

  focus() {
    (this.slots[this.focused] || this.terms()[0])?.focus();
  }

  close() {
    for (const t of this.terms()) {
      t.twin?.close();
      t.close();
    }
    this.tab.remove();
    this.pane.remove();
    state.tabs.delete(this.key);
    if (state.active === this.key) {
      const keys = [...state.tabs.keys()];
      activate(keys.length ? keys[keys.length - 1] : "fleet");
    }
  }
}

function updateLayoutButtons() {
  const tab = state.tabs.get(state.active);
  const box = $("#layout");
  const isTerm = tab instanceof TermTab;
  box.hidden = !isTerm;
  box.querySelectorAll("button[data-layout]").forEach((b) => b.classList.toggle("on", isTerm && +b.dataset.layout === tab.layout));
  const sync = $("#sync-btn");
  sync.classList.toggle("on", isTerm && tab.sync);
  sync.disabled = !isTerm || tab.shells().length < 2;
  sync.title = sync.disabled ? t("sync.disabled") : tab.sync ? t("sync.on") : t("sync.off");
}

$("#layout").addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  const t = state.tabs.get(state.active);
  if (!b || !(t instanceof TermTab)) return;
  if (b.id === "sync-btn") t.setSync(!t.sync);
  else t.setLayout(+b.dataset.layout);
});


// ---------- language ----------

document.querySelectorAll("select.lang-select").forEach((sel) => sel.addEventListener("change", () => setLang(sel.value)));

// Re-renders everything built in JS; the static markup is handled by applyI18n.
document.addEventListener("langchange", () => {
  fillMe();
  if (!$("#app").hidden) renderFleet();
  for (const tab of state.tabs.values()) {
    if (tab instanceof LogsTab || tab instanceof DeviceTab) tab.translate();
    if (tab instanceof TermTab) tab.render();
  }
  updateLayoutButtons();
});

// ---------- theme ----------

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function setTheme(next) {
  if (next === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  store.set("dea.theme", next);
  for (const term of Term.live) term.term.options.theme = termTheme();
}

document.querySelectorAll(".theme-btn").forEach((b) => b.addEventListener("click", () => setTheme(currentTheme() === "light" ? "dark" : "light")));

// ---------- boot ----------

applyI18n();
showApp().catch(() => showLogin());
