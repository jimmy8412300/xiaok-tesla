import { nearestRegion, matchPlaces } from './regions.js';
import { buildGroupMessage } from './mention.js';
import { parseKeywords } from './orders.js';

const MAX_TEXT = 4900;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const NON_TEXT_LABEL = {
  image: '[圖片]', video: '[影片]', audio: '[語音]', file: '[檔案]', sticker: '[貼圖]', location: '[位置]',
};

const HELP = [
  '📖 使用方式',
  '1. 按下方「📍 傳送位置」，我會從所有群組裡找出你所在區的單子（例如上車點在基隆的）。',
  '2. 長按某張單選「回覆」再打字 → 送回那張單原本的群組並標記發單人。',
  '3. 群組裡的派工、交車、接送等需求會自動辨識成「單」。',
  '4. 長按我轉來的某則訊息選「回覆」→ 會自動標記那則訊息的發話者。',
  '5. 打「@名字」可標記群組裡的人，「@所有人」標記全部。',
  '',
  '指令：',
  '/最近　重新拉取對話與單子',
  '/單　列出你所在區的單（/單 2 看下一批）',
  '/完成 編號　把單子標成完成（例：/完成 12）',
  '/即時 開｜單｜關　即時轉發全部／只轉單子／關閉',
  '/關鍵字　查看這區群組抓單的關鍵字',
  '/關鍵字 新增 交車 拖吊　（可一次多個）',
  '/關鍵字 刪除 交車　／　/關鍵字 清空（回到自動判斷）',
  '/關鍵字 全部　這個群組每則訊息都當成單（派單群）',
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

  const since = () => Date.now() - config.orderMaxAgeHours * 3600_000;
  const groupLabel = (groupId) => db.groupName(groupId) ?? '群組';

  function orderBubble(o, region) {
    const sum = o.order_summary ? `📝 ${o.order_summary}\n` : '';
    const where = region && o.regions?.includes(`,${region}:drop,`) ? `🏁 送到${region}` : region ? `🚩 ${region}上車` : '';
    return text(
      `📋 單 #${o.id}｜${groupLabel(o.group_id)}\n${where ? where + '\n' : ''}${sum}${o.display_name ?? '成員'}　${time(o.created_at)}\n\n${o.text}\n\n` +
        `↩️ 長按此訊息「回覆」→ 回到這個群組並標記 ${o.display_name ?? '發單人'}`,
    );
  }

  function regionSummary(userId, region, header) {
    const orders = db.regionOrders(region, since(), 4);
    const total = db.countRegionOrders(region, since());
    const group = db.groupByRegion(region);
    const recent = group ? db.recent(group.group_id, config.recentLimit) : [];

    const lines = [header, ''];
    lines.push(total ? `📋 最近 ${config.orderMaxAgeHours} 小時、各群組裡跟「${region}」有關的單：${total} 張` : `📋 最近 ${config.orderMaxAgeHours} 小時沒有跟「${region}」有關的單`);
    if (total > orders.length) lines.push(`（先顯示 ${orders.length} 張，${region}上車的排前面；輸入 /單 看下一批）`);
    if (recent.length) {
      lines.push('', `🗨 ${groupLabel(group.group_id)} 最近 ${recent.length} 則對話`);
      for (const m of recent) {
        const tag = m.is_order ? `📋#${m.id} ` : '';
        lines.push(`[${time(m.created_at)}] ${m.display_name ?? '成員'}：${tag}${clip(m.text.replace(/\n/g, ' '), 80)}`);
      }
    }
    lines.push('', '想接哪張單，就長按那張單選「回覆」，打字會送回原本的群組並標記發單人。');

    const messages = [text(lines.join('\n')), ...orders.map((o) => orderBubble(o, region))];
    const targets = [
      group ? { groupId: group.group_id, authorUserId: null, messageId: null } : null,
      ...orders.map((o) => ({ groupId: o.group_id, authorUserId: o.user_id, messageId: o.id })),
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
        text(`大家好！我會整理這個群組裡的單子，依上車地點分區（${names}）。\n（選填）整個群組都屬於同一區的話，可以輸入「/綁定 區名」。`),
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

    if (msg.type === 'text' && raw.startsWith('/關鍵字')) {
      if (raw.trim() !== '/關鍵字' && !isAllowed(userId)) {
        return line.reply(event.replyToken, [text('只有管理名單（ALLOWED_USER_IDS）裡的人可以修改關鍵字')]);
      }
      return line.reply(event.replyToken, [text(keywordCommand(raw, groupId, groupLabel(groupId)))]);
    }

    if (!db.hasGroupInfo(groupId)) {
      let name = null;
      try {
        name = (await line.groupSummary(groupId)).groupName;
      } catch {}
      db.setGroupName(groupId, name);
    }

    const displayName = userId ? (await nameInGroup(groupId, userId)) ?? '成員' : '成員';
    await record(groupId, { userId, displayName, text: raw, isText: msg.type === 'text', createdAt: event.timestamp });
  }

  /** 存進資料庫、判斷是不是單、標記跟哪些區有關，然後即時轉發 */
  async function record(groupId, { userId, displayName, text: t, isText = true, viaBot = false, createdAt = Date.now() }) {
    const det = isText ? await config.detectOrder(t, { keywords: db.keywords(groupId) }) : { isOrder: false };
    const tags = isText ? matchPlaces(regions, t) : [];
    const bound = db.groupById(groupId)?.region;
    if (bound && !tags.some((x) => x.name === bound)) tags.push({ name: bound, where: 'pickup' });
    const id = db.insertMessage({ groupId, userId, displayName, text: t, isOrder: det.isOrder, summary: det.summary, regions: tags, viaBot, createdAt });
    const m = { id, userId, displayName, text: t, isOrder: det.isOrder, summary: det.summary, createdAt };
    forwardLive(groupId, m, tags).catch((err) => console.error('即時轉發失敗', err.message));
    return m;
  }

  async function forwardLive(groupId, m, tags) {
    const seen = new Set();
    const recipients = [];
    for (const tag of tags) {
      for (const u of db.liveUsersInRegion(tag.name)) {
        if (seen.has(u.user_id) || u.user_id === m.userId || !isAllowed(u.user_id)) continue;
        if (u.live === 2 && !m.isOrder) continue;
        seen.add(u.user_id);
        recipients.push({ u, tag });
      }
    }
    for (const { u, tag } of recipients) {
      const where = tag.where === 'drop' ? `🏁 送到${tag.name}` : `🚩 ${tag.name}`;
      const head = m.isOrder ? `📋 新單 #${m.id}｜${where}` : `🔔 ${where}`;
      const sum = m.summary ? `📝 ${m.summary}\n` : '';
      const body = `${head}\n${groupLabel(groupId)}\n${sum}${m.displayName}　${time(m.createdAt)}\n\n${m.text}`;
      const targets = [{ groupId, authorUserId: m.userId, messageId: m.id }];
      try {
        await send({ to: u.user_id }, [text(body)], targets);
      } catch (err) {
        console.error('即時轉發失敗', u.user_id, err.message);
      }
    }
  }

  function keywordCommand(raw, groupId, label) {
    const rest = raw.replace('/關鍵字', '').trim();
    const [action, ...more] = rest.split(/\s+/);
    const list = parseKeywords(more.join(' '));
    if (/^(新增|加|add)$/i.test(action ?? '') && list.length) db.addKeywords(groupId, list);
    else if (/^(刪除|移除|刪|del)$/i.test(action ?? '') && list.length) db.delKeywords(groupId, list);
    else if (/^(清空|清除|clear)$/i.test(action ?? '')) db.clearKeywords(groupId);
    else if (/^(全部|all|\*)$/i.test(action ?? '')) (db.clearKeywords(groupId), db.addKeywords(groupId, ['*']));
    else if (rest) return '用法：/關鍵字 新增 交車 拖吊　｜　/關鍵字 刪除 交車　｜　/關鍵字 全部　｜　/關鍵字 清空';

    const now = db.keywords(groupId);
    if (now.includes('*')) return `🔑 「${label}」設定為：每則訊息都當成單（派單群適用）。\n改回：/關鍵字 清空`;
    return now.length
      ? `🔑 「${label}」抓單關鍵字（${now.length}）：\n${now.join('、')}\n\n訊息裡有任一個字眼就記成一張單。`
      : `🔑 「${label}」沒有設定關鍵字，目前用自動判斷（時間、地點、電話、任務…）。\n設定：/關鍵字 新增 交車 拖吊`;
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
        const mode = /關|off/i.test(t) ? 0 : /單|order/i.test(t) ? 2 : 1;
        db.setLive(userId, mode);
        const msgs = ['🔕 已關閉即時轉發', '🔔 已開啟即時轉發（全部訊息）', '📋 即時轉發：只轉跟你所在區有關的單子'];
        return line.reply(event.replyToken, [text(msgs[mode])]);
      }
      case '/關鍵字': {
        const { user, group } = currentGroup(userId);
        if (!group) return askLocation(event, user);
        return line.reply(event.replyToken, [text(keywordCommand(t, group.group_id, group.region))]);
      }
      case '/完成':
        return line.reply(event.replyToken, [text(completeOrder(t))]);
      case '/最近': {
        const user = db.user(userId);
        if (!user?.region) return askLocation(event);
        const { messages, targets } = regionSummary(userId, user.region, `📍 ${user.region}`);
        return send({ replyToken: event.replyToken }, messages, targets);
      }
      case '/單': {
        const user = db.user(userId);
        if (!user?.region) return askLocation(event);
        // 一次最多 5 則；/單 2 看第二批
        const page = Math.max(1, Number(t.split(/\s+/)[1]) || 1);
        const orders = db.regionOrders(user.region, since(), page * 5).slice((page - 1) * 5);
        if (!orders.length) return line.reply(event.replyToken, withQuickReply([text(`📋 沒有更多跟「${user.region}」有關的單了`)]));
        const targets = orders.map((o) => ({ groupId: o.group_id, authorUserId: o.user_id, messageId: o.id }));
        targets.userId = userId;
        return send({ replyToken: event.replyToken }, withQuickReply(orders.map((o) => orderBubble(o, user.region))), targets);
      }
    }
    return relayToGroup(event, userId, t);
  }

  function askLocation(event, user) {
    const why = user?.region
      ? `「${user.region}」還沒有綁定群組。\n要回覆某張單，請長按那張單選「回覆」；或在該區群組輸入「/綁定 ${user.region}」。`
      : '我還不知道你在哪一區。\n請按下方「📍 傳送位置」。';
    return line.reply(event.replyToken, withQuickReply([text(why)]));
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
    const { messages, targets } = regionSummary(userId, region.name, header);
    return send({ replyToken: event.replyToken }, messages, targets);
  }

  async function relayToGroup(event, userId, t) {
    // 使用者長按「回覆」某則機器人轉來的訊息 → 送回那則訊息所屬的群組，並標記原作者
    const quoted = event.message.quotedMessageId ? db.relay(event.message.quotedMessageId, userId) : null;
    let groupId = quoted?.group_id;
    if (!groupId) {
      const cur = currentGroup(userId);
      if (!cur.group) return askLocation(event, cur.user);
      groupId = cur.group.group_id;
    }
    const group = { group_id: groupId, label: groupLabel(groupId) };

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

    // 機器人推到群組的訊息不會再觸發 webhook，所以這裡自己記錄並通知其他人
    const rec = await record(group.group_id, { userId, displayName: name, text: t, viaBot: true });

    const tagged = mentionedUserIds.map((uid) => db.member(group.group_id, uid)?.display_name ?? '成員');
    const lines = [`✅ 已送到「${group.label}」`];
    if (tagged.length) lines.push(`已標記：${tagged.join('、')}`);
    if (message.substitution?.all) lines.push('已標記：所有人');
    if (rec.isOrder) lines.push(`📋 已記為單 #${rec.id}`);
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
