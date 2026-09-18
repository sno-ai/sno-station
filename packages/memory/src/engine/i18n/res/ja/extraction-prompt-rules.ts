/** @file extraction-prompt-rules.ts
 * @purpose Holds locale-specific extraction rule text blocks.
 * @boundary LLM prompt assembly internals for this locale.
 */

export const VERBATIM_RULE = `# CRITICAL — 原文保持（必須）

# RECORD_BOUNDARY_V1 — CATEGORY-SCOPED PRESERVATION
Every instruction below to preserve, keep, or not drop a detail is subject to this boundary:
- \`profile\`: preserve only post-change current-state details. Never include prior values,
  transaction amounts, transition narration, or event dates in \`abstract\`, \`overview\`,
  or \`content\`.
- \`episodic\`: preserve event amounts and dates byte-for-byte, at full strength.
Never move a detail across record categories merely to satisfy verbatim preservation.

ユーザーは自分自身の人生について話しています。家族、ペット、同僚、雇用主、学校、
製品、ツール、地名は memory そのものです。あなたが伏字化を求められている PII では
ありません。

\`abstract\`、\`overview\`、\`content\` のすべてにおいて、バイト単位で次を保持しなければなりません：
- 固有名詞：人名（姓と名が与えられている場合は両方）、ペット名、会社名、
  プロジェクトコードネーム、製品名、ブランド名、地名、学校名、
  **国名**、**都市名**。
- 具体的な物体：話者が名指しした具体的な物体名詞（例："bowls"、"cup"、
  "sketchbook"）。決して活動カテゴリ（"pottery"、"art"）に一般化しないこと。
- 子供の興味：話者が自分の子供が好きなものや夢中になっているもの（動物、番組、
  おもちゃ、dinosaurs / nature / trucks のような題材）に言及した場合、その興味を
  原文どおりにその子供に関する観察として記録すること。
- 数値量：経験年数、件数、年齢、価格、計測値。
- 日付：暦日、月、年（"April 15, 2026"、"September 2022"、"2021" の形式を
  そのまま保持）。
- 識別子：メールアドレス、電話番号、URL、バージョン番号、モデル ID。

次のことを行ってはいけません：
- 名前を "[Name]"、"[Preschool Name]"、"[Company]"、"<redacted>"、
  "home country"、"his son's preschool" のようなプレースホルダーで置き換える。
  プレースホルダーは memory を破壊します。
- 具体的な人物や物のリストを 1 つの集合名詞に一般化する。例："Jin, Priya, Liam, Sara"
  を "the team" や "colleagues and their locations" に潰してはいけません。
  すべての名前を保持してください。
- 具体的な物体を活動カテゴリに潰す。例："made bowls and a cup in pottery class"
  を "did pottery" にしてはいけません——"bowls" と "cup" を保持してください。
- 具体的な事実をカテゴリに言い換える。例："oat latte" を
  "non-dairy milk preference" にしてはいけません。
- 数字を落とす。例："7 years of experience at Google" を
  "several years of experience" にしてはいけません。

このタスクにおいて伏字化は失敗モードです。名前や数字を保持すべきか迷った場合は、
保持してください。`;

export const GRANULARITY_RULE = `# GRANULARITY — memory 1 件につきトピックスロット 1 つ（必須）

各 memory は 1 つのトピックスロットをカバーします。無関係なトピックを 1 つの
memory に結合してはいけません——検索はトピック類似度で動作し、10 個のトピックを
混ぜた memory はそのどれにもうまく答えられません。

トピックスロットは狭いものです。以下は別々のトピックであり、それぞれ独自の memory
を持つに値します：
- エディタ嗜好（例：Zed）
- ターミナル嗜好（例：Ghostty）
- shell prompt 嗜好（例：Starship）
- インデント嗜好（例：tabs vs spaces）
- 日常使用言語の嗜好（例：Rust + TypeScript）
- linter 嗜好（例：Biome over ESLint）
- パッケージマネージャ嗜好（例：npm）
- データベース嗜好（例：Postgres）
- KV / キャッシュ嗜好（例：Redis、Dragonfly）
- メッセージング嗜好（例：NATS.io）
- コンテナランタイム嗜好（例：Podman）
- デプロイ先嗜好（例：Fly.io、Google Cloud Run）
- ハードウェア嗜好（例：MacBook Pro M4 Max）

多くの嗜好を列挙する 1 つのユーザーターンは、複数の memory を生成すべきです——
トピックスロットごとに 1 つ——1 つの "Coding Stack" 巨大 memory ではありません。
1 つの肥大化した memory より 8 つの焦点を絞った memory の方が良いです。

事実も同様：職歴は role ごとに 1 つのトピックです。"3 years at DeepMind" と
"4 years at Google" は異なるトピックです、両方とも以前の雇用を記述していても。
それらを別々の entity memory として作成し、記述された duration AND 開始日は
SAME per-role entity の中に保持してください（"Employment dates" を別の memory に
フォークしないこと —— 応答モデルが記述された年数を使う代わりに日付を加算して
しまうかもしれません）。

ユーザーが "migrated from X to Y" / "switched from X to Y" / "sold X, got Y"
と述べる場合：変更を記録する日付付きの \`episodic\` memory と、更新後の現在状態を
記録する \`profile\` memory の両方を生成してください。必要な 2 memory の
出力形式は examples ファイルの migration few-shot を参照。`;
