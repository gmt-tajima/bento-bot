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
// 許可リアクション（ここが重要）
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
// Discord 接続状態のログ（切断原因の特定用）
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
// Node.js 側のクラッシュ検知ログ
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
// 今日の投稿ID・締切情報を取得
// ===============================
async function initializeTodayMessage() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const client = await auth.getClient();

    const postLog = await sheets.spreadsheets.values.get({
      auth: client,
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

    const settings = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId: process.env.SHEET_ID,
      range: "設定!B1:B6"
    });

    const v = settings.data.values.map(r => r[0]);

    deadlineTime = v[2];
    deadlineCheck = v[4];

    console.log("締切時刻:", deadlineTime);
    console.log("締切チェック:", deadlineCheck);

  } catch (err) {
    console.error("initializeTodayMessage エラー:", err);
  }
}

// ===============================
// リアクション追加（注文）
// ===============================
async function handleReactionAdd(reaction, user) {
  try {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    // 今日の投稿以外は無視
    if (reaction.message.id !== todayMessageId) return;

    const emoji = reaction.emoji.name;

    // ============================
    // ★ 許可されていないリアクションは即削除
    // ============================
    if (!ALLOWED_REACTIONS.includes(emoji)) {
      await reaction.users.remove(user.id);
      return;
    }

    // ❌ はキャンセル扱いにしない（削除イベントで処理する）
    if (emoji === "❌") return;

    // 締切チェック
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

    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    if (reaction.message.id !== todayMessageId) return;

    const emoji = reaction.emoji.name;

    // ❌ の削除はキャンセル扱い
    if (emoji === "❌") {
      const member = await findMember(user.id);
      if (!member) return;

      await writeReactionLog({
        discordId: user.id,
        name: member.name,
        internalId: member.internalId,
        place: member.place,
        type: "❌",
        status: "キャンセル"
      });

      return;
    }

    // 🍱 🍚 の削除（通常キャンセル）
    if (emoji === "🍱" || emoji === "🍚") {

      if (deadlineCheck === "ON" && isAfterDeadline()) {
        await reaction.message.react(emoji);
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
    }

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
    const client = await auth.getClient();

    const res = await sheets.spreadsheets.values.get({
      auth: client,
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
// リアクションログ書き込み
// ===============================
async function writeReactionLog(data) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const client = await auth.getClient();

    const now = new Date();
    const time = now.toTimeString().slice(0, 5);
    const today = getTodayDateString();

    const row = [
      today,
      data.discordId,
      data.name,
      data.internalId,
      data.place,
      data.type,
      data.status,
      time,
      todayMessageId,
      deadlineTime
    ];

    await sheets.spreadsheets.values.append({
      auth: client,
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
