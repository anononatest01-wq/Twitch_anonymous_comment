const fs = require("fs");
const path = require("path");

// ---------------------------------------------
// 手動で追加したい単語は、コードではなく
// wordlists/my_words.txt というテキストファイルに
// 1行1単語で書き足していくだけでOKです。
// (このファイルが無ければ自動で作成されます)
// ---------------------------------------------
const MY_WORDS_PATH = path.join(__dirname, "wordlists", "my_words.txt");

if (!fs.existsSync(MY_WORDS_PATH)) {
  fs.mkdirSync(path.dirname(MY_WORDS_PATH), { recursive: true });
  fs.writeFileSync(
    MY_WORDS_PATH,
    "# ここに1行1単語でNGワードを追加してください\n# 「#」で始まる行は無視されます\nクロンボ\n"
  );
}

// ---------------------------------------------
// 外部ファイルからワードリストを読み込む関数
// 1行に1単語の形式のテキストファイルを想定
// "#"で始まる行はコメントとして無視する
// ファイルが無ければ警告だけ出してスキップする(エラーで落ちない)
// ---------------------------------------------
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

// ---------------------------------------------
// 正規表現で使うと意味を持ってしまう記号(. * + ? など)を
// 「ただの文字」として扱うためのエスケープ処理
// ---------------------------------------------
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------
// 単純な単語(文字列)を、1文字ずつの間に記号や空白が
// 挟まっても検出できる「緩い正規表現」に自動変換する。
// 例: "ばか" → /ば\W*か/ になるので、"ば.か"や"ば か"も検出できる
// 2文字未満の単語は誤検出が多くなりすぎるのでそのままにする
// ---------------------------------------------
function toLooseRegex(word) {
  if (word.length < 2) return word; // 短すぎる単語は誤検出防止のため変換しない
  const chars = [...word].map(escapeRegExp);
  return new RegExp(chars.join("\\W*"));
}

// ---------------------------------------------
// 外部の実績あるリストを読み込む(任意)。
// 以下からダウンロードして wordlists/ フォルダに置けば読み込まれます(MITライセンス):
//   https://raw.githubusercontent.com/MosasoM/inappropriate-words-ja/master/Offensive.txt
//   https://raw.githubusercontent.com/MosasoM/inappropriate-words-ja/master/Sexual.txt
// ---------------------------------------------
const ALL_WORDS_RAW = [
  ...loadWordListFile("my_words.txt"),   // ← あなたが自由に追加していく分
  ...loadWordListFile("Offensive.txt"),  // 攻撃的/差別的表現(任意)
  ...loadWordListFile("Sexual.txt"),     // 性的表現(任意)
];

// 読み込んだ単語をすべて「緩い正規表現」に変換しておく
const WORD_RULES = ALL_WORDS_RAW.map(toLooseRegex);


// ---------------------------------------------
// 単語リストとは別に、パターンでまとめて弾きたいもの。
// Botアカウントが凍結されるリスクが高い「URL」「電話番号」「招待リンク」
// 「同じ文字の異常な連打(荒らし)」はここで一括対応する
// ---------------------------------------------
const PATTERN_RULES = [
  /https?:\/\/\S+/i,                         // URL全般(スパムリンク対策)
  /\S+\.(com|net|jp|tv|gg|me|io)\S*/i,       // http付けずに書かれたURLもある程度拾う
  /discord\.gg|line\.me|t\.me/i,             // 招待リンクの温床になりやすいサービス名
  /0\d{1,4}[-‐ー]?\d{1,4}[-‐ー]?\d{3,4}/,     // 電話番号らしき数字の並び
  /(.)\1{9,}/,                                // 同じ文字を10回以上連打(荒らし対策)
];

const NG_WORDS = [...WORD_RULES, ...PATTERN_RULES];

console.log(`[ngWords] 読み込み完了: 合計 ${NG_WORDS.length} 件のルール`);

module.exports = NG_WORDS;

