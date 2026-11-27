// 判斷一則訊息是不是「單子」。
// 1) 明確開頭（#單、派單…）→ 一定是單
// 2) 規則打分：電話、時間、地址、金額、任務動詞、車型… 分數夠高就是單
// 3) 有設定 ANTHROPIC_API_KEY 時，有任何跡象的訊息交給 Claude 判斷，並產生一行摘要
import Anthropic from '@anthropic-ai/sdk';

const SIGNALS = [
  { re: /09\d{2}[-\s]?\d{3}[-\s]?\d{3}|0\d{1,2}[-\s]?\d{6,8}/, w: 2, label: '電話' },
  { re: /\d{1,2}[:：]\d{2}|\d{1,2}\s*點(半|\d{1,2}分)?|(今|明|後)(天|晚|早)|早上|中午|下午|晚上|禮拜|星期|週[一二三四五六日]/, w: 1, label: '時間' },
  { re: /\d{1,2}\s*[/月]\s*\d{1,2}\s*日?/, w: 1, label: '日期' },
  { re: /[路街道巷弄段號樓]|基隆|七堵|暖暖|安樂|仁愛|信義|中正|中山|八堵|百福|港口|火車站|交流道/, w: 1, label: '地點' },
  { re: /\d+\s*(元|塊|k\b)|\$\s*\d+|NT\$?\s*\d+|費用|報價|價錢|多少錢/i, w: 1, label: '金額' },
  { re: /交車|取車|送車|牽車|接送|載|維修|保養|安裝|充電|拖吊|救援|洗車|鍍膜|貼膜|代駕|預約|叫車|出車|接人|支援|急件|派|徵|缺人|誰可以|有人可以|誰有空|麻煩.*(去|跑|幫)/, w: 1, label: '任務' },
  { re: /⬇️|⬇|↓|→|➡️|上車|下車|接送|機場/, w: 1, label: '路線' },
  { re: /\d+\s*(巷|弄|號)/, w: 1, label: '地址' },
  { re: /model\s*[3ysx]|特斯拉|tesla|車牌|[A-Z]{2,3}-?\d{3,4}/i, w: 1, label: '車' },
];

export function scoreOrder(text) {
  const t = text.trim();
  if (t.length < 6) return { score: 0, labels: [] };
  const hits = SIGNALS.filter((s) => s.re.test(t));
  return { score: hits.reduce((a, s) => a + s.w, 0), labels: hits.map((s) => s.label) };
}

const SYSTEM = `你在一個台灣的 LINE 工作群組裡協助整理「單子」。
「單子」是指需要有人去執行的工作或任務：派工、交車/取車、接送、維修、服務預約、客戶需求、徵求人手支援等，通常帶有時間、地點、聯絡方式、金額或車輛資訊其中幾項。
閒聊、問候、回報「收到/我到了/完成了」、一般討論與單純提問都不是單子。
如果是單子，summary 用一行繁體中文（30 字內）寫出：做什麼｜何時｜哪裡；不是單子就給空字串。`;

const SCHEMA = {
  type: 'object',
  properties: {
    is_order: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['is_order', 'summary'],
  additionalProperties: false,
};

export function createOrderDetector({ forcePattern, threshold = 3, anthropic = null, model = 'claude-opus-5-5', log = console }) {
  async function askClaude(text) {
    const res = await anthropic.beta.messages.create({
      model,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `群組訊息：\n"""\n${text}\n"""` }],
    });
    if (res.stop_reason === 'refusal') throw new Error('Claude 拒絕判斷');
    const block = res.content.find((b) => b.type === 'text');
    if (!block) throw new Error(`Claude 沒有回傳結果（stop_reason=${res.stop_reason}）`);
    const out = JSON.parse(block.text);
    return { isOrder: Boolean(out.is_order), summary: out.is_order ? String(out.summary || '') : '' };
  }

  /** keywords：該群組自訂的關鍵字。有設定時只看關鍵字（加上強制開頭），不做自動判斷 */
  return async function detectOrder(text, { keywords = [] } = {}) {
    const t = text.trim();
    if (forcePattern?.test(t)) return { isOrder: true, summary: '', by: 'prefix' };
    if (keywords.length) {
      if (keywords.includes('*')) return { isOrder: t.length >= 6, summary: '', by: 'keyword', hits: [] };
      const hits = matchKeywords(t, keywords);
      return { isOrder: hits.length > 0, summary: hits.length ? `關鍵字：${hits.join('、')}` : '', by: 'keyword', hits };
    }
    const { score } = scoreOrder(t);
    if (anthropic && score >= 1) {
      try {
        return { ...(await askClaude(t)), by: 'claude' };
      } catch (err) {
        log.error('Claude 判斷單子失敗，改用規則判斷：', err.message);
      }
    }
    return { isOrder: score >= threshold, summary: '', by: 'rules' };
  };
}

export function matchKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

/** 「交車, 取車、拖吊 接送」→ ['交車','取車','拖吊','接送'] */
export function parseKeywords(s) {
  return [...new Set(s.split(/[\s,，、;；]+/).map((k) => k.trim()).filter(Boolean))];
}

export function anthropicFromEnv(env) {
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return null;
  return new Anthropic();
}
