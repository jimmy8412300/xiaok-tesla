import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.line.me/v2/bot';

export function verifySignature(rawBody, secret, signature) {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createLineClient({ token, fetchImpl = fetch }) {
  async function call(method, path, body) {
    const res = await fetchImpl(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LINE API ${method} ${path} -> ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }

  return {
    reply: (replyToken, messages) => call('POST', '/message/reply', { replyToken, messages }),
    push: (to, messages) => call('POST', '/message/push', { to, messages }),
    profile: (userId) => call('GET', `/profile/${encodeURIComponent(userId)}`),
    groupMemberProfile: (groupId, userId) =>
      call('GET', `/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`),
    groupSummary: (groupId) => call('GET', `/group/${encodeURIComponent(groupId)}/summary`),
  };
}
