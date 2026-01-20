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
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction
  ]
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
// ★ 締切設定を毎回取得する関数
// ===============================
async function loadDeadlineSettings() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const sheetsClient = await auth.getClient();
  const sheetsApi = google.sheets({ version: "v4", auth: sheetsClient });

  const settingsSheet = await sheetsApi.spreadsheets.values.get({
    auth: sheetsClient,
    spreadsheetId: process.env.SHEET_ID,
    range: "設定!A1:B20"
  });

  const settingsRows = settingsSheet.data.values;

  function getSetting(name) {
    const row = settingsRows.find(r => r[0] === name);
    return row ? row[1] : null;
  }

  const fixedDeadline = getSetting("締切固定モード");
  const deadlineMode = getSetting("締切モード");
  const deadlineCheckSetting = getSetting("締切チェック");
  const optionalMinutes = getSetting("締切任意モード");

  let deadlineTime;

  if (deadlineMode === "固定") {
    deadlineTime = fixedDeadline;
  } else {
    const postTime = getSetting("投稿時間");
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

  return {
    deadlineTime,
    deadlineCheck: deadlineCheckSetting
  };
}

// ===============================
// ④ Bot 起動時
// ===============================
client.once("ready", () => {
  console.log(`Bot 起動: ${client.user.tag}`);
  initializeTodayMessage();
  fetchTodayMessageFromChannel();
});

// ===============================
// ★ 新しいメッセージが投稿された時の処理（修正版）
// ===============================
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot && (!message.embeds || message.embeds.length === 0)) return;
    if (!message.embeds || message.embeds.length === 0) return;

    const embed = message.embeds[0];
    const title = embed?.title || "";

    // GAS と同じ形式の今日の日付（yy年MM月dd日）
    const d = new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const MM = ("0" + (d.getMonth() + 1)).slice(-2);
    const dd = ("0" + d.getDate()).slice(-2);

    const todayKey = `${yy}年${MM}月${dd}日`;  
    // 例： "26年01月20日"

    // タイトルに今日の日付が含まれているか
    const isTodayPost = title.includes(todayKey);

    if (!isTodayPost) return;

    // 今日の投稿として認識
    todayMessageId = message.id;

    // 締切チェック
    if (deadlineCheck === "ON" && isAfterDeadline()) {
      await message.reply("⚠ 締切時間を過ぎているため、リアクション受付できません");
      return;
    }

    // 投稿ログに書き込み
    await writeTodayMessageIdToSheet(todayMessageId);

    // リアクション付与
    await message.react("🍱");
    await message.react("🍚");
    await message.react("❌");

  } catch (err) {
    console.error("messageCreate エラー:", err);
  }
});

// ===============================
// ⑤ リアクション追加（注文）
// ===============================
client.on("messageReactionAdd", async (reaction, user) => {
  console.log("REACTION target:", reaction.message.id, "TODAY:", todayMessageId);

  try {
    if (user.bot) return;
    if (reaction.message.id !== todayMessageId) return;

    if (reaction.partial) await reaction.fetch().catch(() => {});
    if (reaction.message.partial) await reaction.message.fetch().catch(() => {});

    // ★ 締切設定を毎回取得
    ({ deadlineCheck, deadlineTime } = await loadDeadlineSettings());

    if (deadlineCheck === "ON" && isAfterDeadline()) {
      await reaction.users.remove(user.id).catch(() => {});

      const msg = await reaction.message.reply({
        content: `<@${user.id}> ⚠ 締切時間を過ぎているため、注文は受付できません`,
        allowedMentions: { users: [user.id] }
      }).catch(() => {});

      setTimeout(() => {
        msg.delete().catch(() => {});
      }, 3000);

      return;
    }

    await handleReactionAdd(reaction, user);

  } catch (err) {
    console.error("messageReactionAdd エラー:", err);
  }
});

// ===============================
// ⑥ リアクション削除（キャンセル）
// ===============================
client.on("messageReactionRemove", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.message.id !== todayMessageId) return;

    if (reaction.partial) await reaction.fetch().catch(() => {});
    if (reaction.message.partial) await reaction.message.fetch().catch(() => {});

    // 締切チェックは不要（Add 側で済ませている）
    // Remove 側は「ユーザーが自分で外したときだけ」ログを残す

    await handleReactionRemove(reaction, user);

  } catch (err) {
    console.error("messageReactionRemove エラー:", err);
  }
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
// 今日の投稿IDを取得（締切設定はここでは取得しない）
// ===============================
async function initializeTodayMessage() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const sheetsClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: sheetsClient });

    // 投稿ログから今日の投稿IDを取得
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

    // ※ 締切設定の取得は loadDeadlineSettings() に完全移行済み

  } catch (err) {
    console.error("initializeTodayMessage エラー:", err);
  }
}

// ===============================
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

    const today = getTodayDateString();
    const [year, month, day] = today.split("/");

    const key1 = `${parseInt(year)}年${parseInt(month)}月${parseInt(day)}日`;
    const key2 = `${String(year).slice(-2)}年${month}${day}日`;
    const key3 = `${parseInt(month)}月${parseInt(day)}日`;

    const embed = latest.embeds[0];
    const title = embed?.title || "";

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
    const sheets = google.sheets({ version: "v4", auth: sheetsClient });

    const today = getTodayDateString();

    console.log("投稿ログ取得開始");

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
// リアクション追加の実処理（締切チェックなし）
// ===============================
async function handleReactionAdd(reaction, user) {
  try {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch().catch(() => {});
    if (reaction.message.partial) await reaction.message.fetch().catch(() => {});

    if (reaction.message.id !== todayMessageId) return;

    const emoji = reaction.emoji.name;

    if (!ALLOWED_REACTIONS.includes(emoji)) {
      await reaction.users.remove(user.id).catch(() => {});
      return;
    }

    if (emoji === "❌") return;

    const member = await findMember(user.id);
    if (!member) {
      await user.send("名簿に登録されていません。総務に連絡してください。").catch(() => {});
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
// リアクション削除の実処理（キャンセル）
// ===============================
async function handleReactionRemove(reaction, user) {
  try {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch().catch(() => {});
    if (reaction.message.partial) await reaction.message.fetch().catch(() => {});

    if (reaction.message.id !== todayMessageId) return;

    const emoji = reaction.emoji.name;

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
// リアクションログ書き込み（JST対応）
// ===============================
async function writeReactionLog(data) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const sheetsClient = await auth.getClient();

    const now = new Date();
    now.setHours(now.getHours() + 9);
    const reactionTime = now.toTimeString().slice(0, 5);

    const today = getTodayDateString();

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
  console.log("DEBUG deadlineTime:", deadlineTime);
  if (!deadlineTime) return false;

  let clean = deadlineTime;

  if (clean instanceof Date) {
    const h = clean.getHours().toString().padStart(2, "0");
    const m = clean.getMinutes().toString().padStart(2, "0");
    clean = `${h}:${m}`;
  }

  clean = String(clean).trim();

  const parts = clean.split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1]);

  if (isNaN(h) || isNaN(m)) {
    console.log("締切時刻のパースに失敗:", deadlineTime);
    return false;
  }

  const now = new Date();
  const deadline = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    h,
    m,
    0,
    0
  );

  // ★ デバッグログ
  console.log("DEBUG now:", now);
  console.log("DEBUG deadline:", deadline);
  console.log("DEBUG compare now > deadline:", now > deadline);

  return now > deadline;
}