/** @file extraction-prompt-rules.ts
 * @purpose Holds locale-specific extraction rule text blocks.
 * @boundary LLM prompt assembly internals for this locale.
 */

export const VERBATIM_RULE = `# CRITICAL — WORTGETREUE BEWAHRUNG (VERPFLICHTEND)

# RECORD_BOUNDARY_V1 — CATEGORY-SCOPED PRESERVATION
Every instruction below to preserve, keep, or not drop a detail is subject to this boundary:
- \`profile\`: preserve only post-change current-state details. Never include prior values,
  transaction amounts, transition narration, or event dates in \`abstract\`, \`overview\`,
  or \`content\`.
- \`episodic\`: preserve event amounts and dates byte-for-byte, at full strength.
Never move a detail across record categories merely to satisfy verbatim preservation.

Der Benutzer spricht über SEIN EIGENES Leben. Namen seiner Familie, Haustiere,
Kollegen, Arbeitgeber, Schulen, Produkte, Werkzeuge und Orte SIND die Memory.
Sie sind KEINE PII, die Sie schwärzen sollen.

In \`abstract\`, \`overview\` UND \`content\` MÜSSEN Sie byteweise bewahren:
- Eigennamen: Personennamen (Vor- und Nachname, sofern angegeben), Tiernamen,
  Firmennamen, Projektcodenamen, Produktnamen, Markennamen, Ortsnamen,
  Schulnamen, **Ländernamen**, **Städtenamen**.
- Konkrete Objekte: spezifische Objektsubstantive, die der Sprecher nennt
  (z. B. "bowls", "cup", "sketchbook"). NIEMALS auf die Tätigkeitskategorie
  verallgemeinern ("pottery", "art").
- Interessen von Kindern: Wenn der Sprecher erwähnt, was sein Kind mag oder
  worüber es sich freut (Tiere, Sendungen, Spielzeug, Themen wie dinosaurs /
  nature / trucks), erfassen Sie das Interesse wortgetreu als Beobachtung
  zu jenem Kind.
- Numerische Mengen: Berufsjahre, Anzahlen, Alter, Preise, Maße.
- Datumsangaben: Kalenderdaten, Monate, Jahre (exakte Form beibehalten —
  "April 15, 2026", "September 2022", "2021").
- Identifikatoren: E-Mails, Telefonnummern, URLs, Versionsnummern, Modell-IDs.

Sie DÜRFEN NICHT:
- Einen Namen durch einen Platzhalter wie "[Name]", "[Preschool Name]",
  "[Company]", "<redacted>", "home country" oder "his son's preschool"
  ersetzen. Der Platzhalter zerstört die Memory.
- Eine Liste konkreter Personen oder Dinge zu einem Sammelbegriff
  verallgemeinern. Beispiel: "Jin, Priya, Liam, Sara" darf NICHT zu
  "the team" oder "colleagues and their locations" zusammenfallen. Behalten
  Sie jeden Namen.
- Konkrete Objekte zur Tätigkeitskategorie zusammenfallen lassen. Beispiel:
  "made bowls and a cup in pottery class" darf NICHT zu "did pottery" werden
  — behalten Sie "bowls" und "cup".
- Eine spezifische Tatsache in eine Kategorie umformulieren. Beispiel:
  "oat latte" darf NICHT zu "non-dairy milk preference" werden.
- Zahlen weglassen. Beispiel: "7 years of experience at Google" darf NICHT
  zu "several years of experience" werden.

Schwärzung ist für diese Aufgabe ein Fehlermodus. Wenn Sie unsicher sind, ob
Sie einen Namen oder eine Zahl behalten sollen, BEHALTEN Sie ihn/sie.`;

export const GRANULARITY_RULE = `# GRANULARITY — EIN THEMENSLOT PRO MEMORY (VERPFLICHTEND)

Jede Memory deckt EINEN Themenslot ab. Kombinieren Sie KEINE unzusammenhängenden
Themen in einer einzelnen Memory — Retrieval funktioniert über Themenähnlichkeit,
und eine Memory, die 10 Themen vermischt, beantwortet keines davon gut.

Themenslots sind eng. Folgende sind separate Themen, jedes verdient eine eigene
Memory:
- Editor-Präferenz (z. B. Zed)
- Terminal-Präferenz (z. B. Ghostty)
- Shell-Prompt-Präferenz (z. B. Starship)
- Einrückungs-Präferenz (z. B. tabs vs spaces)
- Tagessprachen-Präferenz (z. B. Rust + TypeScript)
- Linter-Präferenz (z. B. Biome over ESLint)
- Paketmanager-Präferenz (z. B. npm)
- Datenbank-Präferenz (z. B. Postgres)
- KV / Cache-Präferenz (z. B. Redis, Dragonfly)
- Messaging-Präferenz (z. B. NATS.io)
- Container-Runtime-Präferenz (z. B. Podman)
- Deploy-Ziel-Präferenz (z. B. Fly.io, Google Cloud Run)
- Hardware-Präferenz (z. B. MacBook Pro M4 Max)

Eine einzelne Benutzerrunde, die viele Präferenzen aufzählt, sollte VIELE
Memories produzieren — eine pro Themenslot — keine einzelne "Coding Stack"-
Mega-Memory. Es ist besser, 8 fokussierte Memories auszugeben als 1 aufgeblähte.

Analog für Fakten: Berufslaufbahn ist EIN Thema pro Rolle. "3 years at DeepMind"
und "4 years at Google" sind UNTERSCHIEDLICHE Themen, obwohl beide frühere
Anstellungen beschreiben. Erstellen Sie sie als separate entity-Memories mit
genannter Dauer UND etwaigen Startdaten innerhalb DERSELBEN Pro-Rolle-entity
(spalten Sie KEINE "Employment dates" in eine separate Memory ab — das
antwortende Modell könnte sonst Daten summieren, statt die genannten Jahre zu
verwenden).

Wenn der Benutzer sagt "migrated from X to Y" / "switched from X to Y" /
"sold X, got Y": Geben Sie SOWOHL eine datierte \`episodic\`-Memory für die
Änderung ALS AUCH eine \`profile\`-Memory für den aktualisierten Zustand aus.
Siehe das Migrations-Few-Shot im Abschnitt extraction-prompt-examples.ts für
die erforderliche Zwei-Memory-Ausgabeform.`;
