#!/usr/bin/env node
// External Codex app-server protocol fixture; the Reach client is never replaced.
const fs = require('node:fs');
const http = require('node:http');
const { Duplex } = require('node:stream');
const { WebSocketServer } = require('ws');

const record = (value) => fs.appendFileSync(process.env.WAKE_LOG, JSON.stringify(value) + '\n');
record({ argv: process.argv.slice(2), home: process.env.CODEX_HOME });
const server = http.createServer();
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  sockets.handleUpgrade(request, socket, head, (websocket) => {
    websocket.on('message', (bytes) => {
      const request = JSON.parse(bytes.toString());
      record(request);
      if (request.id === undefined) return;
      const mode = process.env.WAKE_CASE;
      if ((mode === 'error' && request.method === 'thread/read') ||
          (mode === 'start-error' && request.method === 'thread/queue/start')) {
        websocket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: 'fixture operation refused' } }));
        return;
      }
      let result;
      switch (request.method) {
        case 'initialize': result = { userAgent: 'fixture' }; break;
        case 'thread/read': result = { thread: { status: { type: mode === 'busy' ? 'active' : 'idle' } } }; break;
        case 'thread/queue/list': result = { data: mode === 'empty' ? [] : [{ id: 'queued-message-7q' }], nextCursor: null }; break;
        case 'thread/queue/start': result = { turn: { id: 'turn-7q', status: 'inProgress' } }; break;
        default: throw new Error('Unexpected method: ' + request.method);
      }
      websocket.send(JSON.stringify({ id: request.id, result }));
    });
  });
});
server.emit('connection', Duplex.from({ readable: process.stdin, writable: process.stdout }));
