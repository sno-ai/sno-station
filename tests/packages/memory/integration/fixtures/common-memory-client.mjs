import { connect } from '@snoai/memory/client';
let client;
process.on('message', async ({ method, args }) => {
  try {
    if (method === 'connect') {
      client = await connect(args[0]);
      process.send(client.degraded ? client : { degraded: false, principal: client.principal, pid: client.pid, port: client.port });
    } else {
      const result = await client[method](...args);
      process.send(result);
    }
  } catch (error) { process.send({ thrown: true, reason: error.reason ?? error.name }); }
});
process.send({ ready: true });
