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

// 匿名IDをどの頻度で切り替えるか。"daily"(毎日) か "weekly"(毎週)を選べる
const ID_ROTATION = process.env.ID_ROTATION || "daily";

// ---------------------------------------------
// 表記ゆれ対策: 全角/半角をそろえたり、判定しやすい形に変換する
// ---------------------------------------------
function normalizeText(text) {
  // NFKC正規化: 全角英数字を半角に、全角記号を半角に、など表記ゆれをそろえる
  return text.normalize("NFKC");
}

// ---------------------------------------------
// 現在の「期間キー」を作る。この値が変わると匿名IDも自動的に変わる
// 日本時間(JST)を基準に計算する
// ---------------------------------------------
function getPeriodKey(rotation) {
  // 日本時間に変換
  const jstString = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
  const jst = new Date(jstString);

  if (rotation === "weekly") {
    // 「その年の何週目か」を計算する(月曜始まり)
    const dayNum = (jst.getDay() + 6) % 7; // 月曜=0になるよう調整
    const thursday = new Date(jst);
    thursday.setDate(jst.getDate() - dayNum + 3);
    const yearStart = new Date(thursday.getFullYear(), 0, 1);
    const weekNumber = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
    return `${thursday.getFullYear()}-W${weekNumber}`;
  }

  // デフォルト: daily(日付が変わるとリセットされる)
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------
// 視聴者ごとに固定の短い匿名IDを作る関数
// 同じ人・同じ期間なら常に同じIDになるが、
// 期間(日付/週)が変わると自動的に別のIDに切り替わる
// 元のuser_idはハッシュ化されているので推測できない
// ---------------------------------------------
function getAnonId(viewerId) {
  const periodKey = getPeriodKey(ID_ROTATION);
  // viewerId(視聴者ID)と期間キーを混ぜてからハッシュ化する
  // → 同じ人でも期間が変わればIDが変わる、というのがポイント
  const hash = crypto
    .createHash("sha256")
    .update(`${viewerId}-${periodKey}`)
    .digest("hex");
  return hash.slice(0, 4).toUpperCase();
}


function checkComment(text, viewerId) {
  if (!text || text.trim().length === 0) {
    return "コメントが空です";
  }
  if (text.length > MAX_LENGTH) {
    return `${MAX_LENGTH}文字以内で入力してください`;
  }

  // 全角/半角などの表記ゆれをそろえてから判定する
  const normalized = normalizeText(text);

  for (const rule of NG_WORDS) {
    if (rule instanceof RegExp) {
      // 正規表現のルールの場合
      if (rule.test(normalized)) {
        return "不適切な表現が含まれています";
      }
    } else {
      // 通常の文字列(単語)のルールの場合
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

// ---------------------------------------------
// 匿名コメント専用の判定サービス(OpenAI Moderation API)を呼び出す関数。
// これはTwitch本体のAutoMod設定とは完全に無関係な、別のサービスなので、
// ここでどれだけ厳しく判定しても「通常のTwitchチャット」には一切影響しない。
// ヘイト・暴力・嫌がらせ・性的表現などのカテゴリで判定してくれる。
// ---------------------------------------------
async function checkModerationApi(text) {
  if (!OPENAI_API_KEY) {
    // キーが未設定の場合は判定をスキップする(単語リストのみで運用)
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
    // 判定サービス側でエラーが出ても、単語リストの判定は既に通っているので
    // 投稿自体は続行させる(一時的な不調でコメント機能を止めないため)
    console.warn("判定サービスエラー(スキップして続行):", await response.text());
    return true;
  }

  const result = await response.json();
  // flagged が true なら、不適切と判定されたコメント
  return result.results?.[0]?.flagged !== true;
}

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
    // 単語リストを通過したコメントを、さらに専用の判定サービスでも確認する
    // (これはTwitch本体には影響しないので、通常チャットは今まで通り)
    const passedModeration = await checkModerationApi(text);
    if (!passedModeration) {
      return res.status(400).json({ error: "不適切な表現が含まれています" });
    }

    // 「誰が送ったか」は分からないが、
    // 同じ人が送ったコメントかどうかは区別できるように、
    // 短い匿名IDを頭につけてから投稿する
    const anonId = getAnonId(viewerId);
    const anonMessage = `[匿名:${anonId}] ${text}`;

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
