// ===============================
// ① Express（Render keep-alive）
// ===============================
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.listen(PORT, () => {
  console.log(`Keep-alive server running on port ${PORT}`);
});

// ===============================
// ② Discord Bot 本体
// ===============================
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User]
});

// ===============================
// ③ Google Sheets API
// ===============================
const { google } = require("googleapis");
const sheets = google.sheets("v4");

let todayMessageId = null;
let deadlineTime = null;
let deadlineCheck = "ON";

// ===============================
// 許可リアクション
// ===============================
const ALLOWED_REACTIONS = ["🍱", "🍚", "❌"];

// ===============================
// 日付フォーマット
// ===============================
function getTodayDateString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = ("0" + (d.getMonth() + 1)).slice(-2);
  const day = ("0" + d.getDate()).slice(-2);
  return `${y}/${m}/${day}`;
}

// ===============================
// ④ Bot 起動時
// ===============================
client.once("ready", () => {
  console.log(`Bot 起動: ${client.user.tag}`);
  initializeTodayMessage();
  fetchTodayMessageFromChannel();   // 最新投稿から投稿IDを取得
});

// ===============================
// ★ 新しいメッセージが投稿された時の処理（GAS対応）
// ===============================
client.on("messageCreate", async (message) => {
  console.log("messageCreate 発火:", message.id, message.author.username);

  try {
    // Bot 投稿でも GAS の投稿（embed付き）は処理する
    if (message.author.bot && (!message.embeds || message.embeds.length === 0)) {
      console.log("Bot 投稿（embedなし）のため無視");
      return;
    }

    // embed が無い投稿は無視（GAS の投稿は必ず embed 付き）
    if (!message.embeds || message.embeds.length === 0) {
      console.log("embed が無いため無視");
      return;
    }

    const embed = message.embeds[0];
    const title = embed?.title || "";
    console.log("受信タイトル:", title);

    // 今日の日付（BOT の判定ロジックと同じ）
    const today = getTodayDateString();
    const [year, month, day] = today.split("/");

    const key1 = `${parseInt(year)}年${parseInt(month)}月${parseInt(day)}日`;
    const key2 = `${String(year).slice(-2)}年${month}${day}日`;
    const key3 = `${parseInt(month)}月${parseInt(day)}日`;

    console.log("期待キー:", key1, "/", key2, "/", key3);

    const isTodayPost =
      title.includes(key1) ||
      title.includes(key2) ||
      title.includes(key3);

    console.log("isTodayPost 判定:", isTodayPost);

    if (!isTodayPost) {
      console.log("→ 今日の投稿ではないため処理終了");
      return;
    }

    // 今日の投稿として認識
    todayMessageId = message.id;
    console.log("今日の投稿を検出:", todayMessageId);

    // 投稿ログに書き込み
    console.log("writeTodayMessageIdToSheet を呼び出します:", todayMessageId);
    await writeTodayMessageIdToSheet(todayMessageId);

    // リアクション付与
    console.log("リアクション付与開始");
    await message.react("🍱");
    await message.react("🍚");
    await message.react("❌");
    console.log("リアクション付与完了");

  } catch (err) {
    console.error("messageCreate エラー:", err);
  }
});

// ===============================
// ⑤ リアクション追加
// ===============================
client.on("messageReactionAdd", async (reaction, user) => {
  handleReactionAdd(reaction, user);
});

// ===============================
// ⑥ リアクション削除
// ===============================
client.on("messageReactionRemove", async (reaction, user) => {
  handleReactionRemove(reaction, user);
});

// ===============================
// Discord 接続状態ログ
// ===============================
client.on("error", (err) => {
  console.error("Discord クライアントエラー:", err);
});

client.on("shardDisconnect", (event, id) => {
  console.log(`Shard ${id} disconnected`, event);
});

client.on("shardReconnecting", (id) => {
  console.log(`Shard ${id} reconnecting`);
});

client.on("shardResume", (id, replayed) => {
  console.log(`Shard ${id} resumed. Replayed events: ${replayed}`);
});

// ===============================
// ⑦ Bot ログイン
// ===============================
client.login(process.env.DISCORD_TOKEN);

// ===============================
// Node.js クラッシュ検知
// ===============================
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

// =======================================================
// ここから下が 6つの関数（Render版）
// =======================================================

// ===============================
// 今日の投稿ID・締切情報を取得（締切チェック付き）
// ===============================
async function initializeTodayMessage() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const sheetsClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: sheetsClient });

    // -------------------------------
    // ① 投稿ログから今日の投稿IDを取得
    // -------------------------------
    const postLog = await sheets.spreadsheets.values.get({
      auth: sheetsClient,
      spreadsheetId: process.env.SHEET_ID,
      range: "投稿ログ!A:C"
    });

    const rows = postLog.data.values;
    if (!rows) return;

    const today = getTodayDateString();

    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][0] === today) {
        todayMessageId = rows[i][1];
        break;
      }
    }

    console.log("今日の投稿ID:", todayMessageId);

    // -------------------------------
    // ② 設定シートを読み取り（A列=項目, B列=値）
    // -------------------------------
    const settingsSheet = await sheets.spreadsheets.values.get({
      auth: sheetsClient,
      spreadsheetId: process.env.SHEET_ID,
      range: "設定!A1:B20"
    });

    const settingsRows = settingsSheet.data.values;

    // 項目名で検索する関数
    function getSetting(name) {
      const row = settingsRows.find(r => r[0] === name);
      return row ? row[1] : null;
    }

    // 必要な設定値を取得
    const fixedDeadline = getSetting("締切固定モード");   // 例: "9:00"
    const deadlineMode  = getSetting("締切モード");        // 任意 / 固定
    const deadlineCheckSetting = getSetting("締切チェック"); // ON / OFF
    const optionalMinutes = getSetting("締切任意モード");   // 例: "2"（2時間）

    console.log("設定値 読み取り:");
    console.log("  締切固定モード:", fixedDeadline);
    console.log("  締切モード:", deadlineMode);
    console.log("  締切チェック:", deadlineCheckSetting);
    console.log("  締切任意モード:", optionalMinutes);

    // -------------------------------
    // ③ 締切時刻を決定
    // -------------------------------
    if (deadlineMode === "固定") {
      deadlineTime = fixedDeadline; // "9:00"
    } else {
      // 任意モード → 投稿時間 + 任意時間
      const postTime = getSetting("投稿時間"); // "7:00"
      const [ph, pm] = postTime.split(":").map(Number);
      const base = new Date();
      base.setHours(ph);
      base.setMinutes(pm);
      base.setSeconds(0);

      const addMinutes = parseFloat(optionalMinutes) * 60;
      base.setMinutes(base.getMinutes() + addMinutes);

      const hh = String(base.getHours()).padStart(2, "0");
      const mm = String(base.getMinutes()).padStart(2, "0");
      deadlineTime = `${hh}:${mm}`;
    }

    deadlineCheck = deadlineCheckSetting;

    console.log("最終的な締切時刻:", deadlineTime);
    console.log("締切チェック:", deadlineCheck);

    // -------------------------------
    // ④ 締切チェック結果を計算
    // -------------------------------
    if (deadlineCheck === "ON") {
      const [h, m] = deadlineTime.split(":").map(Number);
      const now = new Date();
      const deadline = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);

      isDeadlinePassed = now > deadline;
      console.log("締切チェック結果:", isDeadlinePassed ? "締切過ぎ" : "受付中");
    } else {
      isDeadlinePassed = false;
      console.log("締切チェック結果: 無効（常に受付）");
    }

  } catch (err) {
    console.error("initializeTodayMessage エラー:", err);
  }
}// ===============================
// ★③ 最新投稿から今日の投稿IDを取得（年入りタイトル対応版）
// ===============================
async function fetchTodayMessageFromChannel() {
  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (!channel) {
      console.error("チャンネルが見つかりません");
      return;
    }

    const messages = await channel.messages.fetch({ limit: 1 });
    const latest = messages.first();
    if (!latest) {
      console.log("最新メッセージが取得できませんでした");
      return;
    }

    const today = getTodayDateString(); // 2026/01/16
    const [year, month, day] = today.split("/");

    // 判定キーを複数用意（GAS のタイトル揺れに対応）
    const key1 = `${parseInt(year)}年${parseInt(month)}月${parseInt(day)}日`; // 2026年1月16日
    const key2 = `${String(year).slice(-2)}年${month}${day}日`;              // 26年01月16日
    const key3 = `${parseInt(month)}月${parseInt(day)}日`;                   // 1月16日（旧形式）

    const embed = latest.embeds[0];
    const title = embed?.title || "";

    // どれか1つでも含まれていれば「今日の投稿」と判定
    const isTodayPost =
      title.includes(key1) ||
      title.includes(key2) ||
      title.includes(key3);

    if (!isTodayPost) {
      console.log(`今日の投稿ではありません（タイトル不一致） title="${title}"`);
      console.log(`期待キー: ${key1} / ${key2} / ${key3}`);
      return;
    }

    // 今日の投稿IDをセット
    todayMessageId = latest.id;
    console.log("最新投稿から取得した投稿ID:", todayMessageId);

    // 投稿ログへ書き込み
    await writeTodayMessageIdToSheet(todayMessageId);

    // Bot がリアクションを付ける
    await latest.react("🍱");
    await latest.react("🍚");
    await latest.react("❌");

  } catch (err) {
    console.error("fetchTodayMessageFromChannel エラー:", err);
  }
}

// ===============================
// ★③ 投稿IDをスプレッドシートに書き込む（完全版）
// ===============================
async function writeTodayMessageIdToSheet(messageId) {
  try {
    console.log("writeTodayMessageIdToSheet 開始:", messageId);

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheetsClient = await auth.getClient();

    // ★ これが無かったのが原因（必須）
    const sheets = google.sheets({ version: "v4", auth: sheetsClient });

    const today = getTodayDateString();

    console.log("投稿ログ取得開始");

    // 投稿ログを取得して重複チェック
    const postLog = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "投稿ログ!A:C"
    });

    const rows = postLog.data.values || [];
    const alreadyExists = rows.some(row => row[0] === today && row[1] === messageId);

    if (alreadyExists) {
      console.log("投稿IDは既に記録済みのため、書き込みをスキップします");
      return;
    }

    console.log("投稿ログに書き込み準備:", today, messageId);

    // 投稿ログに追記
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: "投稿ログ!A:C",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[today, messageId, "Bot自動取得"]]
      }
    });

    console.log("投稿IDをスプレッドシートに書き込み完了:", messageId);

  } catch (err) {
    console.error("writeTodayMessageIdToSheet エラー:", err);
  }
}

// ===============================
// リアクション追加（注文）
// ===============================
async function handleReactionAdd(reaction, user) {
  try {
    if (user.bot) return;

    if (reaction.partial) {
      try { await reaction.fetch(); } catch {}
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch {}
    }

    if (reaction.message.id !== todayMessageId) return;

    const emoji = reaction.emoji.name;

    if (!ALLOWED_REACTIONS.includes(emoji)) {
      await reaction.users.remove(user.id);
      return;
    }

    if (emoji === "❌") return;

    if (deadlineCheck === "ON" && isAfterDeadline()) {
      await reaction.users.remove(user.id);
      await user.send("締切後のため注文できません");
      return;
    }

    const member = await findMember(user.id);
    if (!member) {
      await user.send("名簿に登録されていません。総務に連絡してください。");
      return;
    }

    await writeReactionLog({
      discordId: user.id,
      name: member.name,
      internalId: member.internalId,
      place: member.place,
      type: emoji,
      status: deadlineCheck === "OFF" ? "特別受付" : "注文"
    });

  } catch (err) {
    console.error("handleReactionAdd エラー:", err);
  }
}
// ===============================
// リアクション削除（キャンセル）
// ===============================
async function handleReactionRemove(reaction, user) {
  try {
    if (user.bot) return;

    // partial 対策（安全 fetch）
    if (reaction.partial) {
      try { await reaction.fetch(); } catch {}
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch {}
    }

    if (reaction.message.id !== todayMessageId) return;

    const emoji = reaction.emoji.name;

    // 締切後はキャンセル不可
    if (deadlineCheck === "ON" && isAfterDeadline()) {
      await reaction.users.remove(user.id);
      await user.send("締切後のためキャンセルできません");
      return;
    }

    const member = await findMember(user.id);
    if (!member) return;

    await writeReactionLog({
      discordId: user.id,
      name: member.name,
      internalId: member.internalId,
      place: member.place,
      type: emoji,
      status: "キャンセル"
    });

  } catch (err) {
    console.error("handleReactionRemove エラー:", err);
  }
}

// ===============================
// 名簿照合
// ===============================
async function findMember(discordId) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const sheetsClient = await auth.getClient();

    const res = await sheets.spreadsheets.values.get({
      auth: sheetsClient,
      spreadsheetId: process.env.SHEET_ID,
      range: "名簿!A:E"
    });

    const rows = res.data.values;
    if (!rows) return null;

    for (const row of rows) {
      if (row[0] === discordId) {
        return {
          discordId: row[0],
          internalId: row[1],
          name: row[2],
          place: row[3],
          lang: row[4]
        };
      }
    }

    return null;

  } catch (err) {
    console.error("findMember エラー:", err);
    return null;
  }
}

// ===============================
// リアクションログ書き込み（JST対応＋client上書き修正版）
// ===============================
async function writeReactionLog(data) {
  try {
    // Sheets 用クライアント
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const sheetsClient = await auth.getClient();

    // ===== JST のリアクション時間 =====
    const now = new Date();
    now.setHours(now.getHours() + 9);
    const reactionTime = now.toTimeString().slice(0, 5);

    const today = getTodayDateString();

    // ===== 投稿メッセージの JST 時刻を取得 =====
    let postTimeStr = "";
    try {
      const channel = await client.channels.fetch(process.env.CHANNEL_ID);
      const message = await channel.messages.fetch(todayMessageId);

      const postTime = new Date(message.createdTimestamp);
      postTime.setHours(postTime.getHours() + 9);

      const h = postTime.getHours();
      const m = ("0" + postTime.getMinutes()).slice(-2);
      postTimeStr = `${h}:${m}`;
    } catch (err) {
      console.error("投稿時刻の取得に失敗:", err);
      postTimeStr = "取得失敗";
    }

    // ===== A:J の行データ =====
    const row = [
      today,
      data.discordId,
      data.name,
      data.internalId,
      data.place,
      data.type,
      data.status,
      reactionTime,
      todayMessageId,
      postTimeStr
    ];

    await sheets.spreadsheets.values.append({
      auth: sheetsClient,
      spreadsheetId: process.env.SHEET_ID,
      range: "リアクションログ!A:J",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });

    console.log("ログ書き込み:", row);

  } catch (err) {
    console.error("writeReactionLog エラー:", err);
  }
}

// ===============================
// 締切判定
// ===============================
function isAfterDeadline() {
  if (!deadlineTime) return false;

  const now = new Date();
  const [h, m] = deadlineTime.split(":").map(Number);

  const deadline = new Date();
  deadline.setHours(h);
  deadline.setMinutes(m);
  deadline.setSeconds(0);
  deadline.setMilliseconds(0);

  return now > deadline;
}