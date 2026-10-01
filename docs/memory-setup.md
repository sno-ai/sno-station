# Set up the shared memory service for the first release

Codex, Claude Code, OpenClaw, and Hermes use the same npm memory service and the same
`~/.sno/settings.json`. Complete this setup once before installing an agent plugin. The first
release uses Local First mode and does not require Sno CLI.

Install Node.js 22.22.3+, 24.15.0+, or 25.9.0+, then run the commands below. With npm 12 or newer
(check with `npm --version`), npm blocks install scripts by default and the memory service cannot start. Run
`cd "$HOME/.sno" && npm install-scripts approve --all && npm rebuild` right after the `npm install` line,
before the settings step.

```bash
npm install --prefix "$HOME/.sno" @snoai/memory@1.0.1 @snoai/embedder@1.0.1
node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(homedir(), '.sno');
const memory = join(root, 'node_modules', '@snoai', 'memory');
const settings = JSON.parse(readFileSync(join(memory, 'settings.default.json'), 'utf8'));
settings.mode = 'local-first';
settings.store = { ...settings.store, path: join(root, 'memory.sqlite'), encryptionKey: randomBytes(32).toString('hex') };
settings.memoryPackage = { path: memory, node: process.execPath };
settings.embedding = { ...settings.embedding, cacheDir: join(root, 'models') };
settings.rerank = { ...settings.rerank, mode: 'none' };
settings.rem = { ...settings.rem, tick: false };
settings.telemetry = { ...settings.telemetry, observe: { ...settings.telemetry.observe, enabled: false } };
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
const embedder = join(root, 'node_modules', '@snoai', 'embedder', 'dist', 'index.mjs');
const { ensureModelDownloaded } = await import(pathToFileURL(embedder).href);
await ensureModelDownloaded({ cacheDir: settings.embedding.cacheDir, dtype: settings.embedding.dtype });
NODE
```

The model download is part of setup, so the first agent session does not have to wait for it.
Do not rerun the settings block for an existing store: it replaces the encryption key and the
old memories become unreadable. Keep a private backup of `settings.json` with your memory store.
The memory service starts when a plugin needs it; there is no separate start command.
