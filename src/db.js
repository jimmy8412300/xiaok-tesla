import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS groups (
      group_id TEXT PRIMARY KEY, region TEXT NOT NULL, name TEXT
    );
    CREATE TABLE IF NOT EXISTS members (
      group_id TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL, user_id TEXT, display_name TEXT, text TEXT NOT NULL,
      is_order INTEGER NOT NULL DEFAULT 0, order_status TEXT, order_summary TEXT,
      via_bot INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY, region TEXT, lat REAL, lng REAL,
      live INTEGER NOT NULL DEFAULT 1, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS keywords (
      group_id TEXT NOT NULL, keyword TEXT NOT NULL, PRIMARY KEY (group_id, keyword)
    );
    -- 機器人私訊出去的每一則訊息 → 原始群組/作者，讓使用者「回覆」那則訊息時能自動標記原作者
    CREATE TABLE IF NOT EXISTS relay (
      sent_message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, group_id TEXT NOT NULL,
      author_user_id TEXT, message_id INTEGER
    );
  `);
  // 舊資料庫補欄位
  const cols = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
  if (!cols.includes('order_summary')) db.exec(`ALTER TABLE messages ADD COLUMN order_summary TEXT`);

  const q = (sql) => db.prepare(sql);
  const s = {
    bindGroup: q(`INSERT INTO groups (group_id, region, name) VALUES (?, ?, ?)
                  ON CONFLICT(group_id) DO UPDATE SET region = excluded.region, name = excluded.name`),
    groupById: q(`SELECT * FROM groups WHERE group_id = ?`),
    groupByRegion: q(`SELECT * FROM groups WHERE region = ? LIMIT 1`),
    upsertMember: q(`INSERT INTO members (group_id, user_id, display_name) VALUES (?, ?, ?)
                     ON CONFLICT DO UPDATE SET display_name = excluded.display_name`),
    member: q(`SELECT * FROM members WHERE group_id = ? AND user_id = ?`),
    members: q(`SELECT * FROM members WHERE group_id = ?`),
    insertMessage: q(`INSERT INTO messages (group_id, user_id, display_name, text, is_order, order_status, order_summary, via_bot, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    recent: q(`SELECT * FROM (SELECT * FROM messages WHERE group_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`),
    openOrders: q(`SELECT * FROM messages WHERE group_id = ? AND is_order = 1 AND order_status = 'open' ORDER BY id DESC LIMIT ?`),
    countOpenOrders: q(`SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND is_order = 1 AND order_status = 'open'`),
    messageById: q(`SELECT * FROM messages WHERE id = ?`),
    setOrderStatus: q(`UPDATE messages SET order_status = ? WHERE id = ? AND is_order = 1`),
    user: q(`SELECT * FROM users WHERE user_id = ?`),
    upsertUserLocation: q(`INSERT INTO users (user_id, region, lat, lng, live, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                           ON CONFLICT(user_id) DO UPDATE SET region = excluded.region, lat = excluded.lat,
                           lng = excluded.lng, updated_at = excluded.updated_at`),
    setLive: q(`INSERT INTO users (user_id, live, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET live = excluded.live`),
    liveUsersInRegion: q(`SELECT * FROM users WHERE region = ? AND live >= 1`),
    keywords: q(`SELECT keyword FROM keywords WHERE group_id = ? ORDER BY rowid`),
    addKeyword: q(`INSERT OR IGNORE INTO keywords (group_id, keyword) VALUES (?, ?)`),
    delKeyword: q(`DELETE FROM keywords WHERE group_id = ? AND keyword = ?`),
    clearKeywords: q(`DELETE FROM keywords WHERE group_id = ?`),
    insertRelay: q(`INSERT OR REPLACE INTO relay (sent_message_id, user_id, group_id, author_user_id, message_id) VALUES (?, ?, ?, ?, ?)`),
    relay: q(`SELECT * FROM relay WHERE sent_message_id = ? AND user_id = ?`),
  };

  return {
    raw: db,
    bindGroup: (groupId, region, name) => s.bindGroup.run(groupId, region, name ?? null),
    groupById: (groupId) => s.groupById.get(groupId),
    groupByRegion: (region) => s.groupByRegion.get(region),
    upsertMember: (groupId, userId, name) => s.upsertMember.run(groupId, userId, name),
    member: (groupId, userId) => s.member.get(groupId, userId),
    members: (groupId) => s.members.all(groupId),
    insertMessage: ({ groupId, userId, displayName, text, isOrder, summary, viaBot = false, createdAt = Date.now() }) =>
      Number(s.insertMessage.run(groupId, userId ?? null, displayName ?? null, text,
        isOrder ? 1 : 0, isOrder ? 'open' : null, isOrder && summary ? summary : null,
        viaBot ? 1 : 0, createdAt).lastInsertRowid),
    recent: (groupId, limit) => s.recent.all(groupId, limit),
    openOrders: (groupId, limit) => s.openOrders.all(groupId, limit),
    countOpenOrders: (groupId) => s.countOpenOrders.get(groupId).n,
    messageById: (id) => s.messageById.get(id),
    setOrderStatus: (id, status) => s.setOrderStatus.run(status, id).changes > 0,
    user: (userId) => s.user.get(userId),
    setUserLocation: (userId, region, lat, lng, liveDefault) =>
      s.upsertUserLocation.run(userId, region, lat, lng, liveDefault ? 1 : 0, Date.now()),
    /** live：0 關、1 全部轉發、2 只轉發單子 */
    setLive: (userId, mode) => s.setLive.run(userId, Number(mode), Date.now()),
    keywords: (groupId) => s.keywords.all(groupId).map((r) => r.keyword),
    addKeywords: (groupId, list) => list.forEach((k) => s.addKeyword.run(groupId, k)),
    delKeywords: (groupId, list) => list.forEach((k) => s.delKeyword.run(groupId, k)),
    clearKeywords: (groupId) => s.clearKeywords.run(groupId),
    liveUsersInRegion: (region) => s.liveUsersInRegion.all(region),
    insertRelay: (sentId, userId, groupId, authorUserId, messageId) =>
      s.insertRelay.run(sentId, userId, groupId, authorUserId ?? null, messageId ?? null),
    relay: (sentId, userId) => s.relay.get(sentId, userId),
  };
}
