// なかとも（デモ版）の頭脳：にせのタグ・ノード・約束・見守りの輪と、アラームの判定。
// 時計もにせもの（デモで「時計を進める」ため）。時刻は「その日の 0 時からの分」で持つ
// 本物のタグ・ノード（BLE・LoRa）は、このあと。データはメモリの中だけ（再起動・リセットで初期状態）
import { randomUUID, randomInt } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const newId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;
export const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new HttpError(400, '時刻は 08:15 のように入れてください');
  return Number(m[1]) * 60 + Number(m[2]);
};
// 曜日（0=日）。日付だけで計算して、タイムゾーンにふりまわされないようにする
export const weekday = (date) => {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
};
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

export const MISSING_MIN = 15; // 時間帯の中で、これだけ見えなければ「消えた」
export const GRACE_MIN = 15; // 時間帯には少し余裕をもたせる
export const KEEP_DAYS = 30; // 見かけた記録は30日で消す
export const MAX_PINPOINTS_PER_DAY = 5; // 約束が多すぎると、まちがいのアラームが増える

export const ROLES = {
  parent: { label: '保護者', can: '約束を決める・すべてのアラームを受け取る・人を招待する', cannot: '―' },
  family: { label: '家族・親戚', can: 'アラームを受け取る（保護者が気づかないとき・SOS・危険）', cannot: '約束の設定を変えること' },
  teacher: { label: '先生', can: '学校の時間だけ：学校に着いた／まだ着いていない・SOS を受け取る', cannot: '学校の外での動き' },
  friend: { label: '友達の家族', can: 'タグを見かけたら中継する・SOS が出たことを知る', cannot: '子どもがどこにいるか・だれのタグか' },
};

const AGENT = {
  yamaneko: { id: 'yamaneko', name: 'ヤマネコ' },
  usagi: { id: 'usagi', name: 'ウサギ' },
  fukurou: { id: 'fukurou', name: 'フクロウ' },
  shiba: { id: 'shiba', name: 'シバ' },
  mogu: { id: 'mogu', name: 'モグ' },
};

function seed() {
  const nodes = [
    { id: 'home', name: '家', kind: 'home', ok: true },
    { id: 'park', name: '公園前', kind: 'route', ok: true },
    { id: 'cross', name: '交差点', kind: 'route', ok: true },
    { id: 'school', name: '学校', kind: 'school', ok: true },
    { id: 'grandma', name: 'おばあちゃんの家', kind: 'place', ok: true },
    { id: 'rail', name: '線路わき', kind: 'danger', ok: true },
  ];
  return {
    childName: 'はると', // デモの子ども（タグには名前を入れない。名前は保護者のアプリの中だけ）
    tag: { number: randomInt(100000, 999999), rotatedAt: 0 },
    clock: { date: '2026-11-04', min: 7 * 60 + 20 }, // 水曜日の朝
    nodes,
    windows: [
      { id: 'w_go', label: '通学', from: 'home', to: 'school', route: ['home', 'park', 'cross', 'school'], days: [1, 2, 3, 4, 5], start: 450, end: 495 },
      { id: 'w_back', label: '帰宅', from: 'school', to: 'home', route: ['school', 'cross', 'park', 'home'], days: [1, 2, 4, 5], start: 900, end: 960 },
      { id: 'w_back_wed', label: '帰宅（水曜）', from: 'school', to: 'grandma', route: ['school', 'cross', 'park', 'grandma'], days: [3], start: 840, end: 900 },
    ],
    pinpoints: [
      { id: 'p_pass', type: 'pass', nodeId: 'park', at: 14 * 60 + 20, tolerance: 20, days: [3], todayOnly: false },
      { id: 'p_arrive', type: 'arrive', nodeId: 'grandma', at: 15 * 60, days: [3], todayOnly: true, date: '2026-11-04' },
      { id: 'p_avoid', type: 'avoid', nodeId: 'rail', always: true },
    ],
    offDays: [], // 見守らない日（YYYY-MM-DD）
    schoolHours: { start: 8 * 60, end: 15 * 60 },
    members: [
      { id: 'm_parent', name: 'おかあさん', role: 'parent', consentAt: '2026-11-01' },
      { id: 'm_grandma', name: 'おばあちゃん', role: 'family', consentAt: '2026-11-01' },
      { id: 'm_teacher', name: '〇〇先生', role: 'teacher', consentAt: '2026-11-02' },
    ],
    invites: [],
    sightings: [], // { nodeId, date, min }
    alarms: [], // { id, key, kind, level, agent, text, facts, date, min, ackedAt, cancelled }
    relayCount: 0,
  };
}

// ---- 判定のための小さな関数 ----
const nodeById = (s, id) => s.nodes.find((n) => n.id === id);
const sightingsToday = (s) => s.sightings.filter((x) => x.date === s.clock.date);
const seenAt = (s, nodeId, from, to) => sightingsToday(s).some((x) => x.nodeId === nodeId && x.min >= from && x.min <= to);
const lastSeen = (s) => sightingsToday(s).at(-1) || null;
const isOffDay = (s) => s.offDays.includes(s.clock.date) || [0, 6].includes(weekday(s.clock.date));
const pinpointsToday = (s) => s.pinpoints.filter((p) => {
  if (p.always) return true;
  if (p.todayOnly) return p.date === s.clock.date;
  return p.days?.includes(weekday(s.clock.date));
});
const windowsToday = (s) => s.windows.filter((w) => w.days.includes(weekday(s.clock.date)));

function raise(s, alarm) {
  if (s.alarms.some((a) => a.key === alarm.key)) return null; // 同じことは1回だけ
  const a = { id: newId('a'), date: s.clock.date, min: s.clock.min, ackedAt: null, cancelled: false, facts: null, ...alarm };
  s.alarms.push(a);
  return a;
}

// 最後に見かけた場所と時刻（ヤマネコが言う「事実」）
function facts(s) {
  const last = lastSeen(s);
  return last ? `最後に見かけたのは ${hm(last.min)}、${nodeById(s, last.nodeId).name}のノード` : '今日はまだ、どのノードでも見かけていない';
}

// いまの時刻で、アラームを出すべきことがないか調べる（状態が変わるたびに呼ぶ）
export function evaluate(s) {
  const now = s.clock.min;
  const date = s.clock.date;
  const name = s.childName;

  // 🚫 入らない場所：いつでも（見守らない日でも）
  for (const p of pinpointsToday(s).filter((x) => x.type === 'avoid')) {
    const hit = sightingsToday(s).find((x) => x.nodeId === p.nodeId);
    if (hit) {
      raise(s, {
        key: `danger:${date}:${p.nodeId}:${hit.min}`, kind: 'danger', level: 'alarm', agent: 'fukurou',
        text: `ほう…！ ${name}さんのタグを「${nodeById(s, p.nodeId).name}」で見かけましたぞ。入らない約束の場所です。`,
        facts: facts(s),
      });
    }
  }
  if (isOffDay(s)) return;

  // 時間帯：着いた（お知らせ）・消えた・着いていない
  for (const w of windowsToday(s)) {
    const arrived = seenAt(s, w.to, w.start - 30, w.end + GRACE_MIN + 120);
    if (arrived) {
      const at = sightingsToday(s).find((x) => x.nodeId === w.to && x.min >= w.start - 30);
      raise(s, {
        key: `arrive:${date}:${w.id}`, kind: 'arrive', level: 'info', agent: 'shiba',
        text: `${hm(at.min)} ${nodeById(s, w.to).name}に着いたっす！`, school: w.to === 'school',
      });
      continue;
    }
    if (now < w.start || now > w.end + GRACE_MIN + 120) continue;
    const seenInWindow = sightingsToday(s).filter((x) => x.min >= w.start - 30 && w.route.includes(x.nodeId));
    const ref = Math.max(seenInWindow.at(-1)?.min ?? w.start, w.start);
    if (now - ref >= MISSING_MIN && now <= w.end + GRACE_MIN) {
      // 🐾 モグ：先に、次に通るはずのノードがこわれていないか確かめる
      const lastNode = seenInWindow.at(-1)?.nodeId ?? w.from;
      const next = w.route[w.route.indexOf(lastNode) + 1];
      const broken = next && !nodeById(s, next).ok;
      if (broken) {
        raise(s, {
          key: `node:${date}:${w.id}:${next}`, kind: 'node', level: 'notice', agent: 'mogu',
          text: `「${nodeById(s, next).name}」のノードがこわれているモグ。見えないのは${name}さんのせいじゃないかもしれないモグ。念のため連絡してみてほしいモグ。`,
          facts: facts(s),
        });
      } else {
        raise(s, {
          key: `missing:${date}:${w.id}`, kind: 'missing', level: 'alarm', agent: 'mogu',
          text: `${w.label}の時間なのに、${name}さんのタグが${now - ref}分見えないモグ。ノードは全部ちゃんと動いてるモグ。`,
          facts: facts(s),
        });
      }
    }
    if (now > w.end + GRACE_MIN) {
      raise(s, {
        key: `late:${date}:${w.id}`, kind: 'late', level: 'alarm', agent: 'mogu',
        text: `${w.label}の時間（${hm(w.start)}〜${hm(w.end)}）をすぎても、${nodeById(s, w.to).name}で見かけていないモグ。`,
        facts: facts(s),
      });
    }
  }

  // 📍 ピンポイントの約束
  for (const p of pinpointsToday(s)) {
    const node = nodeById(s, p.nodeId);
    if (p.type === 'arrive' && now > p.at && !seenAt(s, p.nodeId, p.at - 180, p.at)) {
      raise(s, {
        key: `pin:${date}:${p.id}`, kind: 'late', level: 'alarm', agent: 'mogu',
        text: `${hm(p.at)}までに「${node.name}」に着く約束なのに、まだ見かけていないモグ。`, facts: facts(s),
      });
    }
    if (p.type === 'pass' && now > p.at + p.tolerance && !seenAt(s, p.nodeId, p.at - p.tolerance, p.at + p.tolerance)
      && sightingsToday(s).some((x) => x.min >= p.at - 60)) {
      raise(s, {
        key: `pin:${date}:${p.id}`, kind: 'detour', level: 'notice', agent: 'yamaneko',
        text: `${hm(p.at)}ごろ「${node.name}」を通るはずが、通っていない。いつもとちがう道かもしれない。`, facts: facts(s),
      });
    }
  }
}

// アラームの強さ：保護者 → （5分だれも見なければ）家族にも → 110番の準備。SOS と危険はすぐ全員
export function stageOf(s, a) {
  if (a.level !== 'alarm' || a.ackedAt || a.cancelled) return 0;
  if (a.kind === 'sos') return 3;
  const since = (a.date === s.clock.date ? s.clock.min : s.clock.min + 1440) - a.min;
  if (a.kind === 'danger') return since >= 10 ? 3 : 2;
  return Math.min(3, 1 + Math.floor(since / 5));
}

// 役割ごとに、見てよいものだけを返す
export function feedFor(s, role) {
  const inSchool = s.clock.min >= s.schoolHours.start - 60 && s.clock.min <= s.schoolHours.end;
  for (const a of s.alarms) {
    if (stageOf(s, a) >= 2) a.reachedFamily = true; // 一度家族に届いたものは、止まったあとも家族に見せる
  }
  return s.alarms.filter((a) => a.date === s.clock.date).map((a) => ({ ...a, stage: stageOf(s, a) })).filter((a) => {
    if (role === 'parent') return true;
    if (role === 'family') return a.kind === 'sos' || a.kind === 'danger' || a.kind === 'cancel' || a.reachedFamily;
    if (role === 'teacher') {
      const schoolTime = a.min >= s.schoolHours.start - 60 && a.min <= s.schoolHours.end;
      return schoolTime && (a.kind === 'sos' || a.school || (a.kind === 'missing' && a.key.includes('w_go')) || (a.kind === 'late' && a.key.includes('w_go')));
    }
    if (role === 'friend') return a.kind === 'sos';
    return false;
  }).map((a) => {
    if (role !== 'friend') return a;
    // 友達の家族には、場所も名前も出さない
    return { id: a.id, kind: a.kind, level: a.level, agent: 'shiba', min: a.min, date: a.date, stage: a.stage, ackedAt: a.ackedAt,
      text: '見守りの輪の子どもから SOS が出たっす。近くにいたら、まわりを気にかけてほしいっす。', facts: null };
  }).filter((a) => role !== 'teacher' || inSchool || a.kind === 'sos').reverse();
}

// 110番のときに伝えることのメモ（保護者が見る。電話をかけるのは保護者）
export function policeMemo(s) {
  return [
    `子ども：${s.childName}さん`,
    facts(s),
    `いまの時刻：${hm(s.clock.min)}`,
    '服装・持ち物は、保護者から伝えてください',
  ];
}

export function createWatch() {
  let s = seed();

  const requireNode = (id) => {
    const n = nodeById(s, id);
    if (!n) throw new HttpError(404, 'ノードが見つかりません');
    return n;
  };
  const step = (minutes) => {
    s.clock.min += minutes;
    if (s.clock.min >= 1440) s.clock.min = 1439; // デモは1日の中だけ
    // 番号はときどき変える（拾った人が同じタグを追いかけられないように）
    if (s.clock.min - s.tag.rotatedAt >= 60) {
      s.tag = { number: randomInt(100000, 999999), rotatedAt: s.clock.min };
    }
    evaluate(s);
  };
  const see = (nodeId) => {
    const node = requireNode(nodeId);
    if (!node.ok) return false; // こわれたノードは見かけない
    s.sightings.push({ nodeId, date: s.clock.date, min: s.clock.min });
    if (node.kind === 'route' || node.kind === 'school') s.relayCount += 1;
    // 30日より古い記録は消す
    const [y, m, d] = s.clock.date.split('-').map(Number);
    const limit = new Date(Date.UTC(y, m - 1, d - KEEP_DAYS)).toISOString().slice(0, 10);
    s.sightings = s.sightings.filter((x) => x.date >= limit);
    evaluate(s);
    return true;
  };

  const actions = {
    // 道を歩く：ノードを順に、5分ずつ通る
    walk({ route }) {
      const routes = {
        school: ['home', 'park', 'cross', 'school'],
        home: ['school', 'cross', 'park', 'home'],
        grandma: ['school', 'cross', 'park', 'grandma'],
        detour: ['school', 'cross', 'grandma'],
      };
      const list = routes[route];
      if (!list) throw new HttpError(400, '道がちがいます');
      list.forEach((id, i) => {
        if (i > 0) step(5);
        see(id);
      });
    },
    danger() {
      step(3);
      see('rail');
    },
    vanish() {
      step(MISSING_MIN + 1);
    },
    advance({ minutes = 10 }) {
      const m = Number(minutes);
      if (!Number.isInteger(m) || m < 1 || m > 600) throw new HttpError(400, '1〜600分で進めてください');
      step(m);
    },
    setTime({ time }) {
      const m = toMin(time);
      if (m < s.clock.min) throw new HttpError(400, '時計はもどせません（リセットしてください）');
      step(m - s.clock.min);
    },
    breakNode({ nodeId }) {
      requireNode(nodeId).ok = false;
      evaluate(s);
    },
    fixNode({ nodeId }) {
      requireNode(nodeId).ok = true;
      evaluate(s);
    },
    sos() {
      raise(s, {
        key: `sos:${s.clock.date}:${s.clock.min}`, kind: 'sos', level: 'alarm', agent: 'shiba',
        text: `${s.childName}さんがタグの SOS ボタンを押したっす！ すぐ連絡してほしいっす！`, facts: facts(s),
      });
    },
    // だいじょうぶボタン（子どもがタグで取り消す）
    ok() {
      const open = s.alarms.filter((a) => a.level === 'alarm' && !a.ackedAt && !a.cancelled);
      for (const a of open) a.cancelled = true;
      raise(s, {
        key: `ok:${s.clock.date}:${s.clock.min}`, kind: 'cancel', level: 'info', agent: 'shiba',
        text: `${s.childName}さんが「だいじょうぶ」ボタンを押したっす。${open.length ? 'アラームを止めたっす。' : ''}念のため、あとで声をかけてあげてほしいっす。`,
      });
    },
    // 遅くなるボタン（2回押し）：今日の時間帯を30分のばす
    later() {
      for (const w of windowsToday(s)) {
        if (s.clock.min <= w.end + GRACE_MIN) w.end += 30;
      }
      raise(s, {
        key: `later:${s.clock.date}:${s.clock.min}`, kind: 'later', level: 'info', agent: 'shiba',
        text: `${s.childName}さんから「少し遅くなる」がとどいたっす。今日の時間帯を30分のばしたっす。`,
      });
    },
    reset() {
      s = seed();
    },
  };

  return {
    state: () => s,
    act(name, body = {}) {
      const fn = actions[name];
      if (!fn) throw new HttpError(404, 'その操作はありません');
      fn(body);
    },
    ack(alarmId, by) {
      const a = s.alarms.find((x) => x.id === alarmId);
      if (!a) throw new HttpError(404, 'アラームが見つかりません');
      a.ackedAt = { min: s.clock.min, by };
    },

    // ---- 約束 ----
    setWindow(id, { start, end }) {
      const w = s.windows.find((x) => x.id === id);
      if (!w) throw new HttpError(404, '時間帯が見つかりません');
      const a = toMin(start);
      const b = toMin(end);
      if (b <= a) throw new HttpError(400, '終わりは、始まりよりあとにしてください');
      w.start = a;
      w.end = b;
      evaluate(s);
    },
    addPinpoint({ type, nodeId, time, todayOnly = false }) {
      if (!['arrive', 'pass', 'avoid'].includes(type)) throw new HttpError(400, '約束の種類がちがいます');
      requireNode(nodeId);
      const today = pinpointsToday(s).filter((p) => !p.always);
      if (type !== 'avoid' && today.length >= MAX_PINPOINTS_PER_DAY) {
        throw new HttpError(400, `ピンポイントの約束は1日${MAX_PINPOINTS_PER_DAY}つまでだ。大事なところだけにしよう（ヤマネコ）`);
      }
      const p = type === 'avoid'
        ? { id: newId('p'), type, nodeId, always: true }
        : { id: newId('p'), type, nodeId, at: toMin(time), tolerance: 20, todayOnly: Boolean(todayOnly),
          date: todayOnly ? s.clock.date : undefined, days: todayOnly ? undefined : [weekday(s.clock.date)] };
      s.pinpoints.push(p);
      evaluate(s);
      return p;
    },
    removePinpoint(id) {
      const i = s.pinpoints.findIndex((p) => p.id === id);
      if (i === -1) throw new HttpError(404, '約束が見つかりません');
      s.pinpoints.splice(i, 1);
    },
    toggleOffDay() {
      const d = s.clock.date;
      s.offDays = s.offDays.includes(d) ? s.offDays.filter((x) => x !== d) : [...s.offDays, d];
      evaluate(s);
    },

    // ---- 見守りの輪 ----
    invite(role) {
      if (!ROLES[role] || role === 'parent') throw new HttpError(400, '招待できる役割は、家族・先生・友達の家族です');
      const code = String(randomInt(100000, 999999));
      s.invites.push({ code, role, createdMin: s.clock.min });
      return { code, role };
    },
    lookupInvite(code) {
      const inv = s.invites.find((i) => i.code === String(code));
      if (!inv) throw new HttpError(404, '招待コードがちがいます');
      return inv;
    },
    join({ code, name, consent }) {
      const inv = this.lookupInvite(code);
      if (consent !== true) throw new HttpError(400, '説明を読んで、同意してから入ってください');
      const clean = String(name ?? '').trim();
      if (!clean || [...clean].length > 20) throw new HttpError(400, '名前は1〜20文字で入れてください');
      const m = { id: newId('m'), name: clean, role: inv.role, consentAt: s.clock.date };
      s.members.push(m);
      s.invites = s.invites.filter((i) => i !== inv); // コードは1回だけ
      return m;
    },
    leave(memberId) {
      const m = s.members.find((x) => x.id === memberId);
      if (!m) throw new HttpError(404, 'メンバーが見つかりません');
      if (m.role === 'parent') throw new HttpError(400, '保護者は輪から外せません');
      s.members = s.members.filter((x) => x !== m);
    },
  };
}

// 画面に渡す形（役割ごと）
export function viewFor(s, role) {
  if (!ROLES[role] && role !== 'child') throw new HttpError(400, '役割がちがいます');
  const base = {
    role,
    clock: { date: s.clock.date, time: hm(s.clock.min), weekday: WEEK[weekday(s.clock.date)] },
    roles: ROLES,
    agents: AGENT,
  };
  if (role === 'child') {
    return {
      ...base,
      childName: s.childName,
      watchers: s.members.map((m) => ({ name: m.name, role: ROLES[m.role].label })),
    };
  }
  const feed = feedFor(s, role);
  if (role === 'friend') return { ...base, feed, relayCount: s.relayCount };
  const open = feed.filter((a) => a.level === 'alarm' && !a.ackedAt && !a.cancelled);
  const v = {
    ...base,
    childName: s.childName,
    feed,
    police: open.some((a) => a.stage >= 3) && role === 'parent' ? policeMemo(s) : null,
  };
  if (role === 'teacher') return { ...v, schoolHours: { start: hm(s.schoolHours.start), end: hm(s.schoolHours.end) } };
  const nodeName = (id) => nodeById(s, id)?.name ?? id;
  return {
    ...v,
    tagNumber: role === 'parent' ? s.tag.number : undefined,
    nodes: s.nodes,
    trail: sightingsToday(s).map((x) => ({ time: hm(x.min), node: nodeName(x.nodeId) })),
    offDay: isOffDay(s),
    windows: windowsToday(s).map((w) => ({ id: w.id, label: w.label, start: hm(w.start), end: hm(w.end), from: nodeName(w.from), to: nodeName(w.to) })),
    pinpoints: pinpointsToday(s).map((p) => ({ id: p.id, type: p.type, node: nodeName(p.nodeId), time: p.at != null ? hm(p.at) : null, todayOnly: Boolean(p.todayOnly), always: Boolean(p.always) })),
    members: role === 'parent' ? s.members.map((m) => ({ ...m, roleLabel: ROLES[m.role].label })) : undefined,
    invites: role === 'parent' ? s.invites.map((i) => ({ code: i.code, role: ROLES[i.role].label })) : undefined,
  };
}
