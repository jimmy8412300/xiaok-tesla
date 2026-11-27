import { createServer } from 'node:http';
import { createLineClient, verifySignature } from './line.js';
import { openDb } from './db.js';
import { loadRegions } from './regions.js';
import { createBot } from './bot.js';
import { createOrderDetector, anthropicFromEnv } from './orders.js';

const env = process.env;
for (const k of ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN']) {
  if (!env[k]) {
    console.error(`缺少環境變數 ${k}（請參考 .env.example）`);
    process.exit(1);
  }
}

const allowed = (env.ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!allowed.length) console.warn('⚠️ ALLOWED_USER_IDS 是空的：任何加機器人好友的人都能讀到群組內容');

const config = {
  allowedUserIds: allowed.length ? new Set(allowed) : null,
  recentLimit: Number(env.RECENT_LIMIT ?? 10),
  liveDefault: !/^(off|false|0)$/i.test(env.LIVE_FORWARD_DEFAULT ?? 'on'),
  tz: env.DISPLAY_TZ ?? 'Asia/Taipei',
};

const anthropic = anthropicFromEnv(env);
config.detectOrder = createOrderDetector({
  forcePattern: new RegExp(env.ORDER_PATTERN || '^(#單|【單】|派單|訂單|接單)|單號'),
  threshold: Number(env.ORDER_SCORE_THRESHOLD ?? 3),
  anthropic,
  model: env.CLAUDE_MODEL || 'claude-opus-5-5',
});
console.log(anthropic ? `單子判斷：Claude（${env.CLAUDE_MODEL || 'claude-opus-5-5'}）＋規則` : '單子判斷：規則（設定 ANTHROPIC_API_KEY 可改用 Claude）');

const regions = loadRegions(env.REGIONS_PATH ?? './config/regions.json');
const db = openDb(env.DB_PATH ?? './data/bot.db');
const line = createLineClient({ token: env.LINE_CHANNEL_ACCESS_TOKEN });
const bot = createBot({ line, db, regions, config });

// 依序處理事件，避免同一群組的訊息順序錯亂
let queue = Promise.resolve();
const enqueue = (events) => {
  for (const ev of events) {
    queue = queue.then(() => bot.handleEvent(ev)).catch((err) => console.error('處理事件失敗', err));
  }
};

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (!verifySignature(raw, env.LINE_CHANNEL_SECRET, req.headers['x-line-signature'])) {
      res.writeHead(401).end('bad signature');
      return;
    }
    res.writeHead(200).end('ok');
    try {
      enqueue(JSON.parse(raw.toString('utf8')).events ?? []);
    } catch (err) {
      console.error('webhook 內容解析失敗', err);
    }
  });
});

const port = Number(env.PORT ?? 3000);
server.listen(port, () => console.log(`機器人啟動：http://localhost:${port}/webhook （區域：${regions.map((r) => r.name).join('、')}）`));
