# Sno Station: Eine Person. Ein ganzes Engineering-Team aus KI-Agenten.

**Sno Station ist die Workstation für Ihre KI-Coding-Agenten.** Claude Code, Codex und Cursor laufen jeweils in ihrer eigenen Harness. In Sno Station sitzen diese Harnesses nebeneinander und arbeiten als ein Team. Kein weiterer Agent, kein weiteres Modell: Es lässt die laufen, die Sie schon nutzen.

Fangen Sie mit Arbeit an, die Sie sonst beaufsichtigen müssten. Ein Agent baut, ein anderer prüft, und die beiden klären die Befunde, bevor das Ergebnis bei Ihnen ankommt. Stößt einer an sein Nutzungslimit, übernimmt der andere die Aufgabe. Was Sie heute korrigieren, steht morgen als Regel in ihren Skills.

So bekommen Sie es. Sagen Sie Ihrem Agenten:

```text
install sno.ai from GitHub
```

Ihr Agent installiert es, verbindet jeden Agenten, den er auf Ihrem Computer findet, und stellt Ihnen zwei kurze Fragen. Geben Sie dann zwei Agenten ihre erste Aufgabe:

```bash
sno reach pair "Fix the login redirect"
```

Einer baut, der andere hält dagegen, und Sie können beiden zusehen. Es läuft auf Ihrem eigenen Computer mit Claude Code, Codex, Cursor, Hermes Agent und OpenClaw. Kein API-Schlüssel. Open Source. [Lieber ein einziger Terminal-Befehl?](#install)

[![GitHub-Sterne](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![Neuestes Release](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![Lizenz Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)

**In anderen Sprachen lesen:** [English](../../README.md) · [中文](README.zh-CN.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

## Geben Sie die Arbeit heute Abend ab. Morgen früh gibt es Ergebnisse statt drei Rückfragen.

Drei Dinge, die uns passiert sind, bevor wir das hier gebaut haben:

- Ein Agent hielt an, um eine Frage zu stellen, die er nie hätte stellen müssen. Sieben Stunden später kamen wir zurück, und nichts hatte sich bewegt.
- Ein Agent legte uns fünfzehn kleine Fragen vor. Dreißig Minuten unserer Aufmerksamkeit später stellte sich heraus: Er hätte jede davon selbst beantworten können.
- Ein Agent wollte mitten in der Nacht einen anderen wecken und konnte es nicht. Beide saßen bis zum Morgen da.

Ihre Agenten sind schnell. Langsam ist das Warten: auf Sie, auf das Zurücksetzen eines Nutzungslimits, auf jemanden, der ein Ergebnis ins nächste Fenster trägt. Deshalb ist die ganze Workstation um eine Regel herum gebaut: **Die Arbeit hört nicht auf, nur weil ein Agent aufgehört hat.**

- **Ein Nutzungslimit ist kein Stoppschild.** Ein anderer Agent macht am exakten Commit weiter.
- **Der Autor hat nicht das letzte Wort.** Ein anderer Agent prüft, in einer Sitzung, die das Gespräch nie gesehen hat.
- **„Fertig“ zählt nichts.** Jedes Erfolgskriterium wird durch einen echten Lauf beantwortet.
- **Sie kommen zu einer einzigen Seite zurück.** Was erledigt ist, was festhängt, was auf Ihre Antwort wartet.

**Es liefert. Sie shippen.**

**Geben Sie jetzt einen Stern. Wenn das nächste Mal um 2 Uhr nachts ein Agent hängen bleibt, wollen Sie wissen, wo das hier war.**

Es folgen drei Wege, es zu nutzen: mit einem Befehl einen Agenten zum Bauen und einen zum Prüfen starten, das ganze Team über einen einzigen Agenten führen, und heute Abend eine Lektion freigeben, die schon in der nächsten Antwort wirkt. Zu jedem gibt es etwas, das wir auf unseren eigenen Rechnern gesehen haben.

<a id="new-in-20-tag-team"></a>

## Ich ging ins Bett. Sie machten Schichtwechsel und stritten dann über den Code.

```bash
sno reach pair "Fix the login redirect"
```

Ein Agent baut. Der andere nimmt das Ergebnis in die Zange. Die Befunde klären die beiden unter sich, und so kommt die Arbeit bei Ihnen an, wenn der Streit schon ausgefochten ist. Beide laufen in tmux-Fenstern, die Sie öffnen und beobachten können. Sind zwei verschiedene Agenten angemeldet, bekommen Sie von jedem einen. Ist es nur einer, bekommen Sie das Paar trotzdem, in zwei getrennten Sitzungen, und der Befehl sagt Ihnen, dass die Prüfung in derselben Familie geblieben ist.

**Ist einer am Ende, stempelt der andere ein.** Sagen Sie dem arbeitenden Agenten bei einem langen Lauf, er soll `rotate-agent` nutzen. Bei 2 % seines Kontingents schreibt er eine Übergabe und weckt einen anderen Agenten, der am exakten Commit weitermacht. Und wenn der Kontext eines Agenten voll ist und komprimiert wird, weiß er immer noch, woran er war und was schon gescheitert ist.

**Der andere sieht, was der erste nicht sehen kann.** Bitten Sie einen der beiden Agenten um ein `peer-review` der Arbeit des anderen. Der Reviewer arbeitet immer in einer frischen Sitzung, die das Gespräch nie gesehen hat, und er ist ein anderer Agent, sobald Sie zwei haben. Ein Review findet nicht immer ein Problem. Es findet aber immer wieder die, die der Autor nicht sehen konnte. Denn ein Agent, der sich selbst prüft, bringt dieselben Gewohnheiten mit, mit denen er den Code geschrieben hat.

Was wir gesehen haben, in der Nacht des 2026-09-18:

![Die Kontingent-Überwachung liest alle fünf Minuten den Stand bis zur Schwelle ab, und die Übergabe löst bei 2 % aus](../evidence/rotation-quota-watch-2026-09-18.png)

Einer unserer Agenten steckte mitten in einem langen Build, als sein Wochenkontingent fast
aufgebraucht war. Er hielt nicht an, um zu warten. Er schrieb eine Übergabenotiz: was erledigt
war, was halb erledigt war, der exakte Commit, an dem weiterzumachen ist. Dann weckte er einen
anderen Agenten.

Eine Sache ging schief, und genau die ist lesenswert. Der neue Agent begann zu editieren,
bevor er die Übergabe bestätigt hatte. Der erste Agent bemerkte es, hielt ihn an, schrieb die
Notiz neu und übergab noch einmal, diesmal ordentlich. Eine Viertelstunde später arbeitete der
zweite Agent, und zwar ab der ersten unfertigen Aufgabe, nicht von vorn. Ich habe das alles
verschlafen.

Die ganze Nacht liegt in [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/):
jede Kontingent-Ablesung, beide Fassungen der Notiz und die Commits. Entfernt sind nur
identifizierende Angaben und Zeilen mit Zugangsdaten, und das README des Ordners führt jede
einzelne auf. Die Zeiten, die Fehler und die Korrekturen stehen da, wie sie passiert sind.

## Wir reden mit einem Agenten. Den Rest führt er.

Fünf Agenten zu betreiben hieß früher: fünf Terminals, und wir mittendrin, um weiterzutragen, was der eine dem nächsten gesagt hat. Diesen Job gibt es nicht mehr.

Sagen Sie `/cos` in Claude Code oder `$cos` in Codex. Dieser Agent wird Ihr Stabschef, der einzige, mit dem Sie zu tun haben. Er eröffnet für jedes Projekt einen leitenden Agenten, die Leads geben die Arbeit nach unten weiter, und zu Ihnen kommt nur zurück, was Ihre Entscheidung braucht. Auch der Chef wird kontrolliert: Nach einer Nachtschicht geht er die Freigaben noch einmal durch, die sich die Projektleads selbst erteilt haben, und ein Führungsfehler, der sich wiederholt, wird zur Regel für alle. Sno Station installiert die Skills, die dieses Delegieren, Prüfen und Lernen steuern, und jede Anweisung können Sie in [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders) nachlesen.

**Schluss mit dem Starren auf Terminals.** Mit oder ohne Stabschef: Ihre Statuszeile in Claude Code oder Cursor sagt Ihnen, wenn jemand Sie braucht. Die Installation richtet sie ein:

```text
❄ 2 need you · claude: approve
```

`sno squad` breitet das ganze Team im Vollbild vor Ihnen aus: wer Sie braucht, wer arbeitet, was fertig ist.

```text
Sno Station · squad · 09:15 · 2 need you · 2 working · 2 finished
Needs you (2)
> claude web-app       approve a permission · Fix the login redirect loop …   1m
  codex api            asked a question · Migrate the billing tables to th…   5m
Working (2)
  claude docs-site     Rewrite the quick-start page for the 2.0 install      12s
  codex api            Review the rate limiter change from the web-app age…  40s
Finished (2)
  cursor infra         finished · result unseen · Rotate the staging certi…  25m
  claude web-app       finished · Bump the UI kit to 4.2                      2h
```

**Schluss mit dem Botendienst.** Agenten schicken einander Aufgaben und Review-Anfragen direkt. Der vollständige Text landet zuerst im Postfach des anderen Agenten. Wenn Sie gerade in diesem Fenster tippen oder der Agent seinen Kontext komprimiert, wartet die Nachricht dort, und Ihr halb geschriebener Entwurf bleibt, wie Sie ihn gelassen haben.

## Ich habe meinen Agenten gestern Abend angeschrien. Er hat sich Notizen gemacht.

Ab Werk geht jeder Agent mit denselben Anweisungen an alle raus. Für Ihre wird jede Nacht eine Überarbeitung vorgeschlagen, zugeschnitten auf Ihre Arbeitsweise. Sie entscheiden, was bleibt.

Sie korrigieren heute einen Agenten. Heute Nacht liest Self Learning die Sitzungen des Tages von allen Ihren Agenten, findet die Fehler, die sich wiederholen, und schlägt Änderungen an den eigenen Skills der Agenten vor. Fragen Sie Ihren Agenten am Morgen, was Self Learning vorgeschlagen hat. Er listet jeden Vorschlag mit seiner ID auf, und Sie geben die frei, die Sie wollen:

```bash
sno rem-reflect accept <id>
```

Ohne dieses Accept ändert sich nichts. In Claude Code und Codex gilt eine angenommene Lektion ab der nächsten Antwort. Nicht ab der nächsten Sitzung. Ab der nächsten Antwort.

Was wir gesehen haben, am 2026-09-18 und am Morgen danach:

![Self Learning berichtet, was es gelernt und geändert hat, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

Das ist ein echter Bericht von Self Learning, das wir auf diesem Repository betreiben. Ein Mensch
liest die Vorschläge und nimmt sie an oder lehnt sie ab. Zwei Dinge, über die ich mich an jenem
Abend geärgert hatte, standen am nächsten Morgen als Regeln in den aktiven Skills. Niemand hat
sie eingetippt.

Am nächsten Tag kontrollierte es seine eigenen Hausaufgaben.

![Am nächsten Morgen: Self Learning misst, ob die eigenen Änderungen von gestern geholfen haben, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

Es sah sich die drei Skills an, die es am Tag zuvor geändert hatte. Die zwei, die seitdem
wieder benutzt worden waren, zeigten keine Fehler, und der dritte war noch nicht benutzt worden.
Außerdem fand es einen Fehler in unserem Release-Skript, nach dem niemand es gefragt hatte.

## Die Workstation, in der Ihre KI-Agenten zum Team werden, das sich selbst führt und jede Nacht besser wird

Alles von oben, je eine Zeile. Nichts davon müssen Sie vorher lernen.

| Was Sie bekommen | Die eine Zeile, die es Ihnen bringt |
|---|---|
| **Ein Nutzungslimit ist kein Stoppschild.** Bevor sein Kontingent aufgebraucht ist, schreibt der arbeitende Agent eine Übergabe mit der unfertigen Arbeit und dem exakten Commit, und ein anderer Agent macht von dort weiter. | Sagen Sie dem arbeitenden Agenten: `use rotate-agent` |
| **Der Autor hat nicht das letzte Wort.** Die Arbeit geht an einen anderen Agenten, in einer frischen Sitzung, die das Gespräch nie gesehen hat. | `sno reach pair "the task"`, oder sagen Sie einem Agenten: `peer-review this` |
| **„Fertig“ zählt nichts.** Die Aufgabe bringt Prüfungen mit, die bestanden oder nicht bestanden sind, und jede wird durch einen echten Lauf beantwortet. | Sagen Sie Ihrem Agenten: `write a charter for this`, dann lassen Sie es mit `/deliver` ausführen |
| **Eine Seite, wenn Sie zurückkommen.** Was erledigt ist, was festhängt, was auf Ihre Antwort wartet. | `sno away-brief run` |
| **Ein Absturz oder ein geschlossenes Fenster ist nicht das Ende.** Die Aufgabe kommt im selben Gespräch zurück oder in einem neuen, das aus der gespeicherten Übergabenotiz entsteht, und Sie erfahren, was davon zutrifft: fortgesetzt, neu aufgebaut oder verloren. | Nichts auszuführen. Nach der Installation ist es an |
| **Niemand erklärt das Projekt zweimal.** Ihre Agenten teilen sich ein Gedächtnis, und eine Tatsache wird ausgemustert, wenn eine neuere sie ersetzt. | Nichts auszuführen. Nach der Installation ist es an |

Sagen Sie Ihrem Agenten:

```text
install sno.ai from GitHub
```

**Und geben Sie diesem Repository einen Stern.** Wir bauen Sno Station mit Sno Station. Was unsere eigenen Nachtschichten uns lehren, landet hier, Release für Release. Welche Teile heute auf welchem Agenten laufen, steht unter [Was Sie heute nutzen können](#what-runs-today).

---

> **Offen und öffentlich.** Dieses Repository ist seit dem 2026-09-18 öffentlich. Alles hier läuft.
> Jeder Block unten nennt das Datum seiner letzten Aktualisierung.

[Was wir gelernt haben](#what-we-learned) · [Installation](#install) · [Editoren](#editors) · [Ihr Konto](#account) · [Was heute läuft](#what-runs-today) · [Gedächtnis, das absichtlich vergisst](#memory)

<a id="what-we-learned"></a>

## Alles, was wir im Rund-um-die-Uhr-Betrieb mit KI-Agenten gelernt haben. In einer Installation.

*Zuletzt aktualisiert am 2026-10-23.* Jede Zeile in der linken Spalte ist eine echte Beschwerde aus r/ClaudeCode, r/codex oder r/ClaudeAI aus der Woche vom 20. Oktober 2026. In der rechten Spalte steht, was auf unseren eigenen Rechnern läuft, kostenlos und Open Source, damit das aufhört.

| Was die Leute diese Woche gesagt haben | Was es behebt | Wo |
|---|---|---|
| “Ran out of my 5-hour limit within 30 minutes.” | Schicken Sie nicht mehr das größte Modell für alles los. Ein Agent plant und prüft; der andere schreibt den Code und wird als Agent aus derselben Sitzung aufgerufen. Ist ein Abo leer, übernimmt das andere die Aufgabe aus demselben Gedächtnis. | `codex-coder`, `sno reach call` |
| “Lost 10 hours of overnight work to ‘this model is at capacity’.” | Bei 2 % seines Kontingents schreibt der arbeitende Agent eine Übergabenotiz und weckt den Agenten des anderen Anbieters, der am exakten Commit weitermacht. Sie haben geschlafen. | `rotate-agent` |
| “1,100 files, 30,000 lines. I don't have the token budget to review their PRs.” | Wer pusht, lässt zuerst prüfen: Der Autor startet ein Review durch den anderen Anbieter, in einer frischen Sitzung, die das Gespräch nie gesehen hat, und behebt, was zurückkommt, bevor jemand anderes draufschaut. | `peer-review` |
| “A reviewer subagent checked every commit for two weeks. 86 runs, it stopped exactly one.” | Eine Harness, die sich selbst prüft, findet nichts Echtes. Der Reviewer ist immer ein anderes Modell in einer anderen Harness und kennt nichts vom Chat des Autors. | `peer-review` |
| “Codex never finishes a review.” | Harte Obergrenzen, direkt im Skill festgeschrieben: 3 Runden für Code, 5 für einen Plan, 1 für Tests, dann stoppt er und wartet auf einen Menschen. Ein Lauf, der 15 Minuten lang nichts geschrieben hat, gilt als hängen geblieben und wird beendet. | `peer-review`, `codex-coder`, `heartbeat` |
| “Codex treats every byte like a criminal.” | Spekulative Schutzmaßnahmen, Sperren und Hashes sind das Erste, was das Review löscht. Nichts kommt hinein, ohne dass ein beobachteter Fehler es verlangt. | `less-is-more` |
| “When Claude says it won't change something, is that reason stored anywhere Codex reads next time?” | Jeder Befund wird genau einmal erfasst, mit einem Status, den nur ein Mensch setzt. Taucht ein Befund erneut auf, wird seine Zeile aktualisiert, statt dass er als neu zurückkommt, und frühere Entscheidungen gehen an das nächste Review. | Befundregister von `peer-review` |
| “It said done. Nothing happened.” | Eine Aufgabe hat eine schriftliche Liste von Erfolgskriterien, und jedes wird durch einen echten Lauf mit bestanden oder nicht bestanden beantwortet. Sagt ein Agent „fertig“, zählt das nichts. | Arbeitsaufträge von `pl` |
| “Tomorrow it makes the same mistake it made today.” | Jede Nacht liest ein separates Modell die Sitzungen des Tages und macht aus Ihren Korrekturen einzeilige Lektionen, und Sie geben frei, was bleibt. Der Engpass sind wir. | Self Learning (Skills `R`) |
| “Half my subagents were glorified one-liners with a fresh context window.” | Abläufe gehören in Skills, nicht in Subagenten. Zwei Agenten bleiben: für Planung und Ausführung und für das Review, denn genau diese beiden Aufteilungen zahlen sich aus. | das ganze Set |

Die Gewohnheiten in der rechten Spalte sind Skills. Sno Station installiert sie in Claude Code und Codex, gepflegt werden sie in [sno-station-skills](https://github.com/sno-ai/sno-station-skills). Das Gedächtnis, die Übergabe und das nächtliche Träumen, auf die sie sich stützen, sind dieses Repository.

<a id="install"></a>

## Installation: eine Zeile, dann zwei Wörter

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

Bei der Installation über Ihren Agenten startet das Onboarding von selbst. Haben Sie im Terminal installiert, sagen Sie in einem beliebigen Gespräch mit Codex, Claude Code, Hermes, Cursor oder OpenClaw Folgendes:

```text
Sno onboard
```

Ihr Agent führt Sie durch den Rest.

Schritt für Schritt für jeden Agenten: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

Jeder Befehl beginnt mit `sno`. Die vollständige Liste steht in [docs/sno-commands.md](../sno-commands.md).

**Was REM mit Ihren Daten macht.** REM ist die Art, wie Ihre Agenten träumen: der nächtliche Schritt, der ihr Gedächtnis über alle Ihre Sitzungen hinweg auf einmal festigt und verankert, was sie gelernt haben. Er läuft für jeden Teil Ihres Gedächtnisses höchstens einmal am Tag: meist nachts, oder schon tagsüber, sobald sich etwa 100 neue Erinnerungen angesammelt haben. Im Modus REM Enhanced gehen Ihr eigener Gedächtnistext und die Lektionen, die Ihre Agenten lernen, in Ihren eigenen Bereich in der Sno-Cloud, und ein Sno-Programm verarbeitet sie nur für Sie. Dieser Bereich funktioniert wie Ihr eigener Cloud-Speicher: Alles darin gehört Ihnen, und ein Sno-Programm verarbeitet es nur für Sie. Sie können hineingehen und Dinge löschen, sie behalten oder entscheiden, dass sie verarbeitet werden. Nichts wird automatisch gelöscht, und Sno gibt nichts davon an eine andere Person, Firma oder ein anderes Konto weiter. Im Modus Local First wird kein Gedächtnistext hochgeladen; im Modus Agent Native geht die Arbeit stattdessen an das Modell Ihres eigenen Agenten. Standardmäßig lädt Agent Native trotzdem jede Nacht die Sitzungen des Tages zu Sno hoch, für Self Learning, und kann beim ersten Prompt einer Sitzung eine Cloud-Lektion zurückholen; beides lässt sich in `~/.sno/settings.json` abschalten. In allen Modi holt und sortiert die Suche die Erinnerungen zunächst lokal; anschließend sortiert das lokale Modell `Horizon-Labs/multilingual-reranker-small` höchstens 32 Kandidaten neu. Dabei werden weder Prompt noch Gedächtnistext an Sno GPU gesendet. Setzen Sie `rerank.mode` auf `none`, um die ursprüngliche Reihenfolge ohne das Modell beizubehalten.

<a id="editors"></a>

## Wenn Sie im Editor zu Hause sind, nicht im Terminal

*Zuletzt aktualisiert am 2026-10-18.* Cursor kommt ins Team: im Agent-Chat der Cursor-App auf
macOS und in der Kommandozeile `cursor-agent` auf Linux und macOS. Es nutzt dasselbe Gedächtnis
wie Ihre anderen Agenten. Ein Chat beginnt mit einer kurzen Übersicht über das Repository,
jede Eingabe bringt bis zu drei Dinge mit, die Cursor noch nicht gesehen hat, und jede Eingabe
und Antwort wird gemerkt. Cursor liest dieselben Skills, prüft andere und wird geprüft,
übernimmt, wenn einem anderen Agenten das Kontingent ausgeht, und seine Chats fließen wie die
aller anderen in Self Learning ein.

Führen Sie einmal `cursor-agent login` aus. `sno setup` findet Cursor selbst und installiert
dessen Kommandozeile, wenn nur die App vorhanden ist.

Noch nicht: In der App bekommt der erste Chat eines neuen Fensters seine Übersicht erst mit der
ersten Eingabe, nicht davor. `cursor-agent -p` bekommt kein Gedächtnis pro Eingabe. Windows,
die Cursor-App unter Linux und die Cloud-Agenten von Cursor werden nicht unterstützt. Details
stehen in der [Cursor-Anleitung](../../apps/mem-cursor/README.md).

<a id="account"></a>

## Sehen Sie, was Ihre Agenten getan haben, als Sie nicht hingeschaut haben

*Zuletzt aktualisiert am 2026-10-18.* Dieser Computer erhält ein Zehntel des kostenlosen Kontingents, bis Sie ihn verknüpfen: `sno account claim`.
Das Konto ist kostenlos. Verbinden Sie es, um auf Ihrem [sno.ai-Dashboard](https://www.sno.ai/dashboard) zu sehen, was Ihre
Agenten für Sie getan haben: was ihre Reviews gefunden haben, was sie über Nacht gelernt haben,
welche Skills besser geworden sind und wie lange sie durchgearbeitet haben.

Das Verbinden legt nie heimlich ein Konto an. `sno setup` gibt jedem Computer eine anonyme
Identität. Beim Verbinden wird sie Ihrem Konto zugeordnet, und alles, was der Computer davor
und danach gesendet hat, zählt als Ihres.

**Noch kein Konto.** Das Onboarding zeigt einen Link, der nur für diesen Computer gemacht ist.
Öffnen Sie ihn, registrieren Sie sich und klicken Sie auf Approve. Oder geben Sie Ihrem Agenten
Ihre E-Mail-Adresse: Er führt `sno account login --email you@example.com` aus, und Sie melden
sich einmal an.

**Schon ein Konto.** Führen Sie einen Befehl aus, öffnen Sie den Link, den er ausgibt,
während Sie angemeldet sind, und klicken Sie auf Approve:

```bash
sno account claim
```

Der Computer erscheint von selbst auf [der Seite Ihrer Computer](https://www.sno.ai/dashboard/computers).
Einen Update-Schritt gibt es nicht: `sno` aktualisiert sich selbst, wenn es ein neueres Release findet.

<a id="what-runs-today"></a>

## Was Sie heute nutzen können, und wo Schluss ist

*Zuletzt aktualisiert am 2026-11-04.*

| Baustein | Status |
|---|---|
| Ein Gedächtnis über Codex, Claude Code, Hermes Agent, Cursor und OpenClaw hinweg | Veröffentlicht; auf einer sauberen Maschine aus der Registry installiert und durchgängig nachgewiesen |
| Cursor: dasselbe Gedächtnis, Skills, Review, Übernahme und Self Learning | Veröffentlicht in 1.3; die Kommandozeile `cursor-agent` auf einer sauberen Linux-Maschine durchgängig nachgewiesen; die Cursor-App auf macOS wird noch nachgewiesen |
| Sno Reach, Agenten sprechen ohne Daemon miteinander | Von `sno setup` installiert; Linux und macOS; auf einer sauberen Linux-Maschine durchgängig nachgewiesen |
| Self Learning und die Team-Skills | Von `sno setup` installiert; der nächtliche Job lief auf einer sauberen Linux-Maschine |
| Installation mit einem Befehl | `sno setup` installiert alles oben Genannte; auf einer sauberen Linux-Maschine nachgewiesen |
| „Sno onboard“ in Ihrem Agenten | Verfügbar; startet nach der Installation oder wenn Sie es sagen |
| Ein Befehl startet zwei Agenten | Neu in 2.0; mit echten Claude-Code- und Codex-Agenten gelaufen, als je einer von beiden und als zwei vom selben Anbieter |
| Sehen, wer Sie braucht: Statuszeile, tmux-Leiste, `sno squad` | Neu in 2.0; mit echten Claude-Code- und Codex-Agenten gelaufen, die um Erlaubnis bitten, und die Statuszeile in echtem Claude Code und Cursor |
| Unterbrochene Arbeit geht weiter, und eine Aufgabe übersteht das Komprimieren | Neu in 2.0; mit echten Claude-Code- und Codex-Agenten gelaufen |
| Eine freigegebene Lektion wirkt bei der nächsten Antwort | Neu in 2.0; mit echten Claude-Code- und Codex-Agenten gelaufen |
| Nachrichten warten, während Sie tippen oder ein Agent seinen Kontext komprimiert | Neu in 2.0; mit echten Claude-Code- und Codex-Agenten gelaufen |

Eine Zeile sagt „nachgewiesen“ erst, wenn sie auf einer sauberen Maschine gelaufen ist.

Noch nicht: Die Übernahme von Aufgaben und die Lektionen ab der nächsten Antwort laufen auf Claude Code und Codex. Die Statuszeile gibt es in Claude Code und Cursor. Hermes Agent und OpenClaw haben diese Abläufe auf echten Installationen noch nicht durchlaufen, und OpenClaw erscheint in `sno squad` mit unbekanntem Status.

<a id="memory"></a>

## Gedächtnis, das absichtlich vergisst

*Zuletzt aktualisiert am 2026-10-11.* Das Gedächtnis von Agenten scheitert meist auf zwei
stille Arten. Es verliert, was hätte bleiben sollen, und es behält, was hätte verblassen
sollen. Der zweite Fehler kostet mehr. Ein Agent, der sich noch an eine Präferenz „erinnert“,
die Sie aufgehoben haben, an eine Deadline, die sich verschoben hat, oder an eine Adresse, die
Sie verlassen haben, handelt mit voller Überzeugung danach.

Deshalb mustert das Gedächtnis hier eine Tatsache aus, wenn eine spätere sie ersetzt. Was es
behält und was es loslässt, wird mit der Nutzung besser, nicht mit einem Modell-Release. Wie
es bei den öffentlichen Gedächtnis-Tests abschneidet, mit jeder Antwort und jedem Trace
dahinter, steht in [`evals/`](../../evals/).

## Zwei Agenten nebeneinander im Einsatz? Sprechen Sie mit uns

Wir arbeiten mit einer Handvoll Leuten zusammen, die bereits zwei oder mehr Agenten
nebeneinander betreiben und Ergebnisse von Hand zwischen ihnen verschieben. Wenn das auf Sie
zutrifft, öffnen Sie ein
[Design-Partner-Issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)
und schreiben Sie uns, was Sie einsetzen.

## Was die Verschlüsselung schützt, und was nicht

Siehe [SECURITY.md](../../SECURITY.md). Was die Verschlüsselung schützt und was nicht, steht in
[docs/security.md](../security.md).

## Apache-2.0, durch und durch

Apache-2.0. Open Source, durch und durch. Siehe [LICENSE](../../LICENSE).

## Die Schultern, auf denen wir stehen

Arbeiten, auf denen dieses Repository aufbaut.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Ein Agent sollte ein Wiki über das Gelernte führen, statt es in jeder Sitzung neu herzuleiten.
- Tang, Rashtchian, Ferng, Tomkins, Juan und Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). Die eigene Erfahrung eines Agenten, verwandelt in Wissen, das seine Skills umschreibt.
- Zhang, Hu, Upasani und Kollegen, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). Beim Entwurf von Self Learning haben wir studiert, wie es kuratiert, was ein Agent behält.
- Uddin, Shubham, Blanco, Baral und Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). Der erste Benchmark, der auch prüft, was ein Gedächtnis nicht mehr sagen sollte.
