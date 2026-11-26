export function injectHttp(app, request) {
  const method = (request.method ?? 'GET').toUpperCase();
  const headers = Object.fromEntries(Object.entries(request.headers ?? {})
    .map(([key, value]) => [key.toLowerCase(), value]));
  headers.host ??= '127.0.0.1:17860';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers.origin ??= `http://${headers.host}`;
    headers['content-type'] ??= 'application/json';
  }
  return app.inject({ ...request, headers });
}
