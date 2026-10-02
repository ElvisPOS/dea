"use strict";

// UI translations. English is the default; the choice is remembered per browser.
// Keys ending in "_html" contain markup and are only ever set from this file.

const I18N = {
  en: {
    "lang.name": "English",
    "lang.label": "Language",

    "login.tagline": "Terminals and commands for every POS",
    "login.user": "User",
    "login.password": "Password",
    "login.signin": "Sign in",
    "signout": "Sign out",

    "stats.online": "POS online",
    "stats.known": "POS known",
    "stats.stores": "stores up",
    "search.placeholder": "Search store, POS, IP…",
    "filter.all": "All",
    "filter.online": "Online",
    "filter.offline": "Offline",
    "select.shown": "Select shown",
    "select.count": "({n} selected)",
    "agents.empty": "No POS match.",
    "sort.label": "Sort",
    "sort.az": "A–Z",
    "sort.store": "Store ID",

    "tab.fleet": "Fleet",
    "tab.all": "ALL",
    "layout.1": "One terminal",
    "layout.2": "Two terminals side by side",
    "layout.4": "Four terminals",
    "sync.button": "Type in all",
    "sync.disabled": "Type in all panes: open at least two terminals in this tab",
    "sync.on": "Typing goes to ALL panes of this tab. Click to type in the focused pane only.",
    "sync.off": "Send what you type to every pane of this tab",

    "exec.title": "Run a command",
    "exec.desc_html": "Runs once on every selected POS (as the agent's user, via <code>sh -c</code>) and collects the output.",
    "exec.timeout": "Timeout",
    "exec.run": "Run on {n} selected",
    "exec.running": "Running on {n} POS…",
    "exec.succeeded": "{ok}/{n} succeeded",
    "exec.exit": "exit {code}",
    "exec.failed": "failed",
    "exec.error": "error: {msg}",

    "upstream.title": "Linked to central",
    "upstream.desc_html": "This store server forwards its POS to <code id=\"upstream-url\"></code> as store <b id=\"upstream-id\"></b>.",
    "stores.title": "Stores",
    "stores.desc_html": "POS connect to their store server and the store relays them here. To add a POS to a store, run <code>ecli rterm install</code> on the POS.",
    "store.up": "up {ago} · {on}/{n} POS online · {addr}",
    "store.offline": "offline · seen {ago} ago",
    "addStore.title": "Add a store",
    "addStore.desc_html": "On the store server run <code>ecli rterm install</code>. It finds this server from the store's <code>ecli.json</code> (or asks for its VPN IP), reads the store token below over SSH, and dials out to this server, so central never needs to reach it. Without ecli, put these settings in the store's <code>config/elvisenv</code>.",
    "addPos.title": "Add a POS",
    "addPos.titleDirect": "Add a POS directly to this server",
    "addPos.desc_html": "On the POS, as <code>elvispos</code>, run this command. It fetches the agent from the store like any POS component (share/RELEASE and share/ALL), installs it in <code>/usr/share/elvispos/rterm</code> and starts it at boot; the POS dials out, so it never has to accept inbound connections.",
    "addPos.options_html": "Options: <code>--id NAME</code> (name in this list; defaults to the hostname). Remove with <code>ecli rterm uninstall</code>, check with <code>ecli rterm status</code>.",
    "copy": "Copy",
    "copied": "Copied",

    "agent.openTerm": "Open a terminal on {key}",
    "agent.isOffline": "{key} is offline",
    "agent.up": "up {ago}",
    "agent.seen": "seen {ago} ago",
    "agent.storeOffline": "store offline",
    "agent.as": "as {user}",
    "agent.open": "{n} open",
    "agent.logs": "Logs",
    "agent.screen": "Screen",
    "agent.screenTitle": "View the screen of {id} (VNC)",
    "pane.openTerm": "Terminal",
    "pane.openScreen": "Screen",
    "pane.toTerm": "Show the terminal of this POS (the screen stays connected)",
    "pane.toScreen": "Show the screen of this POS (the terminal stays connected)",
    "screen.kind": "SCREEN",
    "screen.checking": "Checking VNC on the POS…",
    "screen.connecting": "Connecting to the screen…",
    "screen.passwordPrompt": "Enter the VNC password of this POS",
    "screen.password": "VNC password",
    "screen.connect": "Connect",
    "screen.wrongPassword": "Wrong VNC password.",
    "screen.lost": "Connection lost.",
    "screen.closed": "Disconnected.",
    "screen.retry": "Reconnect",
    "screen.noViewer": "The VNC viewer could not be loaded.",
    "screen.control": "Take control",
    "screen.viewOnly": "View only",
    "screen.viewOnlyTitle": "Watching only. Click to use mouse and keyboard on the POS.",
    "screen.controlTitle": "Your mouse and keyboard go to the POS. Click to watch only.",
    "screen.cad": "Ctrl+Alt+Del",
    "agent.logsTitle": "Browse and download the logs of {id}",
    "agent.forget": "Remove from list",
    "confirm.forget": "Remove {what} from the list? It will reappear if it connects again.",
    "store.forgetWhat": "store {id} and its POS",
    "group.direct": "direct",
    "group.selectAll": "Select all POS of this store",
    "group.up": "Store #{id} · up {ago} · {addr}",
    "group.offline": "Store #{id} · offline, seen {ago} ago",
    "group.forget": "Remove this store and its POS from the list",

    "logs.kind": "LOGS",
    "logs.tabTitle": "Logs of {name}",
    "logs.refresh": "Refresh",
    "logs.downloadSelected": "Download selected",
    "logs.downloadAll": "Download all",
    "logs.reading": "Reading the log folder…",
    "logs.none": "No log files found.",
    "logs.file": "File",
    "logs.size": "Size",
    "logs.modified": "Modified",
    "logs.download": "Download",
    "logs.ago": "{ago} ago",
    "logs.selected": "{n} selected · {size}",
    "logs.count": "{n} files · {size}",
    "logs.compressing": "Compressing on the POS…",
    "logs.downloading": "Downloading… {size}",
    "logs.saved": "Saved {name} ({size})",
    "logs.failed": "Download failed: {msg}",

    "term.connecting": "connecting to {name}…",
    "term.error": "error: {msg}",
    "term.exited": "shell exited with code {code}",
    "term.disconnected": "disconnected — press Enter to reconnect",
    "pane.empty": "empty",
    "pane.close": "Close this terminal",
    "pane.syncBadge": "TYPING IN ALL",
    "pane.choose": "Choose a POS…",
    "pane.hint": "Click a POS in the list, or choose one:",

    "unit.s": "s",
    "unit.m": "m",
    "unit.h": "h",
    "unit.d": "d",
    "time.never": "never",
  },

  it: {
    "lang.name": "Italiano",
    "lang.label": "Lingua",

    "login.tagline": "Terminali e comandi per ogni POS",
    "login.user": "Utente",
    "login.password": "Password",
    "login.signin": "Accedi",
    "signout": "Esci",

    "stats.online": "POS online",
    "stats.known": "POS noti",
    "stats.stores": "negozi attivi",
    "search.placeholder": "Cerca negozio, POS, IP…",
    "filter.all": "Tutti",
    "filter.online": "Online",
    "filter.offline": "Offline",
    "select.shown": "Seleziona visibili",
    "select.count": "({n} selezionati)",
    "select.count.one": "({n} selezionato)",
    "agents.empty": "Nessun POS trovato.",
    "sort.label": "Ordina",
    "sort.az": "A–Z",
    "sort.store": "ID negozio",

    "tab.fleet": "Flotta",
    "tab.all": "TUTTI",
    "layout.1": "Un terminale",
    "layout.2": "Due terminali affiancati",
    "layout.4": "Quattro terminali",
    "sync.button": "Scrivi in tutti",
    "sync.disabled": "Scrivi in tutti i riquadri: apri almeno due terminali in questa scheda",
    "sync.on": "Quello che scrivi va a TUTTI i riquadri di questa scheda. Fai clic per scrivere solo nel riquadro attivo.",
    "sync.off": "Invia quello che scrivi a tutti i riquadri di questa scheda",

    "exec.title": "Esegui un comando",
    "exec.desc_html": "Viene eseguito una volta su ogni POS selezionato (con l'utente dell'agent, tramite <code>sh -c</code>) e ne raccoglie l'output.",
    "exec.timeout": "Timeout",
    "exec.run": "Esegui su {n} selezionati",
    "exec.run.one": "Esegui su {n} selezionato",
    "exec.running": "Esecuzione su {n} POS…",
    "exec.succeeded": "{ok}/{n} riusciti",
    "exec.exit": "uscita {code}",
    "exec.failed": "non riuscito",
    "exec.error": "errore: {msg}",

    "upstream.title": "Collegato al server centrale",
    "upstream.desc_html": "Questo server di negozio inoltra i suoi POS a <code id=\"upstream-url\"></code> come negozio <b id=\"upstream-id\"></b>.",
    "stores.title": "Negozi",
    "stores.desc_html": "I POS si collegano al server del proprio negozio, che li inoltra qui. Per aggiungere un POS a un negozio, esegui <code>ecli rterm install</code> sul POS.",
    "store.up": "attivo da {ago} · {on}/{n} POS online · {addr}",
    "store.offline": "offline · visto {ago} fa",
    "addStore.title": "Aggiungi un negozio",
    "addStore.desc_html": "Sul server del negozio esegui <code>ecli rterm install</code>. Trova questo server dal file <code>ecli.json</code> del negozio (o chiede il suo IP VPN), legge via SSH il token del negozio qui sotto e si collega in uscita a questo server, quindi il server centrale non deve mai raggiungerlo. Senza ecli, inserisci queste impostazioni nel file <code>config/elvisenv</code> del negozio.",
    "addPos.title": "Aggiungi un POS",
    "addPos.titleDirect": "Aggiungi un POS direttamente a questo server",
    "addPos.desc_html": "Sul POS, come <code>elvispos</code>, esegui questo comando. Scarica l'agent dal negozio come ogni componente del POS (share/RELEASE e share/ALL), lo installa in <code>/usr/share/elvispos/rterm</code> e lo avvia al boot; il POS si collega in uscita, quindi non deve mai accettare connessioni in ingresso.",
    "addPos.options_html": "Opzioni: <code>--id NOME</code> (nome in questo elenco; predefinito: l'hostname). Rimozione con <code>ecli rterm uninstall</code>, verifica con <code>ecli rterm status</code>.",
    "copy": "Copia",
    "copied": "Copiato",

    "agent.openTerm": "Apri un terminale su {key}",
    "agent.isOffline": "{key} è offline",
    "agent.up": "attivo da {ago}",
    "agent.seen": "visto {ago} fa",
    "agent.storeOffline": "negozio offline",
    "agent.as": "come {user}",
    "agent.open": "{n} aperti",
    "agent.open.one": "{n} aperto",
    "agent.logs": "Log",
    "agent.screen": "Schermo",
    "agent.screenTitle": "Visualizza lo schermo di {id} (VNC)",
    "pane.openTerm": "Terminale",
    "pane.openScreen": "Schermo",
    "pane.toTerm": "Mostra il terminale di questo POS (lo schermo resta connesso)",
    "pane.toScreen": "Mostra lo schermo di questo POS (il terminale resta connesso)",
    "screen.kind": "SCHERMO",
    "screen.checking": "Verifica di VNC sul POS…",
    "screen.connecting": "Connessione allo schermo…",
    "screen.passwordPrompt": "Inserisci la password VNC di questo POS",
    "screen.password": "Password VNC",
    "screen.connect": "Connetti",
    "screen.wrongPassword": "Password VNC errata.",
    "screen.lost": "Connessione persa.",
    "screen.closed": "Disconnesso.",
    "screen.retry": "Riconnetti",
    "screen.noViewer": "Impossibile caricare il visualizzatore VNC.",
    "screen.control": "Prendi il controllo",
    "screen.viewOnly": "Solo visione",
    "screen.viewOnlyTitle": "Solo visione. Fai clic per usare mouse e tastiera sul POS.",
    "screen.controlTitle": "Mouse e tastiera vanno al POS. Fai clic per tornare alla sola visione.",
    "screen.cad": "Ctrl+Alt+Canc",
    "agent.logsTitle": "Sfoglia e scarica i log di {id}",
    "agent.forget": "Rimuovi dall'elenco",
    "confirm.forget": "Rimuovere {what} dall'elenco? Ricomparirà se si ricollega.",
    "store.forgetWhat": "il negozio {id} e i suoi POS",
    "group.direct": "diretti",
    "group.selectAll": "Seleziona tutti i POS di questo negozio",
    "group.up": "Negozio #{id} · attivo da {ago} · {addr}",
    "group.offline": "Negozio #{id} · offline, visto {ago} fa",
    "group.forget": "Rimuovi questo negozio e i suoi POS dall'elenco",

    "logs.kind": "LOG",
    "logs.tabTitle": "Log di {name}",
    "logs.refresh": "Aggiorna",
    "logs.downloadSelected": "Scarica selezionati",
    "logs.downloadAll": "Scarica tutti",
    "logs.reading": "Lettura della cartella dei log…",
    "logs.none": "Nessun file di log trovato.",
    "logs.file": "File",
    "logs.size": "Dimensione",
    "logs.modified": "Modificato",
    "logs.download": "Scarica",
    "logs.ago": "{ago} fa",
    "logs.selected": "{n} selezionati · {size}",
    "logs.selected.one": "{n} selezionato · {size}",
    "logs.count": "{n} file · {size}",
    "logs.compressing": "Compressione sul POS…",
    "logs.downloading": "Download in corso… {size}",
    "logs.saved": "Salvato {name} ({size})",
    "logs.failed": "Download non riuscito: {msg}",

    "term.connecting": "connessione a {name}…",
    "term.error": "errore: {msg}",
    "term.exited": "shell terminata con codice {code}",
    "term.disconnected": "disconnesso — premi Invio per riconnettere",
    "pane.empty": "vuoto",
    "pane.close": "Chiudi questo terminale",
    "pane.syncBadge": "SCRITTURA IN TUTTI",
    "pane.choose": "Scegli un POS…",
    "pane.hint": "Fai clic su un POS nell'elenco, oppure sceglilo:",

    "unit.s": "s",
    "unit.m": "m",
    "unit.h": "h",
    "unit.d": "g",
    "time.never": "mai",
  },
};

// Server and agent messages, translated when shown (exact text or prefix).
const I18N_ERRORS = {
  it: {
    "wrong user or password": "Utente o password errati",
    "not logged in": "Accesso non effettuato",
    "agent is offline": "il POS è offline",
    "no response from agent": "nessuna risposta dal POS",
    "agent did not open the session in time": "il POS non ha aperto la sessione in tempo",
    "the agent sent no data": "il POS non ha inviato dati",
    "no files selected": "nessun file selezionato",
    "unknown agent": "POS sconosciuto",
    "agent is online": "il POS è online",
    "unknown store": "negozio sconosciuto",
    "store is online": "il negozio è online",
    "not a log file: ": "non è un file di log: ",
    "VNC is not running on this POS": "VNC non è attivo su questo POS",
    "timed out after ": "tempo scaduto dopo ",
  },
};

const LANGS = Object.keys(I18N);
let lang = (() => {
  try {
    const saved = localStorage.getItem("rterm.lang");
    if (LANGS.includes(saved)) return saved;
  } catch {}
  return "en";
})();

// A key may have a singular form "<key>.one", used when vars.n is 1.
function t(key, vars = {}) {
  if (vars.n === 1 && ((I18N[lang] && I18N[lang][key + ".one"]) ?? I18N.en[key + ".one"])) key += ".one";
  const s = (I18N[lang] && I18N[lang][key]) ?? I18N.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

function tErr(msg) {
  const map = I18N_ERRORS[lang];
  if (!map || !msg) return msg;
  if (map[msg]) return map[msg];
  for (const [from, to] of Object.entries(map)) {
    if (from.endsWith(" ") && msg.startsWith(from)) return to + msg.slice(from.length);
  }
  return msg;
}

// Translates the static markup: data-i18n (text), data-i18n-html (markup from
// this file only), data-i18n-placeholder, data-i18n-title.
function applyI18n(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll("[data-i18n]").forEach((e) => (e.textContent = t(e.dataset.i18n)));
  root.querySelectorAll("[data-i18n-html]").forEach((e) => (e.innerHTML = t(e.dataset.i18nHtml)));
  root.querySelectorAll("[data-i18n-placeholder]").forEach((e) => (e.placeholder = t(e.dataset.i18nPlaceholder)));
  root.querySelectorAll("[data-i18n-title]").forEach((e) => (e.title = t(e.dataset.i18nTitle)));
  document.querySelectorAll("select.lang-select").forEach((s) => (s.value = lang));
}

function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  try {
    localStorage.setItem("rterm.lang", lang);
  } catch {}
  applyI18n();
  document.dispatchEvent(new Event("langchange"));
}
