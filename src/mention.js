// 把「@名字」轉成 LINE textV2 的 mention，被標記的人會收到通知。
// 文件：https://developers.line.biz/en/reference/messaging-api/#text-message-v2

const ALL_KEYWORDS = ['@所有人', '@all', '@All', '@ALL'];

// textV2 用 {key} 當佔位符，使用者文字裡的大括號換成全形避免被誤判
const sanitize = (s) => String(s).replace(/\{/g, '｛').replace(/\}/g, '｝');

/**
 * @param {object} p
 * @param {string} p.prefix       訊息開頭（例如「💬 王小明：」）
 * @param {string} p.text         使用者輸入的內容
 * @param {{user_id:string, display_name:string}[]} p.members  群組成員（用來比對 @名字）
 * @param {string} [p.quotedAuthorId]  使用者回覆的那則訊息的原作者，會自動標記
 * @param {string} [p.excludeUserId]   不要標記的人（通常是發話者自己）
 * @returns {{message: object, mentionedUserIds: string[]}}
 */
export function buildGroupMessage({ prefix = '', text, members = [], quotedAuthorId, excludeUserId }) {
  let body = sanitize(text);
  const substitution = {};
  const keyByUser = new Map();
  const keyFor = (userId) => {
    if (!keyByUser.has(userId)) {
      const key = `m${keyByUser.size}`;
      keyByUser.set(userId, key);
      substitution[key] = { type: 'mention', mentionee: { type: 'user', userId } };
    }
    return keyByUser.get(userId);
  };

  for (const kw of ALL_KEYWORDS) {
    if (body.includes(kw)) {
      substitution.all = { type: 'mention', mentionee: { type: 'all' } };
      body = body.split(kw).join('{all}');
    }
  }

  // 名字長的先比對，避免「小明」先吃掉「小明哥」
  const sorted = members
    .filter((m) => m.display_name)
    .sort((a, b) => b.display_name.length - a.display_name.length);
  for (const m of sorted) {
    const tag = '@' + sanitize(m.display_name);
    if (body.includes(tag)) body = body.split(tag).join(`{${keyFor(m.user_id)}}`);
  }

  if (quotedAuthorId && quotedAuthorId !== excludeUserId && !keyByUser.has(quotedAuthorId)) {
    body = `{${keyFor(quotedAuthorId)}} ${body}`;
  }

  const full = sanitize(prefix) + body;
  const mentionedUserIds = [...keyByUser.keys()];
  if (Object.keys(substitution).length === 0) {
    return { message: { type: 'text', text: full }, mentionedUserIds };
  }
  return { message: { type: 'textV2', text: full, substitution }, mentionedUserIds };
}
