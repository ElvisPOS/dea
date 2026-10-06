// `npm start`: the UI with live reload against a real dea-server.
// DEA_URL defaults to a server on this machine; for a remote one open an SSH
// tunnel first (ssh -L 7681:localhost:7681 elvispos@<server>) or set DEA_URL.
const target = process.env.DEA_URL || 'http://127.0.0.1:7681';

export default {
  '/api': {
    target,
    ws: true,
    changeOrigin: true,
    // the server accepts WebSockets from its own origin only
    headers: { Origin: target },
  },
};
