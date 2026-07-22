// ---------------------------------------------
// 必要な部品を読み込む
// ---------------------------------------------
require("dotenv").config(); // .envファイルの中身を process.env に読み込む
const express = require("express");
const jwt = require("jsonwebtoken");   // JWT(Twitchが視聴者に発行する認証チケット)を検証する道具
const fetch = require("node-fetch");   // Twitchの公式APIを呼び出すための道具
const cors = require("cors");          // 拡張機能側(別ドメイン)からのアクセスを許可する
const crypto = require("crypto");      // 匿名IDを作るためのハッシュ計算に使う(Node.js標準機能)
const NG_WORDS = require("./ngWords");
 
const app = express();
app.use(cors());
app.use(express.json());
 
// public フォルダの中(video_overlay.htmlなど)を
// そのままブラウザから見えるようにする
// これで「フロントエンド用のサーバー」を別に立てなくてよくなる
app.use(express.static("public"));
 
// ---------------------------------------------
// 環境変数(.envファイルに書いた値)を読み込む
// ---------------------------------------------
const EXT_SECRET = process.env.EXT_SECRET;         // JWT検証用の鍵
const BOT_CLIENT_ID = process.env.BOT_CLIENT_ID;   // Botが使うアプリのClient ID
const BOT_ACCESS_TOKEN = process.env.BOT_ACCESS_TOKEN; // Botのアクセストークン
const BOT_USER_ID = process.env.BOT_USER_ID;       // BotアカウントのユーザーID
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // 匿名コメント専用の判定サービス用キー
// Botが投稿してよいチャンネルIDのリスト(カンマ区切り)。
// これを設定しておかないと、この拡張機能をインストールした
// 「他の誰かのチャンネル」にまでBotが勝手に投稿してしまう
const ALLOWED_CHANNEL_IDS = (process.env.ALLOWED_CHANNEL_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
const PORT = process.env.PORT || 3001;
 
// 設定値
const MAX_LENGTH = 60;
const COOLDOWN_MS = 5000;
const lastPostedAt = new Map();
 
// ---------------------------------------------
// JWTを検証するミドルウェア
// ---------------------------------------------
function verifyTwitchJwt(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "認証情報がありません" });
  }
 
  const token = authHeader.replace("Bearer ", "");
 
  try {
    const decoded = jwt.verify(token, Buffer.from(EXT_SECRET, "base64"), {
      algorithms: ["HS256"],
    });
    req.twitchAuth = decoded;
    next();
  } catch (err) {
    console.error("JWT検証エラー:", err.message);
    return res.status(401).json({ error: "認証に失敗しました" });
  }
}
 
const ID_ROTATION = process.env.ID_ROTATION || "daily";
 
function normalizeText(text) {
  const nfkc = text.normalize("NFKC");
  return nfkc.replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}
 
function getPeriodKey(rotation) {
  const jstString = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
  const jst = new Date(jstString);
 
  if (rotation === "weekly") {
    const dayNum = (jst.getDay() + 6) % 7;
    const thursday = new Date(jst);
    thursday.setDate(jst.getDate() - dayNum + 3);
    const yearStart = new Date(thursday.getFullYear(), 0, 1);
    const weekNumber = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
    return `${thursday.getFullYear()}-W${weekNumber}`;
  }
 
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
 
function getAnonId(viewerId) {
  const periodKey = getPeriodKey(ID_ROTATION);
  const hash = crypto
    .createHash("sha256")
    .update(`${viewerId}-${periodKey}`)
    .digest("base64");
  return hash.slice(0, 5);
}
 
function checkComment(text, viewerId) {
  if (!text || text.trim().length === 0) {
    return "コメントが空です";
  }
  if (text.length > MAX_LENGTH) {
    return `${MAX_LENGTH}文字以内で入力してください`;
  }
 
  const normalized = normalizeText(text);
 
  for (const rule of NG_WORDS) {
    if (rule instanceof RegExp) {
      if (rule.test(normalized)) {
        return "不適切な表現が含まれています";
      }
    } else {
      if (normalized.includes(rule)) {
        return "不適切な表現が含まれています";
      }
    }
  }
 
  const now = Date.now();
  const last = lastPostedAt.get(viewerId) || 0;
  if (now - last < COOLDOWN_MS) {
    return "連続投稿はできません。少し待ってください";
  }
  return null;
}
 
async function checkModerationApi(text) {
  if (!OPENAI_API_KEY) {
    return true;
  }
 
  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "omni-moderation-latest",
      input: text,
    }),
  });
 
  if (!response.ok) {
    console.warn("判定サービスエラー(スキップして続行):", await response.text());
    return true;
  }
 
  const result = await response.json();
  const flagged = result.results?.[0]?.flagged === true;
 
  if (flagged) {
    const categories = result.results[0].categories;
    const hitCategories = Object.keys(categories).filter((k) => categories[k]);
    console.log(`[OpenAI Moderation] ブロックしました。該当カテゴリ: ${hitCategories.join(", ")}`);
  } else {
    console.log("[OpenAI Moderation] 通過しました(問題なしと判定)");
  }
 
  return !flagged;
}
 
async function postToTwitchChat(broadcasterId, message) {
  const response = await fetch("https://api.twitch.tv/helix/chat/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${BOT_ACCESS_TOKEN}`,
      "Client-Id": BOT_CLIENT_ID,
    },
    body: JSON.stringify({
      broadcaster_id: broadcasterId,
      sender_id: BOT_USER_ID,
      message: message,
    }),
  });
 
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Twitch API エラー(${response.status}): ${errBody}`);
  }
 
  return response.json();
}
 
app.post("/comment", verifyTwitchJwt, async (req, res) => {
  const { text } = req.body;
  const viewerId = req.twitchAuth.opaque_user_id;
  const channelId = req.twitchAuth.channel_id;
 
  if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(channelId)) {
    console.warn(`[アクセス拒否] 許可されていないチャンネルからのリクエスト: channel_id=${channelId}`);
    return res.status(403).json({ error: "この拡張機能はこのチャンネルでは利用できません" });
  }
 
  const errorReason = checkComment(text, viewerId);
  if (errorReason) {
    return res.status(400).json({ error: errorReason });
  }
 
  try {
    const passedModeration = await checkModerationApi(text);
    if (!passedModeration) {
      return res.status(400).json({ error: "不適切な表現が含まれています" });
    }
 
    const anonId = getAnonId(viewerId);
    const anonMessage = `[${anonId}] ${text}`;
 
    await postToTwitchChat(channelId, anonMessage);
 
    lastPostedAt.set(viewerId, Date.now());
    res.json({ ok: true });
  } catch (err) {
    console.error("チャット投稿エラー:", err.message);
    res.status(500).json({ error: "投稿に失敗しました" });
  }
});
 
app.listen(PORT, () => {
  console.log(`EBS起動しました: http://localhost:${PORT}`);
});
