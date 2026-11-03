// なかとも（デモ版）の画面。上のボタンで「だれとして見るか」を切りかえる
const $ = (sel) => document.querySelector(sel);
const main = $('#main');
let role = 'parent';
let lastAlarmIds = new Set();
let audio = null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const face = (agent) => `<img src="/avatars/${agent}.svg" alt="">`;
const NAMES = { yamaneko: 'ヤマネコ', usagi: 'ウサギ', fukurou: 'フクロウ', shiba: 'シバ', mogu: 'モグ' };
const STAGE = { 1: '保護者に知らせ中', 2: '家族にも知らせ中', 3: '110番の準備' };
const hmOf = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// アラームの音（新しいアラームが来たときだけ。音を出せるのは、一度画面にさわったあと）
function beep() {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, audio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.5);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.5);
    navigator.vibrate?.([200, 100, 200]);
  } catch { /* 音が出せない環境 */ }
}

function alertHtml(a, { canAck, showStage = canAck }) {
  const open = a.level === 'alarm' && !a.ackedAt && !a.cancelled;
  const status = a.cancelled ? '取り消し' : a.ackedAt ? `${hmOf(a.ackedAt.min)} 確認ずみ` : open && showStage ? `<span class="stage">${STAGE[a.stage] || ''}</span>` : '';
  return `<li class="alert ${a.level}${open ? ' open' : ''}${a.ackedAt || a.cancelled ? ' done' : ''}">
    ${face(a.agent)}
    <div>
      <p class="meta"><strong>${NAMES[a.agent] ?? ''}</strong><span>${hmOf(a.min)}</span>${status}</p>
      <p>${esc(a.text)}</p>
      ${a.facts ? `<p class="facts">🐱 ヤマネコ：${esc(a.facts)}</p>` : ''}
      ${open && canAck ? `<div class="row" style="margin-top:8px">
        <button type="button" class="btn" data-ack="${a.id}">見た・対応する</button>
        <span class="small muted">🐕 シバ：まず電話してみるっす。出なかったら、最後に見かけた場所へ。</span></div>` : ''}
    </div>
  </li>`;
}

function feedHtml(feed, opts = {}) {
  return feed.length
    ? `<ul class="feed">${feed.map((a) => alertHtml(a, opts)).join('')}</ul>`
    : '<p class="muted">今日はまだ、お知らせはありません。</p>';
}

function roleCard(v, key) {
  const r = v.roles[key];
  return `<section class="card"><h2>${r.label}として見ています</h2>
    <dl class="can"><dt>見えること</dt><dd>${esc(r.can)}</dd><dt>見えないこと</dt><dd>${esc(r.cannot)}</dd></dl></section>`;
}

// ---- 保護者 ----
function parentHtml(v) {
  const police = v.police ? `<section class="card police" aria-labelledby="police-title">
      <h2 id="police-title">🚨 110番の準備</h2>
      <p>電話をかけるかどうかは、あなたが決めてください。警察に伝えること：</p>
      <ul>${v.police.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <a class="btn danger" href="tel:110">110番に電話する</a>
    </section>` : '';
  const PIN = { arrive: '📍 着く', pass: '👣 通る', avoid: '🚫 入らない' };
  return `${police}
    <section class="card"><h1>きょうの見守り（${v.clock.weekday}曜 ${v.clock.time}）</h1>
      <p class="small muted">タグの番号：${v.tagNumber}（名前は入っていません。番号はときどき変わります）${v.offDay ? '／きょうは見守らない日（SOS と入らない場所だけ見ます）' : ''}</p>
      ${feedHtml(v.feed, { canAck: true })}
    </section>
    <section class="card"><h2>通ったノード</h2>
      ${v.trail.length ? `<ul class="list">${v.trail.map((t) => `<li><span>${t.time}</span><span>${esc(t.node)}</span></li>`).join('')}</ul>` : '<p class="muted">きょうはまだ見かけていません</p>'}
      <p class="small muted">記録は30日で自動的に消えます。</p>
    </section>
    <section class="card"><h2>約束を決める</h2>
      <h3 class="small">時間帯（${v.clock.weekday}曜）</h3>
      <ul class="list">${v.windows.map((w) => `<li><span>${esc(w.label)}：${esc(w.from)} → ${esc(w.to)}</span>
        <form class="row" data-window="${w.id}">
          <input class="input" type="time" name="start" value="${w.start}" aria-label="${esc(w.label)}の始まり">〜
          <input class="input" type="time" name="end" value="${w.end}" aria-label="${esc(w.label)}の終わり">
          <button class="btn ghost" type="submit">直す</button></form></li>`).join('')}</ul>
      <h3 class="small">ピンポイントの約束</h3>
      <ul class="list">${v.pinpoints.map((p) => `<li><span>${PIN[p.type]}：${esc(p.node)}${p.time ? ` ${p.time}` : ''}
        ${p.todayOnly ? '<span class="tag">今日だけ</span>' : ''}${p.always ? '<span class="tag">いつでも</span>' : ''}</span>
        <button type="button" class="btn ghost" data-unpin="${p.id}">消す</button></li>`).join('')}</ul>
      <form class="row" id="pin-form" style="margin-top:8px">
        <select class="input" name="type" aria-label="約束の種類"><option value="arrive">着く</option><option value="pass">通る</option><option value="avoid">入らない</option></select>
        <select class="input" name="nodeId" aria-label="場所">${v.nodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('')}</select>
        <input class="input" type="time" name="time" value="16:00" aria-label="時刻">
        <label class="row small"><input type="checkbox" name="todayOnly"> 今日だけ</label>
        <button class="btn" type="submit">足す</button>
      </form>
      <p class="small muted">🐾 モグ：ピンポイントにできるのは、ノードがある場所だけモグ。大事な場所には、古いスマホやラズパイでノードを置けるモグ。</p>
      <div class="row" style="margin-top:8px"><button type="button" class="btn ghost" id="offday">${v.offDay ? '今日の見守りを再開する' : '今日は見守らない日にする'}</button></div>
      <p class="error" id="rule-error" role="alert"></p>
    </section>
    <section class="card"><h2>見守りの輪</h2>
      <ul class="list">${v.members.map((m) => `<li><span>${esc(m.name)} <span class="tag">${esc(m.roleLabel)}</span></span>
        ${m.role === 'parent' ? '' : `<button type="button" class="btn ghost" data-leave="${m.id}">外す</button>`}</li>`).join('')}</ul>
      <form class="row" id="invite-form" style="margin-top:8px">
        <select class="input" name="role" aria-label="招待する役割"><option value="family">家族・親戚</option><option value="teacher">先生</option><option value="friend">友達の家族</option></select>
        <button class="btn" type="submit">招待コードを作る</button>
      </form>
      ${v.invites.length ? `<p class="small">招待コード：${v.invites.map((i) => `<strong>${i.code}</strong>（${esc(i.role)}）`).join('、')}　→「輪に入る」で使えます</p>` : ''}
    </section>`;
}

// ---- 子ども ----
function childHtml(v) {
  return `<section class="card">
      <div class="say">${face('shiba')}<div><h1>${esc(v.childName)}さんへ</h1>
        <p>シバっす！ タグを持っていると、おうちの人が安心できるっす。<br>
        ずっと見張っているんじゃなくて、<strong>あぶないときだけ</strong>知らせるっす。<br>
        時間をすぎても、怒られるためじゃないっす。心配だから見てるっす。</p></div></div>
    </section>
    <section class="card"><h2>見守ってくれている人</h2>
      <ul class="list">${v.watchers.map((w) => `<li><span>${esc(w.name)}</span><span class="tag">${esc(w.role)}</span></li>`).join('')}</ul>
    </section>
    <section class="card"><h2>タグのボタン</h2>
      <div class="big-buttons">
        <button type="button" class="btn danger" data-sim="sos">🆘 たすけて（SOS）</button>
        <button type="button" class="btn" data-sim="ok">🙆 だいじょうぶ</button>
        <button type="button" class="btn ghost" data-sim="later">⏰ 少し遅くなる</button>
      </div>
    </section>`;
}

// ---- 輪に入る ----
function joinHtml() {
  return `<section class="card"><h1>見守りの輪に入る</h1>
      <p>保護者からもらった招待コードを入れてください。</p>
      <form class="row" id="code-form">
        <label class="sr-only" for="code">招待コード</label>
        <input class="input" id="code" inputmode="numeric" maxlength="6" placeholder="6けたのコード">
        <button class="btn" type="submit">次へ</button>
      </form>
      <div id="join-step"></div>
      <p class="error" id="join-error" role="alert"></p>
    </section>`;
}

async function render() {
  for (const b of document.querySelectorAll('.roles button')) b.setAttribute('aria-pressed', String(b.dataset.role === role));
  if (role === 'join') {
    if (!main.querySelector('#code-form')) main.innerHTML = joinHtml();
    return;
  }
  const v = await api(`/view?role=${role}`);
  // 新しいアラームが来たら音を鳴らす
  const alarms = (v.feed || []).filter((a) => a.level === 'alarm' && !a.ackedAt && !a.cancelled);
  if (alarms.some((a) => !lastAlarmIds.has(a.id)) && role !== 'child') beep();
  lastAlarmIds = new Set(alarms.map((a) => a.id));

  if (role === 'parent') main.innerHTML = parentHtml(v);
  else if (role === 'child') main.innerHTML = childHtml(v);
  else if (role === 'friend') {
    main.innerHTML = `${roleCard(v, 'friend')}
      <section class="card"><h2>お知らせ</h2>${feedHtml(v.feed, { canAck: false })}</section>
      <section class="card"><div class="say">${face('shiba')}<p>このスマホは、今日 ${v.relayCount} 回タグを中継したっす！ だれのタグかは、このスマホにも分からないっす。</p></div></section>`;
  } else {
    main.innerHTML = `${roleCard(v, role)}
      <section class="card"><h2>お知らせ（${v.clock.time}）</h2>
        ${role === 'teacher' ? `<p class="small muted">学校の時間（${v.schoolHours.start}〜${v.schoolHours.end}）のことだけ届きます。</p>` : ''}
        ${feedHtml(v.feed, { canAck: false })}</section>`;
  }
}

async function renderSim() {
  const d = await api('/demo');
  $('#sim-date').textContent = d.clock.date;
  $('#sim-time').textContent = d.clock.time;
  const last = d.trail.at(-1)?.nodeId;
  $('#road').innerHTML = d.nodes.map((n) => `<li class="${n.id === last ? 'here' : ''}${n.ok ? '' : ' broken'}${n.kind === 'danger' ? ' danger' : ''}">
    ${n.kind === 'danger' ? '🚫 ' : ''}${esc(n.name)}${n.ok ? '' : '（故障）'}</li>`).join('');
}

const refresh = () => Promise.all([render(), renderSim()]).catch((err) => { $('#sim-error').textContent = err.message; });

// ---- 操作 ----
document.addEventListener('click', async (e) => {
  const roleBtn = e.target.closest('.roles button');
  if (roleBtn) {
    role = roleBtn.dataset.role;
    lastAlarmIds = new Set();
    main.innerHTML = '';
    return refresh();
  }
  const simBtn = e.target.closest('[data-sim]');
  const ack = e.target.closest('[data-ack]');
  const unpin = e.target.closest('[data-unpin]');
  const leave = e.target.closest('[data-leave]');
  try {
    $('#sim-error').textContent = '';
    if (simBtn) {
      const { sim, route, node, minutes } = simBtn.dataset;
      await api(`/sim/${sim}`, { method: 'POST', body: { route, nodeId: node, minutes: minutes && Number(minutes) } });
    } else if (ack) {
      await api(`/alarms/${ack.dataset.ack}/ack`, { method: 'POST', body: { by: role } });
    } else if (unpin) {
      await api(`/pinpoints/${unpin.dataset.unpin}`, { method: 'DELETE' });
    } else if (leave) {
      await api(`/members/${leave.dataset.leave}`, { method: 'DELETE' });
    } else if (e.target.id === 'offday') {
      await api('/offday', { method: 'POST' });
    } else {
      return;
    }
    await refresh();
  } catch (err) {
    ($('#rule-error') || $('#sim-error')).textContent = err.message;
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    if (f.id === 'time-form') {
      await api('/sim/setTime', { method: 'POST', body: { time: $('#time-input').value } });
    } else if (f.dataset.window) {
      await api(`/windows/${f.dataset.window}`, { method: 'PUT', body: { start: f.elements.start.value, end: f.elements.end.value } });
    } else if (f.id === 'pin-form') {
      const el = f.elements;
      await api('/pinpoints', { method: 'POST', body: { type: el.type.value, nodeId: el.nodeId.value, time: el.time.value, todayOnly: el.todayOnly.checked } });
    } else if (f.id === 'invite-form') {
      await api('/invites', { method: 'POST', body: { role: f.elements.role.value } });
    } else if (f.id === 'code-form') {
      const code = $('#code').value.trim();
      const r = await api(`/invites/${encodeURIComponent(code)}`);
      $('#join-error').textContent = '';
      $('#join-step').innerHTML = `<div class="say" style="margin-top:12px">${face('yamaneko')}<div>
          <p><strong>${esc(r.label)}</strong>として招待されている。入る前に読んでくれ。</p>
          <dl class="can"><dt>見えること</dt><dd>${esc(r.can)}</dd><dt>見えないこと</dt><dd>${esc(r.cannot)}</dd></dl>
          <p class="small muted">いつでも輪から抜けられる。見かけた記録は30日で消える。</p></div></div>
        <form id="join-form" data-code="${esc(code)}">
          <label class="row" style="margin:8px 0">名前 <input class="input" name="name" maxlength="20" required></label>
          <label class="row"><input type="checkbox" name="consent"> 説明を読んで、同意します</label>
          <button class="btn" type="submit" style="margin-top:8px">輪に入る</button>
        </form>`;
      return;
    } else if (f.id === 'join-form') {
      const m = await api('/join', { method: 'POST', body: { code: f.dataset.code, name: f.elements.name.value, consent: f.elements.consent.checked } });
      $('#join-step').innerHTML = `<div class="say" style="margin-top:12px">${face('shiba')}<p>${esc(m.name)}さん、ようこそっす！ 見守りの輪に入ったっす。</p></div>`;
      return;
    } else {
      return;
    }
    await refresh();
  } catch (err) {
    ($('#join-error') || $('#rule-error') || $('#sim-error')).textContent = err.message;
  }
});

refresh();
// ほかのタブで操作しても、見ている画面が追いつくように。入力中は書きかえない（入れている途中の値が消えないように）
setInterval(() => {
  const typing = main.contains(document.activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (role === 'join' || typing) renderSim().catch(() => {});
  else refresh();
}, 3000);
