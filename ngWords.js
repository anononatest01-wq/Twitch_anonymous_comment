const fs = require("fs");
const path = require("path");

// ---------------------------------------------
// 手動で追加したい単語は、コードではなく
// wordlists/my_words.txt というテキストファイルに
// 1行1単語で書き足していくだけでOKです。
// ---------------------------------------------
const MY_WORDS_PATH = path.join(__dirname, "wordlists", "my_words.txt");

if (!fs.existsSync(MY_WORDS_PATH)) {
  fs.mkdirSync(path.dirname(MY_WORDS_PATH), { recursive: true });
  fs.writeFileSync(
    MY_WORDS_PATH,
    "# ここに1行1単語でNGワードを追加してください\n# 「#」で始まる行は無視されます\nクロンボ\n"
  );
}

function loadWordListFile(filename) {
  const filePath = path.join(__dirname, "wordlists", filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`[ngWords] ${filename} が見つかりません。スキップします。`);
    return [];
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// server.js側のnormalizeTextと揃えるため、ここでもひらがな→カタカナ変換を行う。
// これをやらないと「ひらがなで書いたNGワード」が一切マッチしなくなってしまう
// (入力側は常にカタカナへ正規化されるため)。
function toKatakana(word) {
  return word.replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

// 「文字の間に挟まってもOK」とみなす範囲を、
// 「ひらがな・カタカナ・漢字ではない文字すべて」と定義する。
// こうすることで、×や◯のような記号は挟まってもOK(スキップ対象)としつつ、
// 別の日本語の文字が挟まった場合は別物として扱う(誤爆防止)、を両立できる。
const SEPARATOR = "[^\\u3041-\\u30FF\\u4E00-\\u9FFF]*";

function toLooseRegex(word) {
  const normalized = toKatakana(word);
  if (normalized.length < 2) return normalized;
  const chars = [...normalized].map(escapeRegExp);
  return new RegExp(chars.join(SEPARATOR));
}

const ALL_WORDS_RAW = [
  ...loadWordListFile("my_words.txt"),           // ← あなたが自由に追加していく分
  ...loadWordListFile("my_words_from_wiki.txt"), // ← 整形済みの外部リスト(ゲームNGワード由来・漢字)
  ...loadWordListFile("my_words_hiragana.txt"),  // ← 上記の漢字を手作業でひらがな化したもの
  ...loadWordListFile("Offensive.txt"),          // 攻撃的/差別的表現(任意)
  ...loadWordListFile("Sexual.txt"),             // 性的表現(任意)
];

const WORD_RULES = ALL_WORDS_RAW.map(toLooseRegex);

const PATTERN_RULES = [
  /https?:\/\/\S+/i,
  /\S+\.(com|net|jp|tv|gg|me|io)\S*/i,
  /discord\.gg|line\.me|t\.me/i,
  /0\d{1,4}[-‐ー]?\d{1,4}[-‐ー]?\d{3,4}/,
  /(.)\1{9,}/,
];

const NG_WORDS = [...WORD_RULES, ...PATTERN_RULES];

console.log(`[ngWords] 読み込み完了: 合計 ${NG_WORDS.length} 件のルール`);

module.exports = NG_WORDS;
