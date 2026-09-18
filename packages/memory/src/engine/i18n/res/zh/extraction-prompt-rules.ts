/** @file extraction-prompt-rules.ts
 * @purpose Holds locale-specific extraction rule text blocks.
 * @boundary LLM prompt assembly internals for this locale.
 */

export const VERBATIM_RULE = `# CRITICAL — 原文保留（强制）

# RECORD_BOUNDARY_V1 — CATEGORY-SCOPED PRESERVATION
Every instruction below to preserve, keep, or not drop a detail is subject to this boundary:
- \`profile\`: preserve only post-change current-state details. Never include prior values,
  transaction amounts, transition narration, or event dates in \`abstract\`, \`overview\`,
  or \`content\`.
- \`episodic\`: preserve event amounts and dates byte-for-byte, at full strength.
Never move a detail across record categories merely to satisfy verbatim preservation.

用户在谈论他们自己的生活。他们家人、宠物、同事、雇主、学校、产品、工具、地名
本身就是 memory；不是要你脱敏的 PII。

在 \`abstract\`、\`overview\` 和 \`content\` 中，你必须按字节原样保留：
- 专有名词：人名（给出时含姓+名）、宠物名、公司名、项目代号、产品名、品牌名、
  地名、学校名、**国家名**、**城市名**。
- 具体物件：说话者点名的具体物体名词（例如 "bowls"、"cup"、"sketchbook"）。
  绝不要泛化为活动类别（"pottery"、"art"）。
- 孩子的兴趣：如果说话者提到孩子喜欢什么或对什么兴奋（动物、节目、玩具、学科
  如 dinosaurs / nature / trucks），把这个兴趣按原文记录在那个孩子的实体上。
- 数值数量：年限、计数、年龄、价格、度量。
- 日期：日历日期、月份、年份（保持原样形态——"April 15, 2026"、"September 2022"、
  "2021"）。
- 标识符：邮箱、电话号码、URL、版本号、模型 ID。

你必须不做：
- 把名字替换成 "[Name]"、"[Preschool Name]"、"[Company]"、"<redacted>"、
  "home country"、"his son's preschool" 这类占位符。占位符会摧毁 memory。
- 把一组具体的人或物泛化为一个集合名词。例如 "Jin, Priya, Liam, Sara"
  绝不能塌缩为 "the team" 或 "colleagues and their locations"。保留每个名字。
- 把具体物件塌缩为活动类别。例如 "made bowls and a cup in pottery class"
  绝不能变成 "did pottery"——保留 "bowls" 和 "cup"。
- 把具体事实改写成类别。例如 "oat latte" 绝不能变成
  "non-dairy milk preference"。
- 丢掉数字。例如 "7 years of experience at Google" 绝不能变成
  "several years of experience"。

脱敏对这个任务而言是失败模式。如果你不确定要不要保留一个名字或数字，
保留它。`;

export const GRANULARITY_RULE = `# GRANULARITY — 一条 memory 一个话题槽位（强制）

每条 memory 覆盖一个话题槽位。不要把不相关的话题合并成一条 memory——召回基于
话题相似度，混合 10 个话题的 memory 任何一个都答不好。

话题槽位是窄的。以下属于不同话题，每个都该独立成一条 memory：
- 编辑器偏好（如 Zed）
- 终端偏好（如 Ghostty）
- shell prompt 偏好（如 Starship）
- 缩进偏好（如 tabs vs spaces）
- 日常语言偏好（如 Rust + TypeScript）
- linter 偏好（如 Biome over ESLint）
- 包管理偏好（如 npm）
- 数据库偏好（如 Postgres）
- KV / 缓存偏好（如 Redis、Dragonfly）
- 消息中间件偏好（如 NATS.io）
- 容器运行时偏好（如 Podman）
- 部署目标偏好（如 Fly.io、Google Cloud Run）
- 硬件偏好（如 MacBook Pro M4 Max）

一条用户消息列出多个偏好时应产生多条 memory——每个话题槽一条——而不是
一条 "Coding Stack" 大杂烩。8 条聚焦的 memory 比 1 条臃肿的更好。

事实同理：工作经历按 role 是一个话题。"3 years at DeepMind" 与 "4 years at Google" 是不同话题，尽管都描述既往就业。把它们建为各自的 entity memory，并把任何开始日期保留在同一条 per-role entity 里（不要把 "Employment dates" 分叉成独立 memory —— 应答模型可能会加总日期而非使用陈述的年限）。

当用户说 "migrated from X to Y" / "switched from X to Y" / "sold X, got Y"：同时输出一条记录变更且带日期的 \`episodic\` memory，和一条记录更新后当前状态的 \`profile\` memory。要求的两条 memory 输出形态见示例文件中的 migration few-shot。`;
