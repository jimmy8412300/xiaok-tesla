# xiaok-tesla — LINE 定位分區機器人

依照你**所在位置屬於哪一區**，自動把該區 LINE 群組的**最近對話紀錄**和**未完成的單子**拉到你跟機器人的私訊裡。
你在私訊裡回的話，機器人會**自動轉發到那一區的群組**，並**標記（@）相關的人**。

```
 北區群組 ─┐                         ┌─ 你傳位置 → 判斷在「北區」
 中區群組 ─┼─► 機器人記錄所有訊息/單子 ─┤   → 拉出北區最近對話 + 單子
 南區群組 ─┘                         └─ 你打字回覆 → 推到北區群組並 @對方
```

## 功能

| 功能 | 怎麼用 |
|---|---|
| 依位置切換區域 | 私訊按「📍 傳送位置」，機器人找最近的區（`config/regions.json`） |
| 拉取最近對話 | 傳位置後自動顯示，或打 `/最近` |
| 單子 | 群組裡符合 `ORDER_PATTERN` 的訊息（預設 `#單`、`【單】`、`派單`、`訂單` 開頭，或含 `單號`）會記成單；`/單` 列出、`/完成 12` 結案 |
| 回覆到群組 | 私訊直接打字 → 以「💬 你的名字：內容」推到該區群組 |
| 自動標記 | ① 長按機器人轉來的訊息選「回覆」→ 自動 @原發話者，並送回**那則訊息所屬的群組**<br>② 打 `@名字` → @該成員<br>③ `@所有人` → @全部 |
| 即時轉發 | 你所在區有新訊息時即時私訊給你，`/即時 關` 可關閉 |
| 權限控管 | 只有 `ALLOWED_USER_IDS` 裡的人能用私訊功能 |

## 安裝

需要 Node.js 22.9 以上，**沒有其他套件依賴**（使用內建 SQLite）。

1. **建立 LINE 官方帳號 / Messaging API channel**：<https://developers.line.biz/console/>
   - Messaging API 分頁：發行 **Channel access token**；記下 Basic settings 的 **Channel secret**
   - 開啟 **Allow bot to join group chats**
   - LINE Official Account Manager：關閉「自動回應訊息」、開啟「Webhook」
2. 設定：
   ```bash
   cp .env.example .env                       # 填入 secret / token
   cp config/regions.example.json config/regions.json   # 填入各區中心座標與半徑(km)
   npm start
   ```
3. 把伺服器公開成 HTTPS（正式環境用 Render / Fly.io / VPS；本機測試可用 `ngrok http 3000`），
   在 LINE Console 設定 Webhook URL：`https://你的網址/webhook`，按 Verify。
4. 把機器人加進各區群組，在群組裡輸入：`/綁定 北區`（區名要跟 `regions.json` 一致）
5. 自己加機器人好友，輸入 `/id` 取得 userId，填進 `.env` 的 `ALLOWED_USER_IDS` 後重啟。
6. 私訊按「📍 傳送位置」開始使用。

## 指令

私訊：`/最近`、`/單`、`/完成 編號`、`/即時 開|關`、`/位置`、`/id`、`/說明`
群組：`/綁定 區名`、`/完成 編號`

## 要注意的限制

- **只看得到加入之後的訊息**：LINE 不提供讀取群組歷史紀錄的 API，機器人只能記錄它進群組之後的對話。
- **定位要手動傳**：LINE 不允許機器人在背景追蹤位置，需要你按「傳送位置」。（之後可以加一個 LIFF 網頁，打開就自動抓 GPS。）
- **推播額度**：回覆你（reply）是免費的；但「轉發到群組」和「即時轉發」是 push，會算進官方帳號每月免費訊息額度（台灣輕用量方案約 200 則/月）。量大的話可以 `LIVE_FORWARD_DEFAULT=off` 或升級方案。
- **被標記的人必須在該群組內**，而且機器人要看過他發言過才知道他的名字（`@名字` 比對的是群組顯示名稱）。
- 群組訊息會出現為「機器人」發送，開頭帶你的名字。

## 開發

```bash
npm test     # 用假的 LINE API 跑完整流程測試
```

程式結構：`src/server.js`（webhook）、`src/bot.js`（主要邏輯）、`src/mention.js`（@標記 → textV2）、
`src/regions.js`（距離計算）、`src/db.js`（SQLite）、`src/line.js`（LINE API）。
