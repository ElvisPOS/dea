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
  filter: "all",
  sort: store.get("rterm.sort", "az"), // "az" | "store"
  query: "",
  selected: new Set(), // agent keys
  collapsed: new Set(store.get("rterm.collapsed", [])),
  tabs: new Map(), // tab key -> TermTab
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

// Server-provided texts in the static cards (re-run after a language change,
// which re-creates the translated markup).
function fillMe() {
  const me = state.me;
  if (!me) return;
  $("#upstream-card").hidden = !me.upstream;
  $("#upstream-url").textContent = me.upstream || "";
  $("#upstream-id").textContent = me.store_id || "";
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

// ---------- agent list ----------

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
  const known = new Set(state.agents.map(keyOf));
  for (const k of state.selected) if (!known.has(k)) state.selected.delete(k);
  renderAgents();
  renderStores();
}

function visibleAgents() {
  const q = state.query.toLowerCase();
  return state.agents.filter((a) => {
    if (state.filter === "online" && !a.online) return false;
    if (state.filter === "offline" && a.online) return false;
    if (!q) return true;
    return [a.id, a.name, a.device_id, a.store, storeName(a.store), a.hostname, a.os, a.remote_addr, ...(a.ips || [])].some((v) => v && v.toLowerCase().includes(q));
  });
}

function storeById(id) {
  return state.stores.find((s) => s.id === id);
}

// Name from system.store for a store path ("12" or "12/sub"), if central knows it.
function storeName(path) {
  if (!path) return "";
  const st = storeById(path.split("/")[0]);
  return (st && st.name) || "";
}

// "001707 AMACO Fiume Veneto › memphis-pos-169" for an agent key such as "12/memphis-pos-169".
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
  const store = key.slice(0, i);
  return `${storeName(store) || store} › ${pos}`;
}

async function forget(path, what) {
  if (!confirm(t("confirm.forget", { what }))) return;
  await api(path, { method: "DELETE" }).catch((e) => alert(tErr(e.message)));
  refreshAgents();
}

function agentRow(a, activeKey) {
  const key = keyOf(a);
  const li = el("div", "agent" + (a.online ? "" : " offline") + (key === activeKey ? " active" : ""));
  li.title = a.online ? t("agent.openTerm", { key: keyLabel(key) }) : t("agent.isOffline", { key: keyLabel(key) });

  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = state.selected.has(key);
  cb.addEventListener("click", (ev) => ev.stopPropagation());
  cb.addEventListener("change", () => {
    cb.checked ? state.selected.add(key) : state.selected.delete(key);
    renderAgents();
  });

  const main = el("div", "agent-main");
  const idLine = el("div", "agent-id");
  const name = el("span", null, agentName(a));
  name.title = a.name ? `${a.name} · ${a.id}` : a.id;
  idLine.append(el("span", "dot" + (a.online ? " on" : "")), name);
  const ip = (a.ips && a.ips[0]) || (a.remote_addr || "").replace(/:\d+$/, "");
  const st = a.store && storeById(a.store.split("/")[0]);
  let when = a.online ? t("agent.up", { ago: ago(a.connected_at) }) : t("agent.seen", { ago: ago(a.last_seen) });
  if (st && !st.online) when = t("agent.storeOffline");
  const sub = el("div", "agent-sub", [a.name && a.id, ip, when].filter(Boolean).join(" · "));
  sub.title = [a.hostname, a.device_id && `device #${a.device_id}`, a.user && t("agent.as", { user: a.user }), a.os, a.arch, `agent ${a.version}`, `from ${a.remote_addr}`]
    .filter(Boolean)
    .join(" · ");
  main.append(idLine, sub);

  const right = el("div", "agent-actions");
  if (a.sessions > 0) {
    const badge = el("span", "badge live", String(a.sessions));
    badge.title = t("agent.open", { n: a.sessions });
    right.append(badge);
  }
  if (a.online) {
    const logs = el("button", "row-btn", t("agent.logs"));
    logs.title = t("agent.logsTitle", { id: agentName(a) });
    logs.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openLogs(key, agentName(a));
    });
    const screen = el("button", "row-btn", t("agent.screen"));
    screen.title = t("agent.screenTitle", { id: agentName(a) });
    screen.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openScreen(key, agentName(a));
    });
    right.append(screen, logs);
  }
  if (!a.online && !(st && !st.online)) {
    const x = el("button", "forget", "×");
    x.title = t("agent.forget");
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      forget(`/api/agents/${key.split("/").map(encodeURIComponent).join("/")}`, key);
    });
    right.append(x);
  }

  li.append(cb, main, right);
  if (a.online) li.addEventListener("click", () => openTerminal(key, agentName(a)));
  return li;
}

function renderAgents() {
  const list = $("#agents");
  const shown = visibleAgents();
  const activeKey = state.tabs.get(state.active)?.agentKey;

  // Group by store ("" = agents connected directly to this server).
  const groups = new Map();
  for (const s of state.stores) groups.set(s.id, []);
  for (const a of shown) {
    const g = a.store || "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(a);
  }
  const names = [...groups.keys()].sort(compareGroups);
  for (const list of groups.values()) list.sort(compareAgents);
  const filtering = state.query || state.filter !== "all";
  const useGroups = state.stores.length > 0;

  const nodes = [];
  for (const name of names) {
    const members = groups.get(name);
    if (!members.length && (filtering || name === "")) continue;
    if (!useGroups) {
      nodes.push(...members.map((a) => agentRow(a, activeKey)));
      continue;
    }
    const st = storeById(name.split("/")[0]);
    const all = state.agents.filter((a) => (a.store || "") === name);
    const onlineN = all.filter((a) => a.online).length;
    const collapsed = state.collapsed.has(name) && !state.query;

    const group = el("div", "group" + (collapsed ? " collapsed" : ""));
    const head = el("div", "group-head");
    const cb = el("input");
    cb.type = "checkbox";
    const nSel = members.filter((a) => state.selected.has(keyOf(a))).length;
    cb.checked = members.length > 0 && nSel === members.length;
    cb.indeterminate = nSel > 0 && nSel < members.length;
    cb.disabled = members.length === 0;
    cb.title = t("group.selectAll");
    cb.addEventListener("click", (ev) => ev.stopPropagation());
    cb.addEventListener("change", () => {
      for (const a of members) cb.checked ? state.selected.add(keyOf(a)) : state.selected.delete(keyOf(a));
      renderAgents();
    });
    const label = el("span", "name");
    label.append(el("span", "dot" + (!st || st.online ? " on" : "")));
    if (state.sort === "store" && st && storeName(name)) label.append(el("span", "store-id-prefix", st.id));
    label.append(el("span", "group-name", storeName(name) || name || t("group.direct")));
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "6px";
    if (st) label.title = st.online ? t("group.up", { id: st.id, ago: ago(st.connected_at), addr: st.remote_addr }) : t("group.offline", { id: st.id, ago: ago(st.last_seen) });
    const tail = el("span");
    if (st && !st.online) {
      const x = el("button", "forget", "×");
      x.title = t("group.forget");
      x.addEventListener("click", (ev) => {
        ev.stopPropagation();
        forget(`/api/stores/${encodeURIComponent(st.id)}`, t("store.forgetWhat", { id: st.id }));
      });
      tail.append(x);
    }
    head.append(el("span", "caret", "▾"), cb, label, el("span", null, `${onlineN}/${all.length}`), tail);
    head.addEventListener("click", () => {
      state.collapsed.has(name) ? state.collapsed.delete(name) : state.collapsed.add(name);
      store.set("rterm.collapsed", [...state.collapsed]);
      renderAgents();
    });
    const body = el("div", "group-body");
    body.append(...members.map((a) => agentRow(a, activeKey)));
    group.append(head, body);
    nodes.push(group);
  }
  list.replaceChildren(...nodes);
  $("#agents-empty").hidden = shown.length > 0;

  $("#stat-online").textContent = state.agents.filter((a) => a.online).length;
  $("#stat-total").textContent = state.agents.length;
  $("#stat-stores").textContent = `${state.stores.filter((s) => s.online).length}/${state.stores.length}`;
  updateSelection(shown);
}

function renderStores() {
  $("#stores-card").hidden = state.stores.length === 0;
  $("#stores-list").replaceChildren(
    ...[...state.stores].sort((a, b) => compareGroups(a.id, b.id)).map((s) => {
      const box = el("div", "store");
      const head = el("div", "store-head");
      const all = state.agents.filter((a) => (a.store || "").split("/")[0] === s.id);
      head.append(
        el("span", "dot" + (s.online ? " on" : "")),
        el("b", null, s.name || s.id),
        ...(s.name ? [el("span", "store-id", `#${s.id}`)] : []),
        el("span", "muted", s.online ? t("store.up", { ago: ago(s.connected_at), on: all.filter((a) => a.online).length, n: all.length, addr: s.remote_addr }) : t("store.offline", { ago: ago(s.last_seen) }))
      );
      box.append(head);
      return box;
    })
  );
}

function updateSelection(shown = visibleAgents()) {
  const all = $("#select-all");
  const nShown = shown.filter((a) => state.selected.has(keyOf(a))).length;
  all.checked = shown.length > 0 && nShown === shown.length;
  all.indeterminate = nShown > 0 && nShown < shown.length;
  const n = state.selected.size;
  $("#sel-count").textContent = n ? t("select.count", { n }) : "";
  const btn = $("#exec-run");
  btn.textContent = t("exec.run", { n });
  btn.disabled = n === 0 || btn.dataset.busy === "1";
}

$("#select-all").addEventListener("change", (ev) => {
  for (const a of visibleAgents()) ev.target.checked ? state.selected.add(keyOf(a)) : state.selected.delete(keyOf(a));
  renderAgents();
});

$("#search").addEventListener("input", (ev) => {
  state.query = ev.target.value.trim();
  renderAgents();
});

document.querySelectorAll("#filter-seg button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#filter-seg button").forEach((x) => x.classList.toggle("on", x === b));
    state.filter = b.dataset.filter;
    renderAgents();
  })
);

// ---------- sorting ----------

function collator() {
  return new Intl.Collator(lang, { numeric: true, sensitivity: "base" });
}

function compareIds(a, b) {
  const x = Number(a), y = Number(b);
  if (a !== "" && b !== "" && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return collator().compare(a, b);
}

// Store groups: by name (A–Z) or numeric id; agents connected directly ("") last.
function compareGroups(x, y) {
  if ((x === "") !== (y === "")) return x === "" ? 1 : -1;
  if (state.sort === "store") return compareIds(x, y);
  return collator().compare(storeName(x) || x, storeName(y) || y) || compareIds(x, y);
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

function updateSortButtons() {
  document.querySelectorAll("#sort-seg button").forEach((x) => x.classList.toggle("on", x.dataset.sort === state.sort));
}

document.querySelectorAll("#sort-seg button").forEach((b) =>
  b.addEventListener("click", () => {
    state.sort = b.dataset.sort;
    store.set("rterm.sort", state.sort);
    updateSortButtons();
    renderAgents();
    renderStores();
  })
);
updateSortButtons();

// ---------- run command ----------

$("#exec-run").addEventListener("click", async () => {
  const cmd = $("#exec-cmd").value.trim();
  if (!cmd) return $("#exec-cmd").focus();
  const agents = [...state.selected].sort();
  const btn = $("#exec-run");
  const out = $("#exec-results");
  btn.dataset.busy = "1";
  updateSelection();
  out.replaceChildren(el("p", "muted", t("exec.running", { n: agents.length })));
  try {
    const results = await api("/api/exec", {
      method: "POST",
      body: JSON.stringify({ agents, cmd, timeout: +$("#exec-timeout").value }),
    });
    results.sort((a, b) => (a.ok && a.code === 0) - (b.ok && b.code === 0) || a.id.localeCompare(b.id));
    const okCount = results.filter((r) => r.ok && r.code === 0).length;
    out.replaceChildren(
      el("p", "muted", t("exec.succeeded", { ok: okCount, n: results.length })),
      ...results.map((r) => {
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
      })
    );
  } catch (e) {
    out.replaceChildren(el("p", "error", tErr(e.message)));
  } finally {
    btn.dataset.busy = "";
    updateSelection();
  }
});

$("#exec-cmd").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) $("#exec-run").click();
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
  renderAgents();
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

// Opens a shell on a POS: in the focused empty pane of the current split tab,
// otherwise in a new tab.
function openTerminal(agentKey, label, kind = "term") {
  const cur = state.tabs.get(state.active);
  // already open in this tab: switch that pane instead of opening another one
  const open = cur instanceof TermTab ? cur.slotOf(agentKey) : -1;
  if (open >= 0) {
    cur.setFocus(open);
    cur.showKind(open, kind);
    cur.focus();
    return;
  }
  const free = cur instanceof TermTab ? cur.freeSlot() : -1;
  if (free >= 0) {
    cur.place(free, agentKey, label, kind);
    renderAgents();
    return;
  }
  const t = new TermTab();
  state.tabs.set(t.key, t);
  activate(t.key);
  t.place(0, agentKey, label, kind);
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
class Term {
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
      theme: { background: "#0d1117", foreground: "#d8dee9", cursor: "#4fb3ff", selectionBackground: "#2a4a66" },
    });
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
    rfb.background = "#0d1117";
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
class TermTab {
  constructor() {
    this.key = `t${++tabSeq}`;
    this.layout = 1;
    this.focused = 0;
    this.slots = [null, null, null, null];
    this.sync = false; // "Type in all": keystrokes go to every connected pane

    this.tab = el("button", "tab");
    this.tab.dataset.tab = this.key;
    this.dot = el("span", "dot wait");
    this.label = el("span", "tab-label");
    this.tab.append(this.dot, this.label, el("span", "tab-close", "×"));
    $("#tabs").append(this.tab);

    this.pane = el("div", "pane term");
    this.pane.dataset.pane = this.key;
    $("#panes").append(this.pane);
  }

  // The focused POS, used to highlight it in the sidebar.
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
    if (this.focused < this.layout && !this.slots[this.focused]) return this.focused;
    for (let i = 0; i < this.layout; i++) if (!this.slots[i]) return i;
    return -1;
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

  // The pane showing a POS, or -1.
  slotOf(agentKey) {
    return this.slots.findIndex((v, i) => i < this.layout && v && v.agentKey === agentKey);
  }

  kindOf(v) {
    return v instanceof ScreenView ? "screen" : "term";
  }

  // Shows the terminal or the screen of the POS in pane i. The other one stays
  // connected in the background (as the pane's "twin"), so switching back is
  // instant: the shell keeps its state and the screen needs no new password.
  showKind(i, kind) {
    const v = this.slots[i];
    if (!v || this.kindOf(v) === kind) return;
    let w = v.twin;
    if (!w) {
      w = kind === "screen" ? new ScreenView(v.agentKey, v.label) : new Term(v.agentKey, v.label, () => this.updateTab());
      w.twin = v;
      v.twin = w;
      this.wire(w);
      this.slots[i] = w;
      this.focused = i;
      this.render();
      w.connect();
    } else {
      this.slots[i] = w;
      this.focused = i;
      this.render();
    }
    if (this.shells().length < 2) this.setSync(false);
    updateLayoutButtons();
    renderAgents();
    requestAnimationFrame(() => w.focus());
  }

  setLayout(n) {
    if (n === this.layout) return;
    // compact terminals into the first panes, then move the overflow to new tabs
    const terms = this.terms();
    this.slots = [null, null, null, null];
    terms.slice(0, n).forEach((t, i) => (this.slots[i] = t));
    for (const t of terms.slice(n)) {
      const tab = new TermTab();
      state.tabs.set(tab.key, tab);
      tab.adopt(0, t);
    }
    this.layout = n;
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

  render() {
    const n = this.layout;
    this.pane.className = `pane term split-${n}` + (state.active === this.key ? " on" : "") + (this.sync ? " sync" : "");
    const cells = [];
    for (let i = 0; i < n; i++) {
      const t = this.slots[i];
      const cell = el("div", "term-cell" + (n > 1 && i === this.focused ? " focused" : ""));
      cell.addEventListener("mousedown", () => this.setFocus(i));
      cell.append(this.cellHead(i, t));
      const body = el("div", "term-body");
      body.append(t ? t.el : this.emptyCell(i));
      cell.append(body);
      cells.push(cell);
    }
    this.pane.replaceChildren(...cells);
    requestAnimationFrame(() => this.fit());
    this.updateTab();
  }

  cellHead(i, term) {
    const head = el("div", "term-head");
    if (!term) {
      head.append(el("span", "muted", t("pane.empty")));
      return head;
    }
    const x = el("button", "term-head-close", "×");
    x.title = t("pane.close");
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.closeSlot(i);
    });
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
      head.append(dot, this.kindSwitch(i, term), name, el("span", "spacer"), ctl, cad, x);
      return head;
    }
    const all = el("span", "term-head-sync", t("pane.syncBadge"));
    head.append(dot, this.kindSwitch(i, term), name, el("span", "spacer"), all, x);
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
    const sel = el("select");
    sel.append(new Option(t("pane.choose"), ""));
    const byStore = new Map();
    for (const a of state.agents.filter((a) => a.online)) {
      const g = a.store ? storeName(a.store) || a.store : t("group.direct");
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
    const term = el("button", "btn small", t("pane.openTerm"));
    const screen = el("button", "btn small", t("pane.openScreen"));
    term.disabled = screen.disabled = true;
    sel.addEventListener("change", () => (term.disabled = screen.disabled = !sel.value));
    term.addEventListener("click", () => open("term"));
    screen.addEventListener("click", () => open("screen"));
    const row = el("div", "term-empty-actions");
    row.append(term, screen);
    box.append(el("p", "muted", t("pane.hint")), sel, row);
    return box;
  }

  setFocus(i) {
    if (i === this.focused) return;
    this.focused = i;
    this.pane.querySelectorAll(".term-cell").forEach((c, j) => c.classList.toggle("focused", this.layout > 1 && j === i));
    this.updateTab();
    renderAgents();
  }

  closeSlot(i) {
    this.slots[i]?.twin?.close();
    this.slots[i]?.close();
    this.slots[i] = null;
    if (this.terms().length === 0 && this.layout === 1) return this.close();
    if (this.shells().length < 2) this.setSync(false);
    this.render();
    renderAgents();
    updateLayoutButtons();
  }

  updateTab() {
    const terms = this.terms();
    const cur = this.slots[this.focused] || terms[0];
    this.dot.className = "dot " + (cur ? { wait: "wait", live: "on", dead: "dead" }[cur.state] : "");
    this.label.textContent = terms.length > 1 ? `${terms[0].label} +${terms.length - 1}` : cur ? cur.label : t("pane.empty");
    this.tab.title = terms.map((x) => keyLabel(x.agentKey)).join("\n") || t("pane.empty");
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
  if (!$("#app").hidden) {
    renderAgents();
    renderStores();
  }
  for (const tab of state.tabs.values()) {
    if (tab instanceof LogsTab) tab.translate();
    if (tab instanceof TermTab) tab.render();
  }
  updateLayoutButtons();
});

// ---------- boot ----------

applyI18n();
showApp().catch(() => showLogin());
