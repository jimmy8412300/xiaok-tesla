import { nearestRegion } from './regions.js';
import { buildGroupMessage } from './mention.js';

const MAX_TEXT = 4900;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const NON_TEXT_LABEL = {
  image: '[圖片]', video: '[影片]', audio: '[語音]', file: '[檔案]', sticker: '[貼圖]', location: '[位置]',
};

const HELP = [
  '📖 使用方式',
  '1. 按下方「📍 傳送位置」，我會依你所在的區，拉出該區群組最近的對話和未完成的單子。',
  '2. 直接打字 → 會以你的名字轉發到該區群組。',
  '3. 群組裡的派工、交車、接送等需求會自動辨識成「單」。',
  '4. 長按我轉來的某則訊息選「回覆」→ 會自動標記那則訊息的發話者。',
  '5. 打「@名字」可標記群組裡的人，「@所有人」標記全部。',
  '',
  '指令：',
  '/最近　重新拉取對話與單子',
  '/單　列出未完成的單子',
  '/完成 編號　把單子標成完成（例：/完成 12）',
  '/即時 開｜關　該區有新訊息時是否即時轉給你',
  '/位置　切換區域',
  '/id　顯示你的 LINE userId',
].join('\n');

export function createBot({ line, db, regions, config }) {
  const fmtTime = new Intl.DateTimeFormat('zh-TW', {
    timeZone: config.tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const time = (ts) => fmtTime.format(new Date(ts));

  const quickReply = {
    items: [
      { type: 'action', action: { type: 'location', label: '📍 傳送位置' } },
      { type: 'action', action: { type: 'message', label: '🗨 最近對話', text: '/最近' } },
      { type: 'action', action: { type: 'message', label: '📋 單子', text: '/單' } },
    ],
  };
  const withQuickReply = (messages) => {
    if (messages.length) messages[messages.length - 1] = { ...messages[messages.length - 1], quickReply };
    return messages;
  };
  const text = (t) => ({ type: 'text', text: clip(t, MAX_TEXT) });

  const isAllowed = (userId) => !config.allowedUserIds || config.allowedUserIds.has(userId);

  async function nameInGroup(groupId, userId) {
    const known = db.member(groupId, userId);
    if (known) return known.display_name;
    try {
      const p = await line.groupMemberProfile(groupId, userId);
      db.upsertMember(groupId, userId, p.displayName);
      return p.displayName;
    } catch {
      return null;
    }
  }

  async function ownName(userId, groupId) {
    if (groupId) {
      const n = await nameInGroup(groupId, userId);
      if (n) return n;
    }
    try {
      return (await line.profile(userId)).displayName;
    } catch {
      return '同事';
    }
  }

  /** 送出訊息並記住每一則私訊對應的群組/作者，之後使用者「回覆」它就能找回要標記誰 */
  async function send({ replyToken, to }, messages, targets = []) {
    const res = replyToken ? await line.reply(replyToken, messages) : await line.push(to, messages);
    const sent = res?.sentMessages ?? [];
    const userId = to ?? targets.userId;
    sent.forEach((m, i) => {
      const t = targets[i];
      if (t && userId) db.insertRelay(m.id, userId, t.groupId, t.authorUserId, t.messageId);
    });
    return res;
  }

  function currentGroup(userId) {
    const u = db.user(userId);
    if (!u?.region) return { user: u };
    return { user: u, group: db.groupByRegion(u.region) };
  }

  function orderBubble(o, region) {
    const sum = o.order_summary ? `📝 ${o.order_summary}\n` : '';
    return text(
      `📋 單 #${o.id}｜${region}\n${sum}${o.display_name ?? '成員'}　${time(o.created_at)}\n\n${o.text}\n\n` +
        `↩️ 長按此訊息「回覆」即可回覆並標記 ${o.display_name ?? '發單人'}`,
    );
  }

  function summary(userId, group, header) {
    const recent = db.recent(group.group_id, config.recentLimit);
    const orders = db.openOrders(group.group_id, 4);
    const totalOrders = db.countOpenOrders(group.group_id);

    const lines = [header, `群組：${group.name ?? group.region}`, ''];
    if (recent.length === 0) {
      lines.push('（目前還沒有紀錄。機器人只看得到它加入群組之後的訊息）');
    } else {
      lines.push(`🗨 最近 ${recent.length} 則對話`);
      for (const m of recent) {
        const tag = m.is_order ? `📋#${m.id} ` : '';
        lines.push(`[${time(m.created_at)}] ${m.display_name ?? '成員'}：${tag}${clip(m.text.replace(/\n/g, ' '), 80)}`);
      }
    }
    lines.push('', totalOrders ? `📋 未完成的單：${totalOrders} 張` : '📋 目前沒有未完成的單');
    if (totalOrders > orders.length) lines.push(`（只顯示最新 ${orders.length} 張，輸入 /單 查看）`);
    lines.push('', '直接打字就會轉發到群組，打「@名字」可標記人。');

    const messages = [text(lines.join('\n')), ...orders.map((o) => orderBubble(o, group.region))];
    const targets = [
      { groupId: group.group_id, authorUserId: null, messageId: null },
      ...orders.map((o) => ({ groupId: group.group_id, authorUserId: o.user_id, messageId: o.id })),
    ];
    targets.userId = userId;
    return { messages: withQuickReply(messages), targets };
  }

  // ───────────── 群組事件 ─────────────

  async function onGroupEvent(event) {
    const groupId = event.source.groupId;

    if (event.type === 'join') {
      const names = regions.map((r) => r.name).join('、');
      return line.reply(event.replyToken, [
        text(`大家好！請管理員輸入「/綁定 區名」把這個群組綁到一個區域。\n可用區域：${names}`),
      ]);
    }
    if (event.type !== 'message') return;

    const userId = event.source.userId;
    const msg = event.message;
    const raw = msg.type === 'text' ? msg.text.trim() : NON_TEXT_LABEL[msg.type] ?? `[${msg.type}]`;

    if (msg.type === 'text' && raw.startsWith('/綁定')) {
      const regionName = raw.replace('/綁定', '').trim();
      if (!regions.some((r) => r.name === regionName)) {
        return line.reply(event.replyToken, [
          text(`找不到區域「${regionName}」。可用區域：${regions.map((r) => r.name).join('、')}`),
        ]);
      }
      let name = null;
      try {
        name = (await line.groupSummary(groupId)).groupName;
      } catch {}
      db.bindGroup(groupId, regionName, name);
      return line.reply(event.replyToken, [text(`✅ 已把這個群組綁定到「${regionName}」`)]);
    }

    if (msg.type === 'text' && raw.startsWith('/完成')) {
      return line.reply(event.replyToken, [text(completeOrder(raw, groupId))]);
    }

    const displayName = userId ? (await nameInGroup(groupId, userId)) ?? '成員' : '成員';
    const det = msg.type === 'text' ? await config.detectOrder(raw) : { isOrder: false };
    const order = det.isOrder;
    const id = db.insertMessage({ groupId, userId, displayName, text: raw, isOrder: order, summary: det.summary, createdAt: event.timestamp });

    await forwardLive(groupId, { id, userId, displayName, text: raw, isOrder: order, summary: det.summary, createdAt: event.timestamp });
  }

  async function forwardLive(groupId, m) {
    const group = db.groupById(groupId);
    if (!group) return;
    const recipients = db.liveUsersInRegion(group.region).filter((u) => u.user_id !== m.userId && isAllowed(u.user_id));
    for (const u of recipients) {
      const head = m.isOrder ? `📋 新單 #${m.id}｜${group.region}` : `🔔 ${group.region}`;
      const sum = m.summary ? `📝 ${m.summary}\n` : '';
      const body = `${head}\n${sum}${m.displayName}　${time(m.createdAt)}\n\n${m.text}`;
      const targets = [{ groupId, authorUserId: m.userId, messageId: m.id }];
      try {
        await send({ to: u.user_id }, [text(body)], targets);
      } catch (err) {
        console.error('即時轉發失敗', u.user_id, err.message);
      }
    }
  }

  function completeOrder(raw, groupId) {
    const id = Number(raw.replace('/完成', '').replace('#', '').trim());
    const o = Number.isInteger(id) ? db.messageById(id) : null;
    if (!o || !o.is_order || (groupId && o.group_id !== groupId)) return `找不到單 #${raw.replace('/完成', '').trim()}`;
    if (o.order_status === 'done') return `單 #${id} 本來就是完成狀態`;
    db.setOrderStatus(id, 'done');
    return `✅ 單 #${id} 已標記完成`;
  }

  // ───────────── 私訊事件 ─────────────

  async function onUserEvent(event) {
    const userId = event.source.userId;

    if (event.type === 'follow') {
      const extra = isAllowed(userId) ? '' : `\n\n⚠️ 你還沒被授權。請把這個 ID 給管理員：\n${userId}`;
      return line.reply(event.replyToken, withQuickReply([text(`嗨！我是區域小幫手 👋\n\n${HELP}${extra}`)]));
    }
    if (event.type !== 'message') return;

    if (!isAllowed(userId)) {
      return line.reply(event.replyToken, [text(`⚠️ 你還沒被授權使用。請把這個 ID 給管理員：\n${userId}`)]);
    }

    const msg = event.message;
    if (msg.type === 'location') return onLocation(event, msg);
    if (msg.type !== 'text') {
      return line.reply(event.replyToken, withQuickReply([text('目前只能轉發文字訊息喔。')]));
    }

    const t = msg.text.trim();
    const cmd = t.split(/\s+/)[0];
    switch (cmd) {
      case '/說明':
      case '/help':
        return line.reply(event.replyToken, withQuickReply([text(HELP)]));
      case '/id':
        return line.reply(event.replyToken, [text(userId)]);
      case '/位置':
        return line.reply(event.replyToken, withQuickReply([text('請按下方「📍 傳送位置」分享你目前的位置。')]));
      case '/即時': {
        const on = !/關|off/i.test(t);
        db.setLive(userId, on);
        return line.reply(event.replyToken, [text(on ? '🔔 已開啟即時轉發' : '🔕 已關閉即時轉發')]);
      }
      case '/完成':
        return line.reply(event.replyToken, [text(completeOrder(t, currentGroup(userId).group?.group_id))]);
      case '/最近': {
        const { user, group } = currentGroup(userId);
        if (!group) return askLocation(event, user);
        const { messages, targets } = summary(userId, group, `📍 ${group.region}`);
        return send({ replyToken: event.replyToken }, messages, targets);
      }
      case '/單': {
        const { user, group } = currentGroup(userId);
        if (!group) return askLocation(event, user);
        const orders = db.openOrders(group.group_id, 5);
        if (!orders.length) return line.reply(event.replyToken, withQuickReply([text(`📋 ${group.region} 目前沒有未完成的單`)]));
        const targets = orders.map((o) => ({ groupId: group.group_id, authorUserId: o.user_id, messageId: o.id }));
        targets.userId = userId;
        return send({ replyToken: event.replyToken }, withQuickReply(orders.map((o) => orderBubble(o, group.region))), targets);
      }
    }
    return relayToGroup(event, userId, t);
  }

  function askLocation(event, user) {
    const why = user?.region
      ? `「${user.region}」還沒有綁定群組，請在該區群組輸入「/綁定 ${user.region}」。`
      : '我還不知道你在哪一區。';
    return line.reply(event.replyToken, withQuickReply([text(`${why}\n請按下方「📍 傳送位置」。`)]));
  }

  async function onLocation(event, msg) {
    const userId = event.source.userId;
    const hit = nearestRegion(regions, msg.latitude, msg.longitude);
    if (!hit) return line.reply(event.replyToken, [text('還沒有設定任何區域（config/regions.json）')]);

    const { region, distanceKm, inside } = hit;
    const dist = `距離中心 ${distanceKm.toFixed(1)} km`;
    if (!inside) {
      return line.reply(event.replyToken, withQuickReply([
        text(`📍 你目前不在任何服務區內。\n最近的是「${region.name}」，${dist}（範圍 ${region.radiusKm} km）。\n進入範圍後再傳一次位置就可以了。`),
      ]));
    }
    db.setUserLocation(userId, region.name, msg.latitude, msg.longitude, config.liveDefault);
    const header = `📍 你目前在「${region.name}」（${dist}）`;

    const group = db.groupByRegion(region.name);
    if (!group) {
      return line.reply(event.replyToken, withQuickReply([
        text(`${header}\n\n但這個區還沒綁定群組。請把我加進該區群組並輸入「/綁定 ${region.name}」。`),
      ]));
    }
    const { messages, targets } = summary(userId, group, header);
    return send({ replyToken: event.replyToken }, messages, targets);
  }

  async function relayToGroup(event, userId, t) {
    // 使用者長按「回覆」某則機器人轉來的訊息 → 送回那則訊息所屬的群組，並標記原作者
    const quoted = event.message.quotedMessageId ? db.relay(event.message.quotedMessageId, userId) : null;
    let group = quoted ? db.groupById(quoted.group_id) : null;
    if (!group) {
      const cur = currentGroup(userId);
      if (!cur.group) return askLocation(event, cur.user);
      group = cur.group;
    }

    const name = await ownName(userId, group.group_id);
    const { message, mentionedUserIds } = buildGroupMessage({
      prefix: `💬 ${name}：`,
      text: t,
      members: db.members(group.group_id),
      quotedAuthorId: quoted?.author_user_id,
      excludeUserId: userId,
    });

    try {
      await line.push(group.group_id, [message]);
    } catch (err) {
      console.error('轉發到群組失敗', err.message);
      return line.reply(event.replyToken, [text(`❌ 轉發失敗：${clip(err.message, 300)}`)]);
    }

    const det = await config.detectOrder(t);
    const order = det.isOrder;
    const id = db.insertMessage({ groupId: group.group_id, userId, displayName: name, text: t, isOrder: order, summary: det.summary, viaBot: true });
    // 機器人推到群組的訊息不會再觸發 webhook，所以這裡自己通知該區其他開即時轉發的人
    forwardLive(group.group_id, { id, userId, displayName: name, text: t, isOrder: order, summary: det.summary, createdAt: Date.now() })
      .catch((err) => console.error('即時轉發失敗', err.message));

    const tagged = mentionedUserIds.map((uid) => db.member(group.group_id, uid)?.display_name ?? '成員');
    const lines = [`✅ 已送到「${group.region}」群組`];
    if (tagged.length) lines.push(`已標記：${tagged.join('、')}`);
    if (message.substitution?.all) lines.push('已標記：所有人');
    if (order) lines.push(`📋 已記為單 #${id}`);
    return line.reply(event.replyToken, [text(lines.join('\n'))]);
  }

  return {
    async handleEvent(event) {
      const type = event.source?.type;
      if (type === 'group') return onGroupEvent(event);
      if (type === 'user') return onUserEvent(event);
    },
  };
}
