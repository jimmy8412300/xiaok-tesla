import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createBot } from '../src/bot.js';
import { nearestRegion } from '../src/regions.js';
import { buildGroupMessage } from '../src/mention.js';
import { verifySignature } from '../src/line.js';

const regions = [
  { name: '北區', lat: 25.0478, lng: 121.517, radiusKm: 8 },
  { name: '南區', lat: 22.6273, lng: 120.3014, radiusKm: 15 },
];
const G_NORTH = 'Cnorth', G_SOUTH = 'Csouth';
const ME = 'Ume', BOSS = 'Uboss', AMY = 'Uamy';
const NAMES = { [ME]: '小K', [BOSS]: '王老闆', [AMY]: 'Amy' };

function fakeLine() {
  let n = 0;
  const calls = [];
  const sent = (call) => {
    call.ids = call.messages.map(() => `sent${++n}`);
    calls.push(call);
    return { sentMessages: call.ids.map((id) => ({ id })) };
  };
  return {
    calls,
    reply: async (replyToken, messages) => sent({ op: 'reply', replyToken, messages }),
    push: async (to, messages) => sent({ op: 'push', to, messages }),
    groupMemberProfile: async (_g, u) => ({ displayName: NAMES[u] }),
    profile: async (u) => ({ displayName: NAMES[u] }),
    groupSummary: async (g) => ({ groupName: g === G_NORTH ? '北區工作群' : '南區工作群' }),
  };
}

function setup(overrides = {}) {
  const line = fakeLine();
  const db = openDb(':memory:');
  const config = {
    allowedUserIds: new Set([ME]), recentLimit: 10, orderPattern: /^(#單|【單】|派單|訂單)|單號/,
    liveDefault: true, tz: 'Asia/Taipei', ...overrides,
  };
  const bot = createBot({ line, db, regions, config });
  let t = 1_700_000_000_000;
  const groupText = (groupId, userId, text) => bot.handleEvent({
    type: 'message', replyToken: 'r', timestamp: (t += 60_000), source: { type: 'group', groupId, userId },
    message: { type: 'text', id: String(t), text },
  });
  const dm = (message) => bot.handleEvent({
    type: 'message', replyToken: 'rdm', timestamp: (t += 1000), source: { type: 'user', userId: ME }, message,
  });
  return { line, db, bot, groupText, dm };
}

test('nearestRegion 找最近的區', () => {
  const hit = nearestRegion(regions, 25.033, 121.5654); // 台北 101
  assert.equal(hit.region.name, '北區');
  assert.ok(hit.inside);
  assert.equal(nearestRegion(regions, 22.99, 120.21).region.name, '南區'); // 台南
});

test('驗證 LINE 簽章', () => {
  const body = Buffer.from('{"events":[]}');
  const sig = createHmac('sha256', 'secret').update(body).digest('base64');
  assert.ok(verifySignature(body, 'secret', sig));
  assert.ok(!verifySignature(body, 'wrong', sig));
});

test('@名字 轉成 textV2 mention，長名字優先、大括號跳脫', () => {
  const { message, mentionedUserIds } = buildGroupMessage({
    prefix: '💬 小K：', text: '@王老闆 {收到} @Amy @所有人',
    members: [{ user_id: BOSS, display_name: '王老闆' }, { user_id: 'Uwang', display_name: '王' }, { user_id: AMY, display_name: 'Amy' }],
  });
  assert.equal(message.type, 'textV2');
  assert.equal(message.text, '💬 小K：{m0} ｛收到｝ {m1} {all}');
  assert.deepEqual(mentionedUserIds, [BOSS, AMY]);
  assert.equal(message.substitution.all.mentionee.type, 'all');
});

test('完整流程：綁定 → 群組對話 → 傳位置拉紀錄 → 回覆並標記', async () => {
  const { line, db, groupText, dm } = setup();

  await groupText(G_NORTH, BOSS, '/綁定 北區');
  await groupText(G_SOUTH, BOSS, '/綁定 南區');
  assert.equal(db.groupByRegion('北區').name, '北區工作群');

  await groupText(G_NORTH, BOSS, '早安');
  await groupText(G_NORTH, BOSS, '#單 信義區 Model Y 交車 14:00');
  await groupText(G_NORTH, AMY, '我可以支援');
  await groupText(G_SOUTH, BOSS, '南區的訊息不該出現');

  line.calls.length = 0;
  await dm({ type: 'location', id: 'l1', latitude: 25.033, longitude: 121.5654 });
  const [summaryReply] = line.calls;
  assert.equal(summaryReply.op, 'reply');
  const summaryText = summaryReply.messages[0].text;
  assert.match(summaryText, /你目前在「北區」/);
  assert.match(summaryText, /王老闆：📋#\d+ #單 信義區/);
  assert.match(summaryText, /Amy：我可以支援/);
  assert.doesNotMatch(summaryText, /南區的訊息/);
  assert.equal(summaryReply.messages.length, 2); // 對話摘要 + 1 張單
  assert.match(summaryReply.messages[1].text, /📋 單 #\d+/);
  assert.ok(summaryReply.messages[1].quickReply);

  // 長按回覆那張單 → 推到北區群組並標記發單的王老闆
  line.calls.length = 0;
  await dm({ type: 'text', id: 't1', text: '我接了，@Amy 一起來', quotedMessageId: summaryReply.ids[1] });
  const push = line.calls.find((c) => c.op === 'push' && c.to === G_NORTH);
  assert.ok(push, '應該推到北區群組');
  const m = push.messages[0];
  assert.equal(m.type, 'textV2');
  assert.equal(m.text, '💬 小K：{m1} 我接了，{m0} 一起來');
  assert.equal(m.substitution.m1.mentionee.userId, BOSS);
  assert.equal(m.substitution.m0.mentionee.userId, AMY);
  const confirm = line.calls.find((c) => c.op === 'reply');
  assert.match(confirm.messages[0].text, /已送到「北區」群組/);
  assert.match(confirm.messages[0].text, /已標記：Amy、王老闆/);

  // 送出的訊息也進了紀錄
  assert.equal(db.recent(G_NORTH, 1)[0].text, '我接了，@Amy 一起來');
});

test('即時轉發：同區新訊息推到私訊，回覆它就標記發話者', async () => {
  const { line, groupText, dm } = setup();
  await groupText(G_NORTH, BOSS, '/綁定 北區');
  await dm({ type: 'location', id: 'l1', latitude: 25.04, longitude: 121.52 });

  line.calls.length = 0;
  await groupText(G_NORTH, AMY, '有人在附近嗎');
  const live = line.calls.find((c) => c.op === 'push' && c.to === ME);
  assert.match(live.messages[0].text, /🔔 北區\nAmy/);

  line.calls.length = 0;
  await dm({ type: 'text', id: 't2', text: '我在', quotedMessageId: live.ids[0] });
  const push = line.calls.find((c) => c.op === 'push' && c.to === G_NORTH);
  assert.equal(push.messages[0].substitution.m0.mentionee.userId, AMY);

  await dm({ type: 'text', id: 't3', text: '/即時 關' });
  line.calls.length = 0;
  await groupText(G_NORTH, AMY, '再一則');
  assert.ok(!line.calls.some((c) => c.op === 'push' && c.to === ME));
});

test('/完成 把單子關掉，未授權使用者被擋下', async () => {
  const { line, db, groupText, dm, bot } = setup();
  await groupText(G_NORTH, BOSS, '/綁定 北區');
  await groupText(G_NORTH, BOSS, '派單 台北車站接人');
  const [order] = db.openOrders(G_NORTH, 5);
  await dm({ type: 'location', id: 'l1', latitude: 25.04, longitude: 121.52 });
  await dm({ type: 'text', id: 't', text: `/完成 ${order.id}` });
  assert.equal(db.openOrders(G_NORTH, 5).length, 0);

  line.calls.length = 0;
  await bot.handleEvent({
    type: 'message', replyToken: 'x', timestamp: 1, source: { type: 'user', userId: 'Ustranger' },
    message: { type: 'location', id: 'l', latitude: 25.04, longitude: 121.52 },
  });
  assert.match(line.calls[0].messages[0].text, /還沒被授權/);
  assert.ok(!line.calls.some((c) => c.op === 'push'));
});
