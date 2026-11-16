// Claude's asynchronous observer must not call memory or alter the event.
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.argv[2], `${readFileSync(0, 'utf8').trim()}\n`, { mode: 0o600 });
