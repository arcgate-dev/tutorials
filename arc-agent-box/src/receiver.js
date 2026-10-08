import { createServer } from 'node:http';

// The webhook receiver: the URL a webhook channel points at, run on your machine behind a tunnel.
// It answers arcgate's ownership challenge, {type: 'challenge', channelId, challenge}, with {challenge},
// and prints each message arcgate pushes. It does not check ARCGATE-SIGNATURE: the channel step does not keep
// the channel's secret. A receiver you keep must check it (see the Channels section of the API docs).
const port = Number(process.env.PORT || 8787);

createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON: answered 400 below */ }
    if (req.method !== 'POST' || !body) {
      res.writeHead(400).end();
      return;
    }
    if (body.type === 'challenge') {
      console.log(`Challenge for channel ${body.channelId}: echoed.`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: body.challenge }));
      return;
    }
    const signed = req.headers['arcgate-signature'] && req.headers['arcgate-timestamp'] ? `ARCGATE-SIGNATURE present, timestamp ${req.headers['arcgate-timestamp']}, not checked` : 'unsigned';
    console.log(`Pushed: ${body.type} seq ${body.seq} (${signed}; untrusted content, not printed)`);
    res.writeHead(204).end();
  });
}).listen(port, '127.0.0.1', () => console.log(`Receiver listening on http://localhost:${port}`));
