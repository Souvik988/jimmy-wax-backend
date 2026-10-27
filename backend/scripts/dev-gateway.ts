/**
 * Local stand-in for the production edge (see infrastructure/prod/Caddyfile): ONE origin for the mobile app.
 * GET read routes → experience-api, everything else → commerce-api.
 *   tsx scripts/dev-gateway.ts            (listens on :8080; override with GATEWAY_PORT, API_PORT, EXPERIENCE_PORT)
 */
import http from 'node:http';

const PORT = Number(process.env.GATEWAY_PORT ?? 8080);
const API = Number(process.env.API_PORT ?? 4000);
const EXP = Number(process.env.EXPERIENCE_PORT ?? 4001);
// experience/{channel}/preview is served by commerce-api, so experience/* matches only the bare channel path.
const READS =
  /^\/v1\/(?:(?:products|categories|store-settings|home|content|serviceability|collections|media|app\/version-check)(?:\/|\?|$)|experience\/(?:app|web)(?:\?|$))/;

http
  .createServer((req, res) => {
    const url = req.url ?? '/';
    const port = req.method === 'GET' && READS.test(url) ? EXP : API;
    const up = http.request(
      { host: '127.0.0.1', port, path: url, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'UNAVAILABLE', message: 'Backend is not running', requestId: '', retryable: true },
        }),
      );
    });
    req.pipe(up);
  })
  .listen(PORT, '0.0.0.0', () =>
    console.log(`gateway on http://0.0.0.0:${PORT} → api :${API}, reads :${EXP}`),
  );
