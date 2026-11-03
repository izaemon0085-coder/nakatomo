// なかとも（デモ版）：見守りの API と画面（public/）の配信。外部パッケージなし
// ※デモ版はログインがなく、画面の「だれとして見る」で役割を切りかえる。本番の前にログインと保護者の同意の決まりを作る
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWatch, viewFor, HttpError, ROLES, hm } from './watch.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024) throw new HttpError(413, 'リクエストが大きすぎます');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません');
  }
}

export function createApp({ watch = createWatch() } = {}) {
  const s = () => watch.state();
  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],
    // 役割ごとの画面のデータ（保護者・家族・先生・友達の家族・子ども）
    ['GET', /^\/api\/view$/, ({ query }) => viewFor(s(), query.get('role') || 'parent')],

    // シミュレーター（デモで見せる人が使う）
    ['GET', /^\/api\/demo$/, () => ({
      clock: { date: s().clock.date, time: hm(s().clock.min) },
      nodes: s().nodes,
      tagNumber: s().tag.number,
      trail: s().sightings.filter((x) => x.date === s().clock.date).map((x) => ({ time: hm(x.min), nodeId: x.nodeId })),
    })],
    ['POST', /^\/api\/sim\/(\w+)$/, ({ params, body }) => {
      watch.act(params[0], body);
      return { ok: true };
    }],

    ['POST', /^\/api\/alarms\/([\w-]+)\/ack$/, ({ params, body }) => {
      watch.ack(params[0], ROLES[body.by] ? body.by : 'parent');
      return { ok: true };
    }],

    // 約束（保護者）
    ['PUT', /^\/api\/windows\/([\w-]+)$/, ({ params, body }) => {
      watch.setWindow(params[0], body);
      return { ok: true };
    }],
    ['POST', /^\/api\/pinpoints$/, ({ body }) => [201, watch.addPinpoint(body)]],
    ['DELETE', /^\/api\/pinpoints\/([\w-]+)$/, ({ params }) => {
      watch.removePinpoint(params[0]);
      return { ok: true };
    }],
    ['POST', /^\/api\/offday$/, () => {
      watch.toggleOffDay();
      return { ok: true };
    }],

    // 見守りの輪
    ['POST', /^\/api\/invites$/, ({ body }) => [201, watch.invite(body.role)]],
    ['GET', /^\/api\/invites\/(\d+)$/, ({ params }) => {
      const inv = watch.lookupInvite(params[0]);
      return { role: inv.role, ...ROLES[inv.role] };
    }],
    ['POST', /^\/api\/join$/, ({ body }) => [201, watch.join(body)]],
    ['DELETE', /^\/api\/members\/([\w-]+)$/, ({ params }) => {
      watch.leave(params[0]);
      return { ok: true };
    }],
  ];

  function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function serveStatic(pathname, res) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'URL が正しくありません');
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(PUBLIC, `.${rel}`);
    if (!file.startsWith(PUBLIC + sep)) throw new HttpError(403, 'Forbidden');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'Not Found');
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const [method, pattern, fn] of routes) {
          const m = url.pathname.match(pattern);
          if (!m || method !== req.method) continue;
          const body = method === 'POST' || method === 'PUT' ? await readJson(req) : {};
          const result = await fn({ params: m.slice(1), body, query: url.searchParams });
          const [status, data] = Array.isArray(result) && typeof result[0] === 'number' ? result : [200, result];
          return sendJson(res, status, data);
        }
        throw new HttpError(404, 'API が見つかりません');
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return sendJson(res, status, { error: status === 500 ? 'サーバーエラーが発生しました' : err.message });
    }
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3200;
  http.createServer(createApp()).listen(port, () => {
    console.log(`なかとも（デモ版）起動: http://localhost:${port}/`);
  });
}
