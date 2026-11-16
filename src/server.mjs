import { loadConfig } from './config.mjs';
import { createBridgeServer } from './relay.mjs';

let config;
try { config = loadConfig(); }
catch (err) { console.error(`Configuration error: ${err.message}`); process.exit(1); }
let diagnosticUntil = 0;
const server = createBridgeServer(config, { reasoningDiagnosticsEnabled: () => Date.now() < diagnosticUntil });
// Runtime-only toggle: off by default, expires after 10 minutes, reset on restart.
process.on('SIGUSR2', () => {
  const enabled = Date.now() >= diagnosticUntil;
  diagnosticUntil = enabled ? Date.now() + 600_000 : 0;
  console.log(JSON.stringify({ event: 'reasoning_diagnostics', enabled, ...(enabled ? { expires_at: new Date(diagnosticUntil).toISOString() } : {}) }));
});
server.once('error', () => { console.error('Server failed to listen. Check PORT and port availability.'); process.exitCode = 1; });
server.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'listening', port: config.port }));
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 15_000).unref();
  });
}
