import http from 'node:http';

/** Create HTTP and WebSocket forwarding callbacks for a local upstream. */
export function createOfficeLanProxy(upstream, { publicProtocol = 'https' } = {}) {
  const options = request => ({
    hostname: upstream.hostname ?? '127.0.0.1',
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers: {
      ...request.headers,
      host: `${upstream.hostname ?? '127.0.0.1'}:${upstream.port}`,
      'x-forwarded-for': [request.headers['x-forwarded-for'], request.socket.remoteAddress].filter(Boolean).join(', '),
      'x-forwarded-proto': publicProtocol,
      'x-forwarded-host': request.headers.host ?? '',
    },
  });
  function onRequest(request, response) {
    const proxy = http.request(options(request), upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    proxy.on('error', () => {
      if (!response.headersSent) { response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Office service is unavailable.'); }
      else response.destroy();
    });
    request.pipe(proxy);
  }
  function onUpgrade(request, socket, head) {
    const proxy = http.request(options(request));
    let upstreamSocket;
    const closeBoth = () => { proxy.destroy(); upstreamSocket?.destroy(); if (!socket.destroyed) socket.destroy(); };
    socket.once('close', () => { proxy.destroy(); upstreamSocket?.destroy(); });
    socket.once('end', closeBoth);
    socket.once('error', closeBoth);
    proxy.once('error', () => { if (!socket.destroyed) socket.destroy(); upstreamSocket?.destroy(); });
    proxy.on('upgrade', (response, upstreamConnection, upstreamHead) => {
      upstreamSocket = upstreamConnection;
      if (socket.destroyed) { upstreamSocket.destroy(); return; }
      const status = `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ''}\r\n`;
      const headers = response.rawHeaders.reduce((lines, value, index, all) => index % 2 ? lines : [...lines, `${value}: ${all[index + 1]}`], []);
      socket.write(`${status}${headers.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const close = closeBoth;
      upstreamSocket.once('end', close);
      upstreamSocket.on('error', close);
      socket.on('error', close);
      upstreamSocket.on('close', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
    });
    proxy.on('response', response => {
      socket.write(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`);
      response.pipe(socket);
    });
    proxy.on('error', () => socket.destroy());
    proxy.end();
  }
  return { onRequest, onUpgrade };
}
