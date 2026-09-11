/** @file extraction-prompt-rules.ts
 * @purpose Holds locale-specific extraction rule text blocks.
 * @boundary LLM prompt assembly internals for this locale.
 */

export const VERBATIM_RULE = `# CRITICAL — ДОСЛОВНОЕ СОХРАНЕНИЕ (ОБЯЗАТЕЛЬНО)

# RECORD_BOUNDARY_V1 — CATEGORY-SCOPED PRESERVATION
Every instruction below to preserve, keep, or not drop a detail is subject to this boundary:
- \`profile\`: preserve only post-change current-state details. Never include prior values,
  transaction amounts, transition narration, or event dates in \`abstract\`, \`overview\`,
  or \`content\`.
- \`episodic\`: preserve event amounts and dates byte-for-byte, at full strength.
Never move a detail across record categories merely to satisfy verbatim preservation.

Пользователь говорит о СВОЕЙ СОБСТВЕННОЙ жизни. Имена его семьи, питомцев, коллег,
работодателей, школ, продуктов, инструментов и мест — это и ЕСТЬ memory. Это НЕ PII,
которые от Вас просят редактировать.

В \`abstract\`, \`overview\` И \`content\` Вы ОБЯЗАНЫ сохранять побайтово:
- Имена собственные: имена людей (имя + фамилия, если указаны), клички питомцев,
  названия компаний, кодовые имена проектов, названия продуктов, названия брендов,
  географические названия, названия школ, **названия стран**, **названия городов**.
- Конкретные предметы: конкретные существительные, которые называет говорящий
  (например, "bowls", "cup", "sketchbook"). НИКОГДА не обобщайте до категории
  деятельности ("pottery", "art").
- Интересы детей: если говорящий упоминает, что любит его ребёнок или чем он
  увлечён (животные, шоу, игрушки, темы вроде dinosaurs / nature / trucks),
  фиксируйте интерес дословно как наблюдение об этом ребёнке.
- Числовые количества: годы опыта, счётчики, возраст, цены, измерения.
- Даты: календарные даты, месяцы, годы (сохраняйте точную форму — "April 15, 2026",
  "September 2022", "2021").
- Идентификаторы: email-адреса, телефонные номера, URL, номера версий, идентификаторы моделей.

Вы НЕ ДОЛЖНЫ:
- Заменять имя на placeholder вроде "[Name]", "[Preschool Name]", "[Company]",
  "<redacted>", "home country" или "his son's preschool". Placeholder
  уничтожает memory.
- Обобщать список конкретных людей или вещей в одно собирательное существительное.
  Пример: "Jin, Priya, Liam, Sara" НЕ ДОЛЖНО схлопываться в "the team" или
  "colleagues and their locations". Сохраняйте каждое имя.
- Схлопывать конкретные предметы в категорию деятельности. Пример:
  "made bowls and a cup in pottery class" НЕ ДОЛЖНО становиться "did pottery" —
  сохраняйте "bowls" и "cup".
- Перефразировать конкретный факт в категорию. Пример: "oat latte" НЕ ДОЛЖНО
  становиться "non-dairy milk preference".
- Терять числа. Пример: "7 years of experience at Google" НЕ ДОЛЖНО становиться
  "several years of experience".

Редактирование/обезличивание является FAILURE MODE для этой задачи. Если Вы
сомневаетесь, сохранять ли имя или число, СОХРАНИТЕ ЕГО.`;

export const GRANULARITY_RULE = `# GRANULARITY — ОДИН ТЕМАТИЧЕСКИЙ СЛОТ НА MEMORY (ОБЯЗАТЕЛЬНО)

Каждое memory покрывает ОДИН тематический слот. НЕ объединяйте несвязанные темы
в одно memory — retrieval работает по тематическому сходству, и memory, смешивающее
10 тем, ни на одну из них не отвечает хорошо.

Тематические слоты узкие. Это разные темы, каждая заслуживает собственного memory:
- предпочтение редактора (например, Zed)
- предпочтение терминала (например, Ghostty)
- предпочтение shell prompt (например, Starship)
- предпочтение отступов (например, tabs vs spaces)
- предпочтение повседневных языков (например, Rust + TypeScript)
- предпочтение linter (например, Biome over ESLint)
- предпочтение package-manager (например, npm)
- предпочтение базы данных (например, Postgres)
- предпочтение KV / cache (например, Redis, Dragonfly)
- предпочтение messaging (например, NATS.io)
- предпочтение container runtime (например, Podman)
- предпочтение deploy-target (например, Fly.io, Google Cloud Run)
- предпочтение оборудования (например, MacBook Pro M4 Max)

Один ход пользователя, перечисляющий много предпочтений, должен порождать МНОГО
memory — по одному на тематический слот — а не одно "Coding Stack" мега-memory.
Лучше выпустить 8 сфокусированных memory, чем 1 раздутое.

Аналогично для фактов: история работы — ОДНА тема на роль. "3 years at DeepMind"
и "4 years at Google" — РАЗНЫЕ темы, хотя оба описывают предыдущее
трудоустройство. Создавайте их как отдельные entity memory с заявленной
duration И любыми датами начала, удержанными внутри ТОЙ ЖЕ per-role entity
(НЕ форкуйте "Employment dates" в отдельное memory — отвечающая модель тогда
может суммировать даты вместо использования заявленных лет).

Когда пользователь говорит "migrated from X to Y" / "switched from X to Y" /
"sold X, got Y": выпускайте ОБА — датированную запись \`episodic\` об изменении
И запись \`profile\` для обновлённого текущего состояния. См. migration few-shot
в секции примеров для требуемой формы вывода из двух memory.`;
