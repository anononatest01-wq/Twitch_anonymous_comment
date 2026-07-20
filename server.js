// ---------------------------------------------
// 必要な部品を読み込む
// ---------------------------------------------
require("dotenv").config(); // .envファイルの中身を process.env に読み込む
const express = require("express");
const jwt = require("jsonwebtoken");   // JWT(Twitchが視聴者に発行する認証チケット)を検証する道具
const fetch = require("node-fetch");   // Twitchの公式APIを呼び出すための道具
const cors = require("cors");          // 拡張機能側(別ドメイン)からのアクセスを許可する
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
const PORT = process.env.PORT || 3001;

// 設定値
const MAX_LENGTH = 60;
const COOLDOWN_MS = 5000;
const lastPostedAt = new Map();

// ---------------------------------------------
// JWTを検証するミドルウェア
// Twitchの拡張機能フロントエンドは、視聴者ごとに
// 「本物のTwitchが発行したJWT」をリクエストに付けてくる。
// これを鍵(EXT_SECRET)で検証することで、
// 「なりすましではなく本当にTwitchの拡張機能経由のリクエストか」を確認する
// ---------------------------------------------
function verifyTwitchJwt(req, res, next) {
  const authHeader = req.headers["authorization"]; // "Bearer xxxxx" の形で届く
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "認証情報がありません" });
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    // EXT_SECRETはbase64形式で発行されているので、Bufferに変換してから使う
    const decoded = jwt.verify(token, Buffer.from(EXT_SECRET, "base64"), {
      algorithms: ["HS256"],
    });

    // decoded の中に以下のような情報が入っている
    // decoded.channel_id      : この拡張機能が動いている配信チャンネルのID
    // decoded.opaque_user_id  : 視聴者を一意に識別するID(匿名扱いでも取得できる)
    req.twitchAuth = decoded;
    next();
  } catch (err) {
    console.error("JWT検証エラー:", err.message);
    return res.status(401).json({ error: "認証に失敗しました" });
  }
}

// ---------------------------------------------
// コメント内容のチェック
// ---------------------------------------------
function checkComment(text, viewerId) {
  if (!text || text.trim().length === 0) {
    return "コメントが空です";
  }
  if (text.length > MAX_LENGTH) {
    return `${MAX_LENGTH}文字以内で入力してください`;
  }
  for (const word of NG_WORDS) {
    if (text.includes(word)) {
      return "不適切な表現が含まれています";
    }
  }
  const now = Date.now();
  const last = lastPostedAt.get(viewerId) || 0;
  if (now - last < COOLDOWN_MS) {
    return "連続投稿はできません。少し待ってください";
  }
  return null;
}

// ---------------------------------------------
// Botとして実際にTwitchチャットへ投稿する関数
// Twitch公式のHelix API「Send Chat Message」を呼び出す
// ---------------------------------------------
async function postToTwitchChat(broadcasterId, message) {
  const response = await fetch("https://api.twitch.tv/helix/chat/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${BOT_ACCESS_TOKEN}`,
      "Client-Id": BOT_CLIENT_ID,
    },
    body: JSON.stringify({
      broadcaster_id: broadcasterId, // どのチャンネルに投稿するか
      sender_id: BOT_USER_ID,        // 誰として投稿するか(BotのユーザーID)
      message: message,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Twitch API エラー(${response.status}): ${errBody}`);
  }

  return response.json();
}

// ---------------------------------------------
// メインのエンドポイント
// フロントエンド(拡張機能オーバーレイ)からここに送られてくる
// ---------------------------------------------
app.post("/comment", verifyTwitchJwt, async (req, res) => {
  const { text } = req.body;
  const viewerId = req.twitchAuth.opaque_user_id;
  const channelId = req.twitchAuth.channel_id;

  const errorReason = checkComment(text, viewerId);
  if (errorReason) {
    return res.status(400).json({ error: errorReason });
  }

  try {
    // 匿名であることが伝わるように、接頭辞をつけてから投稿する
    // (誰が送ったかは分からないが、視聴者からのコメントだと分かるようにする)
    const anonMessage = `[匿名コメント] ${text}`;

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
