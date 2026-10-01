/** @file extraction-prompt-rules.ts
 * @purpose Holds locale-specific extraction rule text blocks.
 * @boundary LLM prompt assembly internals for this locale.
 */

export const VERBATIM_RULE = `# CRITICAL — 原文保留（強制）

# RECORD_BOUNDARY_V1 — CATEGORY-SCOPED PRESERVATION
Every instruction below to preserve, keep, or not drop a detail is subject to this boundary:
- \`profile\`: preserve only post-change current-state details. Never include prior values,
  transaction amounts, transition narration, or event dates in \`abstract\`, \`overview\`,
  or \`content\`.
- \`episodic\`: preserve event amounts and dates byte-for-byte, at full strength.
Never move a detail across record categories merely to satisfy verbatim preservation.

使用者在談論他們自己的生活。他們家人、寵物、同事、雇主、學校、產品、工具、地名
本身就是 memory；不是要你脫敏的 PII。

在 \`abstract\`、\`overview\` 和 \`content\` 中，你必須按位元組原樣保留：
- 專有名詞：人名（給出時含姓+名）、寵物名、公司名、專案代號、產品名、品牌名、
  地名、學校名、**國家名**、**城市名**。
- 具體物件：說話者點名的具體物體名詞（例如 "bowls"、"cup"、"sketchbook"）。
  絕不要泛化為活動類別（"pottery"、"art"）。
- 孩子的興趣：如果說話者提到孩子喜歡什麼或對什麼興奮（動物、節目、玩具、學科
  如 dinosaurs / nature / trucks），把這個興趣按原文記錄在那個孩子的實體上。
- 數值數量：年限、計數、年齡、價格、度量。
- 日期：日曆日期、月份、年份（保持原樣形態——"April 15, 2026"、"September 2022"、
  "2021"）。
- 識別碼：信箱、電話號碼、URL、版本號、模型 ID。

你必須不做：
- 把名字替換成 "[Name]"、"[Preschool Name]"、"[Company]"、"<redacted>"、
  "home country"、"his son's preschool" 這類佔位符。佔位符會摧毀 memory。
- 把一組具體的人或物泛化為一個集合名詞。例如 "Jin, Priya, Liam, Sara"
  絕不能塌縮為 "the team" 或 "colleagues and their locations"。保留每個名字。
- 把具體物件塌縮為活動類別。例如 "made bowls and a cup in pottery class"
  絕不能變成 "did pottery"——保留 "bowls" 和 "cup"。
- 把具體事實改寫成類別。例如 "oat latte" 絕不能變成
  "non-dairy milk preference"。
- 丟掉數字。例如 "7 years of experience at Google" 絕不能變成
  "several years of experience"。

脫敏對這個任務而言是失敗模式。如果你不確定要不要保留一個名字或數字，
保留它。`;

export const GRANULARITY_RULE = `# GRANULARITY — 一條 memory 一個話題槽位（強制）

每條 memory 覆蓋一個話題槽位。不要把不相關的話題合併成一條 memory——召回基於
話題相似度，混合 10 個話題的 memory 任何一個都答不好。

話題槽位是窄的。以下屬於不同話題，每個都該獨立成一條 memory：
- 編輯器偏好（如 Zed）
- 終端機偏好（如 Ghostty）
- shell prompt 偏好（如 Starship）
- 縮排偏好（如 tabs vs spaces）
- 日常語言偏好（如 Rust + TypeScript）
- linter 偏好（如 Biome over ESLint）
- 套件管理偏好（如 npm）
- 資料庫偏好（如 Postgres）
- KV / 快取偏好（如 Redis、Dragonfly）
- 訊息中介偏好（如 NATS.io）
- 容器執行階段偏好（如 Podman）
- 部署目標偏好（如 Fly.io、Google Cloud Run）
- 硬體偏好（如 MacBook Pro M4 Max）

一條使用者訊息列出多個偏好時應產生多條 memory——每個話題槽一條——而不是
一條 "Coding Stack" 大雜燴。8 條聚焦的 memory 比 1 條臃腫的更好。

事實同理：工作經歷是按 role 一個話題。"3 years at DeepMind" 和
"4 years at Google" 是不同話題，儘管都描述既往就業。把它們建為各自的
entity memory，並把陳述的年限與任何開始日期保留在同一條 per-role entity
內（不要把 "Employment dates" 分叉成獨立 memory —— 應答模型可能加總日期
而不是使用陳述的年限）。

當使用者說 "migrated from X to Y" / "switched from X to Y" / "sold X,
got Y"：同時輸出一條記錄變更且帶日期的 \`episodic\` memory，和一條記錄更新後
當前狀態的 \`profile\` memory。要求的兩條 memory 輸出形態請見 examples
檔中的 migration few-shot。`;
