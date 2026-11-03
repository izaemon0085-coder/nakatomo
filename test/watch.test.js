import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { createWatch, viewFor } from '../watch.js';

let server;
let base;
let watch;
before(async () => {
  watch = createWatch();
  server = http.createServer(createApp({ watch }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(base + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};
const sim = (action, body = {}) => call(`/api/sim/${action}`, { method: 'POST', body });
const kinds = (role = 'parent') => viewFor(watch.state(), role).feed.map((a) => a.kind);
const reset = () => watch.act('reset');
// 家のノードで見かけたことにして、そのあと見えなくなる準備
const leftHomeAt = (time, min) => {
  watch.act('setTime', { time });
  watch.state().sightings.push({ nodeId: 'home', date: '2026-11-04', min });
};

test('通学路を歩くと「学校に着いた」。先生にも学校の時間だけ届く', async () => {
  reset();
  await sim('walk', { route: 'school' });
  assert.deepEqual(kinds(), ['arrive']);
  assert.match(viewFor(watch.state(), 'parent').feed[0].text, /学校に着いた/);
  assert.deepEqual(kinds('teacher'), ['arrive'], '先生に届く');
  assert.deepEqual(kinds('friend'), [], '友達の家族には届かない');
  assert.deepEqual(kinds('family'), [], 'ふつうのお知らせは家族に届かない');
});

test('消えた：時間帯の中で15分見えない → モグ。こわれたノードのせいなら、そう知らせる', async () => {
  reset();
  leftHomeAt('07:35', 455);
  await sim('vanish');
  const f = viewFor(watch.state(), 'parent').feed;
  assert.equal(f[0].kind, 'missing');
  assert.equal(f[0].agent, 'mogu');
  assert.match(f[0].facts, /07:35、家のノード/);

  reset();
  leftHomeAt('07:35', 455);
  await sim('breakNode', { nodeId: 'park' });
  await sim('vanish');
  assert.deepEqual(kinds(), ['node'], '次のノードがこわれていれば「消えた」ではなく故障のお知らせ');
});

test('入らない場所 → フクロウがすぐアラーム。家族にもすぐ届く。見守らない日でも鳴る', async () => {
  reset();
  await call('/api/offday', { method: 'POST' });
  await sim('danger');
  assert.deepEqual(kinds(), ['danger']);
  assert.deepEqual(kinds('family'), ['danger']);
  assert.equal(viewFor(watch.state(), 'parent').feed[0].agent, 'fukurou');
});

test('SOS は全員に。友達の家族には場所も名前も出さない。110番のメモは保護者だけ', async () => {
  reset();
  await sim('walk', { route: 'school' });
  await sim('sos');
  const friend = viewFor(watch.state(), 'friend').feed;
  assert.equal(friend[0].kind, 'sos');
  assert.doesNotMatch(friend[0].text, /はると|学校/);
  assert.equal(friend[0].facts, null);
  const parent = viewFor(watch.state(), 'parent');
  assert.ok(parent.police.some((l) => /学校のノード/.test(l)));
  assert.equal(viewFor(watch.state(), 'family').police, null);
  assert.ok(kinds('teacher').includes('sos'));

  await sim('ok'); // だいじょうぶボタン
  assert.equal(viewFor(watch.state(), 'parent').police, null, '取り消したら 110番のメモは消える');
});

test('アラームはだんだん強く：保護者 → 5分で家族にも → 10分で 110番の準備。保護者が見たら止まる', async () => {
  reset();
  leftHomeAt('07:35', 455);
  await sim('vanish');
  assert.deepEqual(kinds('family'), [], 'はじめは保護者だけ');
  await sim('advance', { minutes: 5 });
  assert.deepEqual(kinds('family'), ['missing'], '5分で家族にも');
  await sim('advance', { minutes: 5 });
  assert.ok(viewFor(watch.state(), 'parent').police, '10分で 110番のメモ');
  const id = viewFor(watch.state(), 'parent').feed.find((a) => a.kind === 'missing').id;
  await call(`/api/alarms/${id}/ack`, { method: 'POST', body: { by: 'parent' } });
  assert.equal(viewFor(watch.state(), 'parent').police, null);
  assert.ok(kinds('family').includes('missing'), '家族に届いたものは、止まったあとも家族に見える');
});

test('ピンポイントの約束：通る約束（ヤマネコ）と着く約束（モグ）', async () => {
  reset(); // 水曜：14:20 ごろ公園前を通る・15:00 までにおばあちゃんの家
  watch.act('setTime', { time: '14:05' });
  await sim('walk', { route: 'detour' }); // 学校 → 交差点 → おばあちゃんの家（公園前を通らない）
  await sim('setTime', { time: '14:45' });
  assert.ok(kinds().includes('detour'));
  assert.ok(!kinds().includes('late'), 'おばあちゃんの家には着いている');

  reset();
  watch.act('setTime', { time: '15:01' });
  assert.ok(kinds().includes('late'), '15:00 をすぎても着いていない');
});

test('遅くなるボタン：今日の時間帯が30分のびる', async () => {
  reset();
  watch.act('setTime', { time: '14:00' });
  await sim('later');
  const back = viewFor(watch.state(), 'parent').windows.find((w) => w.id === 'w_back_wed');
  assert.equal(back.end, '15:30');
});

test('約束を決める：入力チェックと、ピンポイントは1日5つまで', async () => {
  reset();
  assert.equal((await call('/api/windows/w_go', { method: 'PUT', body: { start: '08:00', end: '07:00' } })).status, 400);
  assert.equal((await call('/api/windows/w_go', { method: 'PUT', body: { start: '7:40', end: '08:20' } })).status, 200);
  assert.equal((await call('/api/pinpoints', { method: 'POST', body: { type: 'arrive', nodeId: 'park', time: '25:00' } })).status, 400);
  for (let i = 0; i < 3; i++) {
    assert.equal((await call('/api/pinpoints', { method: 'POST', body: { type: 'pass', nodeId: 'cross', time: `16:0${i}` } })).status, 201);
  }
  const over = await call('/api/pinpoints', { method: 'POST', body: { type: 'pass', nodeId: 'cross', time: '17:00' } });
  assert.equal(over.status, 400, 'もともとの2つ＋3つで5つ');
  assert.match(over.data.error, /大事なところだけ/);
});

test('見守りの輪：招待コード → 説明を読んで同意 → 入る。コードは1回だけ。保護者は外せない', async () => {
  reset();
  assert.equal((await call('/api/invites', { method: 'POST', body: { role: 'parent' } })).status, 400);
  const { data: inv } = await call('/api/invites', { method: 'POST', body: { role: 'friend' } });
  const info = await call(`/api/invites/${inv.code}`);
  assert.match(info.data.cannot, /どこにいるか/);
  assert.equal((await call('/api/join', { method: 'POST', body: { code: inv.code, name: 'たなか', consent: false } })).status, 400, '同意がないと入れない');
  const joined = await call('/api/join', { method: 'POST', body: { code: inv.code, name: 'たなか', consent: true } });
  assert.equal(joined.status, 201);
  assert.equal((await call('/api/join', { method: 'POST', body: { code: inv.code, name: 'べつの人', consent: true } })).status, 404, 'コードは1回だけ');
  assert.ok(viewFor(watch.state(), 'child').watchers.some((w) => w.name === 'たなか'), '子どもにも、だれが見守っているか見せる');
  assert.equal((await call('/api/members/m_parent', { method: 'DELETE' })).status, 400);
  assert.equal((await call(`/api/members/${joined.data.id}`, { method: 'DELETE' })).status, 200);
});

test('タグには名前を入れず、番号はときどき変わる。保護者以外には番号も見せない', async () => {
  reset();
  const first = watch.state().tag.number;
  await sim('advance', { minutes: 61 });
  assert.notEqual(watch.state().tag.number, first);
  assert.equal(viewFor(watch.state(), 'family').tagNumber, undefined);
  assert.equal(viewFor(watch.state(), 'teacher').tagNumber, undefined);
});
