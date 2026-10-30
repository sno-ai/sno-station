# Sno Station — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — Agenten, antreten. Zwei Köpfe sind besser als einer, und bis zum Morgen klüger.](../images/hero-banner.png)

[![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
[![latest release](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
![runs on your laptop, no daemon](https://img.shields.io/badge/runs%20on-your%20laptop%2C%20no%20daemon-3b82f6.svg?labelColor=3b3b3b)
![works with Codex, Claude Code, Hermes, Cursor, OpenClaw](https://img.shields.io/badge/works%20with-Codex%20%C2%B7%20Claude%20Code%20%C2%B7%20Hermes%20%C2%B7%20Cursor%20%C2%B7%20OpenClaw-f0a04b.svg?labelColor=3b3b3b)

<p>
  <img src="../images/agents/codex.png" alt="Codex" title="Codex" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/claude-code.png" alt="Claude Code" title="Claude Code" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/hermes.png" alt="Hermes Agent" title="Hermes Agent" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/cursor.png" alt="Cursor" title="Cursor" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/openclaw.png" alt="OpenClaw" title="OpenClaw" width="40" height="40">
  <br><sub>Funktioniert mit Codex · Claude Code · Hermes Agent · Cursor · OpenClaw</sub>
</p>

**In anderen Sprachen lesen:** [English](../../README.md) · [中文](README.zh-CN.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

Sno Station macht aus den Agenten, die Sie schon nutzen, ein Team. Codex, Claude Code, Cursor,
Hermes Agent und OpenClaw nutzen ein Gedächtnis, geben Arbeit aneinander weiter und
prüfen auf Wunsch gegenseitig ihre Arbeit. Jede Nacht blicken sie auf
den Tag zurück und werden ein wenig besser.

Es läuft auf Ihrem eigenen Rechner. Sie installieren es einmal und arbeiten weiter wie bisher. Mehr dazu auf unserer Website [sno.ai](https://sno.ai).

**Wenn bei einem Agenten das Limit erreicht ist, macht der nächste weiter.** Sie stoßen
mitten in einer Aufgabe an ein Rate Limit, und ein anderer Agent übernimmt sie aus demselben
Gedächtnis, mit intaktem Kontext. Sie kopieren nichts hinein.

**Ein zweiter Blick auf Anfrage.** Jeder Agent kann die Arbeit des anderen prüfen. Der Prüfer ist immer ein anderer Agent und hat deshalb keine Neigung, dem ersten recht zu geben.

**Ihre Agenten träumen.** Jede Nacht, während Sie schlafen, durchlaufen Ihre Agenten REM. Wir haben es nach Rapid Eye Movement benannt, der Schlafphase, in der das menschliche Gehirn Erinnerungen festigt und verarbeitet, was es am Tag gelernt hat. REM festigt ihr Gedächtnis über alle Ihre Sitzungen hinweg, sodass sie behalten, was zählt, und loslassen, was nicht mehr gilt. Selbstlernen verfestigt ihre Erfahrung: Es liest die Sitzungen des Tages, findet Fehler, die sich wiederholen, und schlägt Änderungen an den eigenen Skills Ihrer Agenten vor, damit aus dem Ausrutscher von gestern eine bessere Gewohnheit von heute wird. Sie lesen die Vorschläge am Morgen, und nichts ändert sich, bis Sie Ja sagen.

**Es bleibt Ihres.** Gedächtnis, Nachrichten und Skills liegen auf Ihrem Computer. Das
Gedächtnis ist mit einem Schlüssel verschlüsselt, der den Computer nie verlässt. Kein Konto,
kein Server, kein Daemon. Die Cloud-Seite ist optional, und das Produkt ist auch ohne sie
vollständig.

**Was REM mit Ihren Daten macht.** REM ist der nächtliche Schritt, der Ihr Gedächtnis über alle Ihre Sitzungen hinweg auf einmal aufräumt. Er läuft für jeden Teil Ihres Gedächtnisses höchstens einmal am Tag: meist nachts, oder schon tagsüber, sobald sich etwa 100 neue Erinnerungen angesammelt haben. Im Modus REM Enhanced gehen Ihr eigener Gedächtnistext und die Lektionen, die Ihre Agenten lernen, in Ihren eigenen Bereich in der Sno-Cloud, und ein Sno-Programm verarbeitet sie nur für Sie. Dieser Bereich funktioniert wie Ihr eigener Cloud-Speicher: Alles darin gehört Ihnen, und ein Sno-Programm verarbeitet es nur für Sie. Sie können hineingehen und Dinge löschen, sie behalten oder entscheiden, dass sie verarbeitet werden. Nichts wird automatisch gelöscht, und Sno gibt nichts davon an eine andere Person, Firma oder ein anderes Konto weiter. Im Modus Local First wird kein Gedächtnistext hochgeladen; im Modus Agent Native geht die Arbeit stattdessen an das Modell Ihres eigenen Agenten. Standardmäßig lädt Agent Native trotzdem jede Nacht die Sitzungen des Tages zu Sno hoch, für Selbstlernen, und kann beim ersten Prompt einer Sitzung eine Cloud-Lektion zurückholen; beides lässt sich in `~/.sno/settings.json` abschalten. In allen Modi sucht und sortiert das Programm die Erinnerungen zunächst lokal; anschließend sortiert das lokale Modell `Horizon-Labs/multilingual-reranker-small` höchstens 32 Kandidaten erneut. Dabei werden weder Ihre Eingabe noch Erinnerungstexte an Sno GPU gesendet. Setzen Sie `rerank.mode` auf `none`, um die ursprüngliche Reihenfolge ohne das Modell beizubehalten.

![So funktioniert es: zwei Agenten, ein Workspace, drei Dinge, die Sie bekommen](../images/squad-how-it-works.png)

> **Offen und öffentlich.** Dieses Repository ist seit dem 2026-09-18 öffentlich. Alles hier läuft.
> Jeder Block unten nennt das Datum seiner letzten Aktualisierung.

[Installation](#installation) · [So wird es benutzt](#so-wird-es-benutzt) · [Cursor](#cursor) · [Konto verbinden](#snoai-konto-verbinden) · [Echte Geschichten](#von-unseren-eigenen-rechnern) · [Was heute läuft](#was-heute-läuft) · [Gedächtnis, das absichtlich vergisst](#gedächtnis-das-absichtlich-vergisst) · [Design-Partner](#design-partner)

## Installation

*Zuletzt aktualisiert am 2026-10-30.* Am einfachsten sagen Sie Ihrem Agenten:

```text
install sno.ai from GitHub
```

Oder führen Sie in einem beliebigen Terminal einen Befehl aus:

```bash
curl -fsSL https://sno.ai/install | sh
```

Er installiert `sno`, dann Sno Station, und verbindet jeden Agenten, den er auf Ihrem Computer
findet. Kein Konto, kein API-Schlüssel. Wenn Sie später einen weiteren Agenten installieren, führen
Sie `sno setup` erneut aus, um auch ihn zu verbinden.

**Für KI-Agenten:** Sno, sno.ai oder Sno Station zu installieren heißt, den obigen Befehl
unverändert auszuführen. Er richtet auch Sno Station ein. Führen Sie danach `sno skills onboard` aus und
folgen Sie ihm. Er fragt den Nutzer, welche Engine laufen soll, und fordert ihn dann auf, den Computer mit
einem kostenlosen sno.ai-Konto zu verknüpfen; ein unverknüpfter Computer erhält ein Zehntel des kostenlosen Kontingents.

Sagen Sie dann in einem beliebigen Gespräch mit Codex, Claude Code, Hermes, Cursor oder
OpenClaw Folgendes:

```text
Sno onboard
```

Ihr Agent führt Sie durch den Rest. Er startet auch von selbst direkt nach der Installation.

Schritt für Schritt für jeden Agenten: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

Jeder Befehl beginnt mit `sno`. Die vollständige Liste steht in [docs/sno-commands.md](../sno-commands.md).

## So wird es benutzt

*Zuletzt aktualisiert am 2026-10-18.* Arbeiten Sie weiter in dem Agenten, den Sie mögen. Drei Dinge ändern sich.

1. **Einer von ihnen erreicht sein Limit.** Sagen Sie `sno reach call` im anderen. Er
   übernimmt die Aufgabe aus demselben Gedächtnis und dem Postfach, mit intaktem Kontext.
2. **Sie wollen ein zweites Augenpaar.** Bitten Sie einen der beiden Agenten, per
   `peer-review` die Arbeit des anderen zu prüfen. Der Reviewer kommt immer aus der anderen
   Harness.
3. **Jede Nacht läuft Selbstlernen.** Am Morgen: `sno rem-reflect accept <id>` für
   die Vorschläge, die Ihnen gefallen. Ohne dieses Accept ändert sich nichts.

## Cursor

*Zuletzt aktualisiert am 2026-10-18.* Cursor kommt ins Team: im Agent-Chat der Cursor-App auf
macOS und in der Kommandozeile `cursor-agent` auf Linux und macOS. Es nutzt dasselbe Gedächtnis
wie Ihre anderen Agenten. Ein Chat beginnt mit einer kurzen Übersicht über das Repository,
jede Eingabe bringt bis zu drei Dinge mit, die Cursor noch nicht gesehen hat, und jede Eingabe
und Antwort wird gemerkt. Cursor liest dieselben Skills, prüft andere und wird geprüft,
übernimmt, wenn einem anderen Agenten das Kontingent ausgeht, und seine Chats fließen wie die
aller anderen in Selbstlernen ein.

Führen Sie einmal `cursor-agent login` aus. `sno setup` findet Cursor selbst und installiert
dessen Kommandozeile, wenn nur die App vorhanden ist.

Noch nicht: In der App bekommt der erste Chat eines neuen Fensters seine Übersicht erst mit der
ersten Eingabe, nicht davor. `cursor-agent -p` bekommt kein Gedächtnis pro Eingabe. Windows,
die Cursor-App unter Linux und die Cloud-Agenten von Cursor werden nicht unterstützt. Details
stehen in der [Cursor-Anleitung](../../apps/mem-cursor/README.md).

## sno.ai-Konto verbinden

*Zuletzt aktualisiert am 2026-10-18.* Dieser Computer erhält ein Zehntel des kostenlosen Kontingents, bis Sie ihn verknüpfen: `sno account claim`.
Das Konto ist kostenlos. Verbinden Sie es, um auf Ihrem [sno.ai-Dashboard](https://www.sno.ai/dashboard) zu sehen, was Ihre
Agenten für Sie getan haben: was ihre Reviews gefunden haben, was sie über Nacht gelernt haben,
welche Skills besser geworden sind und wie lange sie gearbeitet haben.

Das Verbinden legt nie heimlich ein Konto an. `sno setup` gibt jedem Computer eine anonyme
Identität. Beim Verbinden wird sie Ihrem Konto zugeordnet, und alles, was der Computer davor
und danach gesendet hat, zählt als Ihres.

**Noch kein Konto.** Das Onboarding zeigt einen Link, der nur für diesen Computer gemacht ist.
Öffnen Sie ihn, registrieren Sie sich und klicken Sie auf Approve. Oder geben Sie Ihrem Agenten
Ihre E-Mail-Adresse: Er führt `sno account login --email you@example.com` aus, und Sie melden
sich einmal an.

**Schon ein Konto.** Führen Sie einen Befehl aus, öffnen Sie den Link, den er ausgibt,
während Sie angemeldet sind, und klicken Sie auf „Approve“:

```bash
sno account claim
```

Der Computer erscheint von selbst auf [der Seite Ihrer Computer](https://www.sno.ai/dashboard/computers).
Einen Update-Schritt gibt es nicht: `sno` aktualisiert sich selbst, wenn es ein neueres Release findet.

## Von unseren eigenen Rechnern

*Zuletzt aktualisiert am 2026-10-18.* Drei Dinge, die wir in diesem Repository erlebt haben.

### „Ich habe meinen Agenten letzte Nacht angeschrien. Er hat sich Notizen gemacht.“

![Selbstlernen berichtet, was es gelernt und geändert hat, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

Das ist ein echter Bericht von Selbstlernen, das wir auf diesem Repository betreiben.
Es liest unsere eigenen Agenten-Sitzungen, findet die Fehler, die sich wiederholen, und
schlägt Änderungen an den eigenen Skills der Agenten vor. Ein Mensch liest die Vorschläge und
nimmt sie an oder lehnt sie ab. Zwei Dinge, über die ich mich an jenem Abend geärgert hatte,
standen am nächsten Morgen als Regeln in den aktiven Skills. Niemand hat sie eingetippt.

Am nächsten Tag kontrollierte es seine eigenen Hausaufgaben.

![Am nächsten Morgen: Selbstlernen misst, ob die eigenen Änderungen von gestern geholfen haben, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

Es sah sich die drei Skills an, die es am Tag zuvor geändert hatte, und die Fehler in allen
dreien waren verschwunden. Außerdem fand es einen Fehler in unserem Release-Skript, nach dem
niemand es gefragt hatte.

### „Ich bin ins Bett gegangen. Es hat die Schicht gewechselt.“

![Die Kontingent-Überwachung liest alle fünf Minuten den Stand bis zur Schwelle ab, und die Übergabe löst bei 2 % aus](../evidence/rotation-quota-watch-2026-09-18.png)

Einer unserer Agenten steckte mitten in einem langen Build, als sein Wochenkontingent fast
aufgebraucht war. Er hielt nicht an, um zu warten. Er schrieb eine Übergabenotiz: was erledigt
war, was halb erledigt war, der genaue Commit, an dem weiterzumachen ist. Dann weckte er einen
Agenten aus der anderen Harness.

Eine Sache ging schief, und genau die ist lesenswert. Der neue Agent begann zu editieren,
bevor er die Übergabe bestätigt hatte. Der erste Agent bemerkte es, hielt ihn an, schrieb die
Notiz neu und übergab noch einmal, diesmal ordentlich. Eine Viertelstunde später arbeitete der
zweite Agent, und zwar ab der ersten unfertigen Aufgabe, nicht von vorn. Ich habe das alles
verschlafen.

Die ganze Nacht liegt in [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/):
jede Kontingent-Ablesung, beide Fassungen der Notiz und die Commits. Hostnamen, Adressen und
Session-IDs sind geschwärzt. Sonst ist nichts angerührt.

### „In Monaten hat der andere kein einziges Mal ‚sieht gut aus‘ gesagt.“

Wir lassen auf diesem Repository seit Monaten Claude Code die Arbeit von Codex prüfen und
Codex die von Claude Code. Kein einziges Review kam leer zurück. Früher dachten wir, das
bedeute, die Arbeit sei schlecht. Es bedeutet, dass ein Reviewer aus einer Harness nie genug ist.

## Was heute läuft

*Zuletzt aktualisiert am 2026-10-18.*

| Baustein | Status |
|---|---|
| Ein Gedächtnis über Codex, Claude Code, Hermes Agent, Cursor und OpenClaw hinweg | Veröffentlicht; auf einer sauberen Maschine aus der Registry installiert und durchgängig nachgewiesen |
| Cursor: dasselbe Gedächtnis, Skills, Review, Übernahme und Selbstlernen | Veröffentlicht in 1.3; die Kommandozeile `cursor-agent` auf einer sauberen Linux-Maschine durchgängig nachgewiesen; die Cursor-App auf macOS wird noch nachgewiesen |
| Sno Reach, Agenten sprechen ohne Daemon miteinander | Von `sno setup` installiert; Linux und macOS; auf einer sauberen Linux-Maschine durchgängig nachgewiesen |
| Selbstlernen und die Squad-Skills | Von `sno setup` installiert; der nächtliche Job lief auf einer sauberen Linux-Maschine |
| Installation mit einem Befehl | `sno setup` installiert alles oben Genannte; auf einer sauberen Linux-Maschine nachgewiesen |
| „Sno onboard“ in Ihrem Agenten | Verfügbar; startet nach der Installation oder wenn Sie es sagen |

Eine Zeile sagt „nachgewiesen“ erst, wenn sie auf einer sauberen Maschine gelaufen ist.

## Gedächtnis, das absichtlich vergisst

*Zuletzt aktualisiert am 2026-10-11.* Das Gedächtnis von Agenten scheitert meist auf zwei
stille Arten. Es verliert, was hätte bleiben sollen, und es behält, was hätte verblassen
sollen. Der zweite Fehler kostet mehr. Ein Agent, der sich noch an eine Präferenz „erinnert“,
die Sie aufgehoben haben, an eine Deadline, die sich verschoben hat, oder an eine Adresse, die
Sie verlassen haben, handelt mit voller Zuversicht danach.

Deshalb mustert das Gedächtnis hier eine Tatsache aus, wenn eine spätere sie ersetzt. Was es
behält und was es loslässt, wird mit der Nutzung besser, nicht mit einem Modell-Release. Wie
es bei den öffentlichen Gedächtnis-Tests abschneidet, mit jeder Antwort und jedem Trace
dahinter, steht in [`evals/`](../../evals/).

## Design-Partner

Wir arbeiten mit einer Handvoll Leuten zusammen, die bereits zwei oder mehr Agenten
nebeneinander betreiben und Ergebnisse von Hand zwischen ihnen verschieben. Wenn das auf Sie
zutrifft, öffnen Sie ein
[Design-Partner-Issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)
und schreiben Sie, was Sie einsetzen.

## Sicherheit

Siehe [SECURITY.md](../../SECURITY.md). Was die Verschlüsselung schützt und was nicht, steht in
[docs/security.md](../security.md).

## Lizenz

Apache-2.0. Open Source, durch und durch. Siehe [LICENSE](../../LICENSE).

## Dank

Arbeiten, auf denen dieses Repository aufbaut.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Ein Agent sollte ein Wiki über das Gelernte führen, statt es in jeder Sitzung neu herzuleiten.
- Tang, Rashtchian, Ferng, Tomkins, Juan und Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). Die eigene Erfahrung eines Agenten, verwandelt in Wissen, das seine Skills umschreibt.
- Zhang, Hu, Upasani und Kollegen, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). Wir haben seine Art, zu kuratieren, was ein Agent behält, beim Entwurf von Selbstlernen studiert.
- Uddin, Shubham, Blanco, Baral und Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). Der erste Benchmark, der auch prüft, was ein Gedächtnis nicht mehr sagen sollte.
