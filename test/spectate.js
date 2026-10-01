'use strict';
/**
 * 진행 중인 방 관전 / 다음 판부터 참여 — node test/spectate.js
 * 서버를 띄우지 않고 game.js 에 가짜 소켓을 붙여 본다(Node 서버와 worker.js 가 똑같이 이 모양으로 붙는다).
 *  - 시작한 방 · 가득 찬 대기실에 들어오면 관전자 (판에는 영향 없고, 관전자의 행동은 무시)
 *  - 관전을 막은 방(spec:false)은 예전처럼 거절 · 관전석은 10명까지
 *  - 판이 끝나 대기실로 돌아오거나 자리가 비면 들어온 순서대로 앉는다
 *  - 관전자가 받은 메시지에 남의 비공개 정보(손패 · 토큰)가 없다
 *  - 방 목록에 spec / watching 이 보인다 · 사람이 없어 방이 치워지면 관전자 소켓도 닫힌다
 */
const assert = require('assert');
const game = require('../game');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sock() {
  return {
    readyState: 1, inbox: [],
    send(t) { this.inbox.push(JSON.parse(t)); },
    close() { this.readyState = 3; },
  };
}
const codeOf = ws => ws.inbox.find(m => m.t === 'welcome').code;
const last = (ws, t) => { const l = ws.inbox.filter(m => m.t === t); return l[l.length - 1]; };
const welcome = ws => ws.inbox.filter(m => m.t === 'welcome');
const errs = ws => ws.inbox.filter(m => m.t === 'err').map(m => m.msg);
const roomOf = ws => game.rooms.get(codeOf(ws));
const FLUSH = 380;

/** 대기실에서 시작해 첫 차례까지 연다 */
function startPlaying(host) {
  game.handle(host, { t: 'start' });
  game.handle(host, { t: 'go' });
}
/** 사람 둘이 있는 방 — 방장 a, 참가 b */
function twoPlayers(opts = {}) {
  const a = sock(), b = sock();
  game.handle(a, Object.assign({ t: 'create', name: '방장' }, opts));
  game.handle(b, { t: 'join', code: codeOf(a), name: '참가' });
  return { a, b, code: codeOf(a) };
}
const strip = st => { const o = Object.assign({}, st); delete o.role; delete o.now; return o; };

let pass = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + ' — ' + (e.stack || e.message)); process.exit(1); }
}

(async () => {
  console.log('관전');

  await check('시작한 방에 join → 관전자로 들어오고 판에는 영향이 없다', async () => {
    const { a, b, code } = twoPlayers({ turnLimit: 0 });
    startPlaying(a);
    const room = game.rooms.get(code);
    assert.strictEqual(room.phase, 'playing');
    const before = JSON.stringify(strip(last(a, 'state')));

    const c = sock();
    game.handle(c, { t: 'join', code, name: '구경' });
    assert.deepStrictEqual(errs(c), []);
    const w = welcome(c)[0];
    assert.strictEqual(w.role, 'spec');
    assert.ok(!w.token, '관전자에게 토큰이 감');
    assert.strictEqual(last(c, 'state').role, 'spec');
    assert.deepStrictEqual(last(c, 'state').specs, ['구경']);
    assert.strictEqual(last(a, 'state').role, 'player');
    assert.deepStrictEqual(last(a, 'state').specs, ['구경'], '플레이어가 관전자를 모름');
    assert.strictEqual(last(c, 'state').players.length, 2, '관전자가 인원수에 섞임');
    assert.strictEqual(room.players.length, 2);
    assert.strictEqual(JSON.stringify(strip(last(a, 'state'))).replace(/"specs":\[[^\]]*\]/, '"specs":[]'),
      before.replace(/"specs":\[[^\]]*\]/, '"specs":[]'), '들어왔는데 판 상태가 달라짐');
    assert.strictEqual(room.hostId, last(a, 'state').hostId);
  });

  await check('관전자가 보낸 게임 행동은 전부 조용히 무시된다', async () => {
    const { a, b, code } = twoPlayers({ turnLimit: 0 });
    startPlaying(a);
    const room = game.rooms.get(code);
    const c = sock();
    game.handle(c, { t: 'join', code, name: '구경' });
    const turn = room.turn;                       // 방장 차례
    const hands = room.players.map(p => p.hand.length).join();
    const nA = a.inbox.length, nC = c.inbox.length;
    for (const m of [
      { t: 'flip' }, { t: 'call', word: 'banana' }, { t: 'call', word: '짝' }, { t: 'bell' },
      { t: 'cfg', mode: 'extreme', botDiff: 'hard', spec: false, priv: true }, { t: 'start' }, { t: 'go' },
      { t: 'again' }, { t: 'lobby' }, { t: 'addBot' }, { t: 'kick', id: 2 }, { t: 'removeBot', id: 2 },
      { t: 'name', name: '해킹' },
    ]) game.handle(c, m);
    assert.strictEqual(room.turn, turn);
    assert.strictEqual(room.phase, 'playing');
    assert.strictEqual(room.players.map(p => p.hand.length).join(), hands);
    assert.strictEqual(room.players.length, 2);
    assert.strictEqual(room.cfg.mode, 'basic');
    assert.strictEqual(room.cfg.spec, true);
    assert.strictEqual(room.cfg.priv, false);
    assert.ok(!room.players.some(p => p.name === '해킹'));
    assert.strictEqual(a.inbox.length, nA, '플레이어에게 아무 메시지도 가면 안 됨');
    assert.strictEqual(c.inbox.length, nC, '관전자에게 drop 같은 응답도 가면 안 됨');
    // 방장은 정상적으로 뒤집는다
    game.handle(a, { t: 'flip' });
    assert.ok(a.inbox.some(m => m.t === 'ev' && m.kind === 'flip'));
    assert.ok(c.inbox.some(m => m.t === 'ev' && m.kind === 'flip'), '관전자가 판을 못 봄');
  });

  await check('채팅은 되고, 이름으로 구분된다', async () => {
    const { a, b, code } = twoPlayers({ turnLimit: 0 });
    startPlaying(a);
    const c = sock();
    game.handle(c, { t: 'join', code, name: '구경꾼' });
    game.handle(c, { t: 'chat', text: '안녕' });
    const m = last(a, 'chat');
    assert.strictEqual(m.name, '구경꾼');
    assert.strictEqual(m.text, '안녕');
    assert.strictEqual(m.spec, true);
    assert.ok(c.inbox.some(x => x.t === 'chat'), '본인도 받음');
    game.handle(a, { t: 'chat', text: '어서와' });
    assert.ok(last(c, 'chat').text === '어서와' && !last(c, 'chat').spec, '플레이어 채팅을 못 받음');
  });

  await check('가득 찬 대기실에 join → 관전자', async () => {
    const a = sock();
    game.handle(a, { t: 'create', name: '방장' });
    const code = codeOf(a);
    for (let i = 0; i < game.MAX_PLAYERS - 1; i++) game.handle(a, { t: 'addBot' });
    assert.strictEqual(game.rooms.get(code).players.length, game.MAX_PLAYERS);
    const c = sock();
    game.handle(c, { t: 'join', code, name: '구경' });
    assert.strictEqual(welcome(c)[0].role, 'spec');
    assert.strictEqual(game.rooms.get(code).players.length, game.MAX_PLAYERS);
    assert.strictEqual(last(c, 'state').phase, 'lobby');
  });

  await check('spec:false 방은 시작/만석에 join 이 예전처럼 거절된다', async () => {
    const { a, code } = twoPlayers({ spec: false });
    assert.strictEqual(game.rooms.get(code).cfg.spec, false);
    startPlaying(a);
    const c = sock();
    game.handle(c, { t: 'join', code, name: '구경' });
    assert.ok(errs(c)[0].startsWith('이미 시작한 방이에요.'), errs(c)[0]);
    assert.ok(!welcome(c).length);
    assert.strictEqual(game.rooms.get(code).specs.length, 0);

    const f = sock();
    game.handle(f, { t: 'create', name: '만석', spec: false });
    for (let i = 0; i < game.MAX_PLAYERS - 1; i++) game.handle(f, { t: 'addBot' });
    const d = sock();
    game.handle(d, { t: 'join', code: codeOf(f), name: '구경' });
    assert.ok(errs(d)[0].startsWith('방이 가득 찼어요.'), errs(d)[0]);
    assert.ok(!welcome(d).length);
  });

  await check('대기실에서 방장이 관전 허용을 바꾼다 (방장만, 대기실에서만)', async () => {
    const { a, b, code } = twoPlayers();
    const room = game.rooms.get(code);
    game.handle(b, { t: 'cfg', spec: false });
    assert.strictEqual(room.cfg.spec, true, '방장 아닌 사람이 바꿈');
    game.handle(a, { t: 'cfg', spec: 'no' });
    assert.strictEqual(room.cfg.spec, true, '검증 없이 받음');
    game.handle(a, { t: 'cfg', spec: false });
    assert.strictEqual(room.cfg.spec, false);
    assert.strictEqual(last(b, 'state').cfg.spec, false);
    game.handle(a, { t: 'cfg', spec: true });
    startPlaying(a);
    game.handle(a, { t: 'cfg', spec: false });
    assert.strictEqual(room.cfg.spec, true, '판 중에 바뀜');
  });

  await check('관전석은 10명까지', async () => {
    const { a, code } = twoPlayers();
    startPlaying(a);
    for (let i = 0; i < 10; i++) {
      const s = sock();
      game.handle(s, { t: 'join', code, name: '관' + i });
      assert.strictEqual(welcome(s)[0].role, 'spec', i + '번째');
    }
    const x = sock();
    game.handle(x, { t: 'join', code, name: '열한째' });
    assert.deepStrictEqual(errs(x), ['관전석이 가득 찼어요.']);
    assert.strictEqual(game.rooms.get(code).specs.length, 10);
    assert.strictEqual(last(a, 'state').specs.length, 10);
  });

  await check('관전자가 나가거나 끊기면 목록에서 빠진다', async () => {
    const { a, code } = twoPlayers();
    startPlaying(a);
    const c = sock(), d = sock();
    game.handle(c, { t: 'join', code, name: 'c' });
    game.handle(d, { t: 'join', code, name: 'd' });
    assert.deepStrictEqual(last(a, 'state').specs, ['c', 'd']);
    game.handle(c, { t: 'leave' });
    assert.deepStrictEqual(last(a, 'state').specs, ['d']);
    d.readyState = 3; game.disconnect(d);
    assert.deepStrictEqual(last(a, 'state').specs, []);
    assert.strictEqual(game.rooms.get(code).phase, 'playing');
  });

  await check('판이 끝나 대기실로 돌아오면 관전자가 빈 자리에 앉고 입장 응답(welcome)을 받는다', async () => {
    const { a, b, code } = twoPlayers({ turnLimit: 0 });
    startPlaying(a);
    const room = game.rooms.get(code);
    const c = sock(), d = sock();
    game.handle(c, { t: 'join', code, name: '첫째' });
    game.handle(d, { t: 'join', code, name: '둘째' });
    game.handle(b, { t: 'leave' });               // 둘이서 하던 판 — 한 명이 나가 판이 끝난다
    assert.strictEqual(room.phase, 'over');
    assert.strictEqual(room.specs.length, 2, '판이 끝났다고 앉히면 안 됨');
    game.handle(a, { t: 'lobby' });
    assert.strictEqual(room.phase, 'lobby');
    assert.strictEqual(room.specs.length, 0);
    assert.deepStrictEqual(room.players.map(p => p.name), ['방장', '첫째', '둘째'], '들어온 순서대로');
    const w = welcome(c)[1];
    assert.ok(w && w.role === 'player' && w.seated && w.token && w.code === code, '앉은 사람이 welcome 을 못 받음');
    assert.strictEqual(w.you, room.players[1].id);
    assert.strictEqual(w.token, room.players[1].token);
    assert.strictEqual(last(c, 'state').role, 'player');
    assert.strictEqual(last(c, 'state').phase, 'lobby');
    assert.deepStrictEqual(last(c, 'state').specs, []);
    assert.ok(last(a, 'ev') && a.inbox.some(m => m.t === 'ev' && m.kind === 'joined' && m.by === w.you), '방에 들어왔다는 알림이 없음');
    // 앉은 사람은 이제 행동할 수 있다 — 자기 소켓으로 resume 도 된다
    game.handle(c, { t: 'chat', text: '나 이제 선수' });
    assert.strictEqual(last(a, 'chat').spec, undefined);
    const e = sock();
    game.handle(e, { t: 'resume', code, token: w.token });
    assert.strictEqual(welcome(e)[0].you, w.you);
    assert.strictEqual(c.readyState, 3, '이어받으면 앞 소켓이 닫혀야 함');
  });

  await check('자리가 없으면 계속 관전자로 남고, 하나 비면 한 명만 앉는다', async () => {
    const a = sock();
    game.handle(a, { t: 'create', name: '방장' });
    const code = codeOf(a);
    for (let i = 0; i < game.MAX_PLAYERS - 1; i++) game.handle(a, { t: 'addBot' });
    const room = game.rooms.get(code);
    const c = sock(), d = sock();
    game.handle(c, { t: 'join', code, name: '첫째' });
    game.handle(d, { t: 'join', code, name: '둘째' });
    assert.strictEqual(room.specs.length, 2);
    // 만석인 채 판이 끝나도 자리가 없다
    startPlaying(a);
    room.phase = 'over';
    game.handle(a, { t: 'lobby' });
    assert.strictEqual(room.phase, 'lobby');
    assert.strictEqual(room.specs.length, 2, '자리가 없는데 앉음');
    assert.strictEqual(welcome(c).length, 1);
    // 봇 하나를 빼면 자리가 하나 — 먼저 온 관전자만 앉는다
    const bot = room.players.find(p => p.bot);
    game.handle(a, { t: 'removeBot', id: bot.id });
    assert.strictEqual(room.players.length, game.MAX_PLAYERS);
    assert.strictEqual(room.players[room.players.length - 1].name, '첫째');
    assert.deepStrictEqual(room.specs.map(s => s.name), ['둘째']);
    assert.strictEqual(welcome(c)[1].role, 'player');
    assert.strictEqual(welcome(d).length, 1);
    assert.strictEqual(last(d, 'state').role, 'spec');
  });

  await check('다시 하기 때 자리가 비어 있으면 관전자가 다음 판부터 앉는다', async () => {
    const { a, b, code } = twoPlayers({ turnLimit: 0 });
    startPlaying(a);
    const room = game.rooms.get(code);
    const c = sock();
    game.handle(c, { t: 'join', code, name: '구경' });
    game.handle(b, { t: 'leave' });
    assert.strictEqual(room.phase, 'over');
    game.handle(a, { t: 'again' });
    assert.strictEqual(room.phase, 'ready');
    assert.deepStrictEqual(room.players.map(p => p.name), ['방장', '구경']);
    assert.strictEqual(last(c, 'state').role, 'player');
  });

  await check('숨은 정보 누출 검사 — 관전자가 받은 모든 메시지', async () => {
    const { a, b, code } = twoPlayers({ turnLimit: 0, mode: 'extreme' });
    const c = sock();
    game.handle(c, { t: 'join', code, name: '구경' });   // 대기실이라 정식 참가
    // 대기실이 꽉 차게 — 일부러 관전자 소켓을 따로 만든다
    startPlaying(a);
    const s = sock();
    game.handle(s, { t: 'join', code, name: '관전' });
    assert.strictEqual(welcome(s)[0].role, 'spec');
    const room = game.rooms.get(code);
    // 몇 장 뒤집고 종도 쳐 본다
    for (let i = 0; i < 6; i++) {
      const turn = room.players.find(p => p.id === room.turn);
      if (!turn || room.frozen || room.resolving) break;
      const who = [a, b, c].find(x => welcome(x)[0].you === turn.id);
      game.handle(who, { t: 'flip' });
    }
    game.handle(a, { t: 'call', word: '짝' });
    game.handle(b, { t: 'chat', text: '비밀 아님' });
    assert.ok(s.inbox.length > 3);

    const raw = JSON.stringify(s.inbox);
    for (const p of room.players) assert.ok(!raw.includes(p.token), p.name + ' 의 토큰이 관전자에게 감');
    for (const m of s.inbox) {
      assert.ok(!('token' in m), '관전자가 받은 ' + m.t + ' 에 token');
      if (m.t === 'state') {
        assert.strictEqual(m.role, 'spec');
        for (const p of m.players) {
          assert.strictEqual(typeof p.hand, 'number', '손패가 장수가 아님');
          assert.ok(!('table' in p) && !('token' in p) && !('ws' in p) && !('cards' in p));
          if (p.top) assert.ok(p.pile > 0, '더미가 없는데 윗장이 있음');
        }
      }
      assert.notStrictEqual(m.t, 'drop', '관전자가 drop 을 받음');
    }
    // 같은 순간의 플레이어 시야와 똑같다 — 관전자만 더 보거나 덜 보지 않는다
    assert.deepStrictEqual(strip(last(s, 'state')), strip(last(a, 'state')));
    assert.deepStrictEqual(strip(last(s, 'state')), strip(last(b, 'state')));
    // 이벤트도 같은 것을 받는다 (관전자가 들어오기 전의 것은 빼고)
    const evsOf = ws => JSON.stringify(ws.inbox.filter(m => m.t === 'ev' && !['joined', 'start', 'dealt'].includes(m.kind)).slice(-4));
    assert.strictEqual(evsOf(s), evsOf(a));
  });

  await check('방 목록에 spec / watching 이 보이고 비공개 방은 코드 없이 보인다', async () => {
    const w = sock();
    game.handle(w, { t: 'rooms' });
    const { a, code } = twoPlayers({ spec: true });
    const { a: pa, code: pcode } = twoPlayers({ spec: false, priv: true });
    startPlaying(a);
    const c = sock();
    game.handle(c, { t: 'join', code, name: '구경' });
    await sleep(FLUSH);
    const list = last(w, 'rooms').list;
    const r = list.find(x => x.code === code);
    assert.strictEqual(r.state, 'playing');
    assert.strictEqual(r.spec, true);
    assert.strictEqual(r.watching, 1);
    const pr = list.find(x => x.priv && x.host === '방장' && x.spec === false);
    assert.ok(pr && pr.state === 'wait' && pr.watching === 0 && !('code' in pr));
    assert.ok(!JSON.stringify(list).includes(pcode), '비공개 방 코드가 목록에 샘');
    assert.ok(list.findIndex(x => x.code === code) >= 0);
    // 비공개 wait 방은 공개 playing 방보다 뒤가 아니어도 되지만, 공개 wait 방보다는 뒤
    const pub = twoPlayers().code;
    game.handle(sock(), { t: 'unwatch' });
    game.handle(w, { t: 'rooms' });
    const l2 = last(w, 'rooms').list;
    assert.ok(l2.findIndex(x => x.code === pub) < l2.findIndex(x => x.priv));
    game.handle(w, { t: 'unwatch' });
  });

  await check('사람이 아무도 없어 방이 치워지면 관전자 소켓도 닫힌다', async () => {
    const { a, b, code } = twoPlayers({ turnLimit: 0 });
    startPlaying(a);
    const c = sock();
    game.handle(c, { t: 'join', code, name: '구경' });
    a.readyState = 3; game.disconnect(a);
    b.readyState = 3; game.disconnect(b);
    assert.ok(game.rooms.has(code), '곧바로 치워지진 않음');
    game.sweepRooms(Date.now() + 5 * 60_000);
    assert.ok(!game.rooms.has(code), '관전자만 남은 방이 살아 있음');
    assert.strictEqual(c.readyState, 3, '관전자 소켓이 안 닫힘');
    assert.ok(c.inbox.some(m => m.t === 'err' && m.fatal));
  });

  await check('대기실에서 사람이 나가 자리가 비면 관전자가 앉고, 방장이 비었으면 앉은 사람이 맡는다', async () => {
    const a = sock();
    game.handle(a, { t: 'create', name: '혼자' });
    const code = codeOf(a);
    const room = game.rooms.get(code);
    for (let i = 0; i < game.MAX_PLAYERS - 1; i++) game.handle(a, { t: 'addBot' });
    const c = sock();
    game.handle(c, { t: 'join', code, name: '구경' });
    assert.strictEqual(room.specs.length, 1);
    // 방장이 나가면 봇만 남는다 — 사람 자리는 비고, 대기실이라 관전자가 앉는다
    game.handle(a, { t: 'leave' });
    assert.ok(game.rooms.has(code));
    assert.strictEqual(room.players.filter(p => !p.bot).length, 1);
    assert.strictEqual(welcome(c)[1].role, 'player');
    assert.strictEqual(room.hostId, room.players.find(p => !p.bot).id, '앉은 관전자가 방장을 맡음');
    // 그 사람도 나가면 방이 치워진다
    game.handle(c, { t: 'leave' });
    c.readyState = 3; game.disconnect(c);
  });

  console.log(`  ${pass}개 통과`);
  process.exit(0);
})();
