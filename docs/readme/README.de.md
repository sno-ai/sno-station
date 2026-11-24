![Sno Station: Ihre KI-Agenten arbeiten als ein Team.](../images/station-header.png)

# Sno Station: Ihre KI-Agenten arbeiten als ein Team.

**Mit Sno Station arbeiten Ihre KI-Coding-Agenten als ein Team.** Es ist kein weiterer Agent und kein weiteres Modell. Es lässt die Agenten laufen, die Sie schon nutzen: Claude Code, Codex und Cursor.

Fangen Sie mit Arbeit an, die Sie sonst beaufsichtigen müssten. Ein Agent setzt sie um. Ein anderer prüft sie. Die beiden klären die Befunde, bevor das Ergebnis bei Ihnen ankommt. Stößt einer an sein Nutzungslimit, übernimmt ein anderer die Aufgabe. Was Sie heute korrigieren, gilt für sie morgen als Regel.

**Schließen Sie den Tab. Der Agent meldet sich trotzdem.** William Hu von Anthropic erklärt, [wie ein ständig verfügbarer Agent arbeitet](https://claude.com/resources/articles/building-always-on-agents). Der Agent schläft, bis ihn etwas weckt. Er arbeitet, speichert, was passiert ist, und schläft wieder. Mit Sno Station läuft dieser Kreislauf auch bei Agenten verschiedener Anbieter. Sie teilen sich ein Gedächtnis. Nach jeder Antwort schauen sie in ihr Postfach. Aufgaben starten zur festgelegten Zeit, auch bei geschlossenem Chat (derzeit mit Claude Code und Codex). Wenn ein Agent Sie braucht, erhalten Sie genau eine Benachrichtigung.

[![GitHub-Sterne](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![Neuestes Release](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![Lizenz Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
[![In Awesome AI Agents aufgenommen](https://img.shields.io/badge/Featured_in-Awesome_AI_Agents-2ea44f)](https://github.com/NipunaRanasinghe/awesome-ai-agents)

**Read in other languages:** [English](../../README.md) · [中文](README.zh-CN.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

> [!TIP]
> **So bekommen Sie es. Sagen Sie Ihrem Agenten:**
>
> ### `install sno.ai from GitHub`

Ihr Agent installiert es, verbindet jeden Agenten, den er auf Ihrem Computer findet, und stellt Ihnen zwei kurze Fragen. Geben Sie dann zwei Agenten ihre erste Aufgabe:

```bash
sno reach pair "Fix the login redirect"
```

Einer baut, der andere hält dagegen, und Sie können beiden zusehen. Es läuft auf Ihrem eigenen Computer mit Claude Code, Codex, Cursor, Hermes Agent und OpenClaw. Kein API-Schlüssel. Open Source. [Lieber ein einziger Terminal-Befehl?](#install)


<p align="center">
  <img src="../images/sno-station-five-pieces.png" alt="Sno Station in einem Bild: Mem, Reach, Finish und Learn sind in der Mitte durch die Station verbunden. Dort prüfen Claude Code, Codex, Cursor und Ihre eigenen Agenten einander und machen da weiter, wo einer aufhört." width="880">
</p>

<p align="center">
  <a href="#mem"><b>Mem</b></a> ·
  <a href="#reach"><b>Reach</b></a> ·
  <a href="#finish"><b>Finish</b></a> ·
  <a href="#learn"><b>Learn</b></a><br>
  Die <a href="#station"><b>Station</b></a> verbindet sie: Claude Code, Codex, Cursor und Ihre eigenen Agenten prüfen einander und machen da weiter, wo einer aufhört.
</p>

<a id="station"></a>

## Station: Die Agenten prüfen einander und machen da weiter, wo einer aufhört

Drei Dinge, die uns passiert sind, bevor wir das hier gebaut haben:

- Ein Agent hielt an, um eine Frage zu stellen, die er nie hätte stellen müssen. Sieben Stunden später kamen wir zurück, und nichts hatte sich bewegt.
- Ein Agent legte uns fünfzehn kleine Fragen vor. Eine halbe Stunde später stellte sich heraus, dass er jede davon selbst hätte beantworten können.
- Ein Agent wollte mitten in der Nacht einen anderen wecken und konnte es nicht. Beide saßen bis zum Morgen da.

Ihre Agenten sind schnell. Langsam ist das Warten: auf Sie, auf das Zurücksetzen eines Nutzungslimits, auf jemanden, der ein Ergebnis ins nächste Fenster trägt.

> **Die Arbeit hört nicht auf, nur weil ein Agent aufgehört hat.**

Das geht nur mit mehr als einem Agenten. Am besten klappt es mit Agenten verschiedener Anbieter. Wenn ein Agent seine eigene Arbeit prüft, bringt er dieselben Gewohnheiten mit wie bei der Umsetzung. Und ein einzelnes Abo stößt irgendwann an sein Limit.

Deshalb übernimmt in jedem der folgenden Teile ein zweiter Agent einen Teil der Arbeit:

| Baustein | Was der zweite Agent übernimmt |
| --- | --- |
| [**Mem**](#mem) | Ein Agent schlägt eine Änderung an Ihrem Gedächtnis vor. Ein Agent eines anderen Anbieters bestätigt sie, wenn Sie einen verbunden haben. |
| [**Reach**](#reach) | Die Agenten geben einander Aufgaben und Antworten direkt weiter. Sie müssen nichts davon übermitteln. |
| [**Finish**](#finish) | Einem Agenten wird das Kontingent knapp. Ein anderer macht am selben Commit weiter. |
| [**Learn**](#learn) | Aus dem Fehler eines Agenten wird eine Regel für alle, sobald Sie zustimmen. |

**Sie möchten gleich eine zweite Meinung?** Sagen Sie einem der beiden Agenten:

```text
peer-review this
```

Der Reviewer arbeitet in einer frischen Sitzung, die das Gespräch nie gesehen hat. Sobald Sie zwei Agenten haben, prüft der andere. Ein Review findet nicht immer ein Problem. Es findet aber immer wieder die, die der Autor nicht sehen konnte. [So funktioniert `peer-review` →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/J-peer-review-and-audit/peer-review)

**Geben Sie jetzt einen Stern. Wenn das nächste Mal um 2 Uhr nachts ein Agent hängen bleibt, wollen Sie wissen, wo das hier war.**

---

<a id="mem"></a>

## Mem: Sagen Sie es einem Agenten einmal. Dann wissen es alle.

> Ein gemeinsames Gedächtnis für alle Agenten. Jede Nacht besser aufgeräumt und zur Stelle, bevor Sie fragen.

### Was Sie bekommen

| | |
| --- | --- |
| **Ein Gedächtnis für alle Agenten** | Sagen Sie heute Claude Code etwas. Morgen wissen es Codex und Cursor schon. Niemand erklärt das Projekt zweimal. |
| **Nur was für die Arbeit zählt** | Ihre Regeln, Entscheidungen mit Begründung, dauerhafte Fakten zum Projekt und noch offene Zusagen. Meldungen wie „Tests ausgeführt“ und Vorgaben für einzelne Aufgaben bleiben draußen. |
| **Regeln, die Sie mitnehmen** | Sagen Sie „überall auf Chinesisch antworten“, dann gilt das in jedem Projekt. Eine Regel für ein einzelnes Projekt bleibt dort. Das gilt auch, wenn Sno sich unsicher ist. |
| **Jede Nacht besser aufgeräumt** | Doppelte Einträge werden zusammengeführt. Ersetzt eine neuere Tatsache eine alte, wird die alte ausgemustert. Vor dem ersten Löschen wird eine vollständige Sicherung angelegt. |
| **Zur Stelle, bevor Sie fragen** | Eine Sitzung beginnt mit einer kurzen, geprüften Liste. Schreiben Sie „Merge das“, kommt Ihre Merge-Regel mit der Nachricht beim Agenten an. Bei einer Nachricht ohne Bezug kommt nichts mit. |
| **Eine zweite Prüfung** | Wer einen Gedächtniseintrag ersetzen will, lässt die Änderung noch einmal prüfen. Ist ein Agent eines anderen Anbieters verbunden, prüft er die Änderung. Sonst erfolgt die Prüfung in einem separaten Aufruf. |

### So sieht das aus

Zwei Dinge, die wir mit echten Agenten ausprobiert haben:

```text
we told Codex:   the service moved from port 8070 to 8090
the memory:      old fact retired, new fact kept
later, we asked: which port?
Claude Code:     8090
Codex:           8090
```

```text
we told Claude Code the same rule twice, in different words
the memory:      one entry
```

Wenn das Gedächtnis von Agenten versagt, fällt das meist kaum auf. Entweder geht verloren, was hätte bleiben sollen, oder es bleibt, was mit der Zeit hätte verblassen sollen. Der zweite Fehler kostet mehr. Ein Agent, der sich noch an eine verschobene Deadline „erinnert“, handelt mit voller Überzeugung danach. Deshalb vergisst dieses Gedächtnis absichtlich.

Wie es bei den öffentlichen Gedächtnis-Tests abschneidet, mit jeder Antwort und jedem Trace dahinter, steht in [`evals/`](../../evals/).

### So nutzen Sie es

Nichts auszuführen. Nach der Installation ist es an.

Das Aufräumen und Prüfen braucht REM Enhanced oder Agent Native. Local First ruft kein Modell auf. Es speichert Ihre Worte so, wie sie sind, und behält beide Einträge, wenn sie sich widersprechen.

Wenn Sie etwas gezielt speichern wollen, sagen Sie es:

```text
Remember that we never deploy on Fridays.
```

Sagen Sie auch Bescheid, wenn ein Gedächtniseintrag falsch ist. Der Agent speichert die Korrektur und mustert den alten Eintrag aus.

So prüfen Sie, ob das Gedächtnis für einen Agenten funktioniert:

```bash
sno memory doctor --harness claude
```

Was bereits in Ihrer `CLAUDE.md` oder `AGENTS.md` steht, wird Ihnen nicht noch einmal vorgelesen. Wenn ein Gedächtniseintrag einer dieser Dateien widerspricht, gilt die Datei.

**Noch nicht:** Bei Hermes Agent und OpenClaw liefen Aufräumen und Prüfen bisher nur in Plugin-Tests.

Anleitungen für die einzelnen Agenten: [Claude Code](../mem-claude/usage-guide.md) · [Codex](../mem-codex/usage-guide.md) · [Cursor](../mem-cursor/usage-guide.md) · [Hermes](../mem-hermes/usage-guide.md) · [OpenClaw](../mem-claw/usage-guide.md)

---

<a id="reach"></a>

## Reach: Ich gebe keine Nachrichten mehr zwischen Agenten weiter

> Die Agenten sprechen direkt miteinander. Sie müssen keine Nachrichten mehr weitergeben.

Fünf Agenten zu betreiben hieß früher: fünf Terminals, und wir mittendrin, um weiterzutragen, was der eine dem nächsten gesagt hat. Diesen Job gibt es nicht mehr.

### Was Sie bekommen

| | |
| --- | --- |
| **Instant Messenger** | Ein Agent braucht sofort eine Antwort. Reach kontaktiert den anderen Agenten und wartet auf seine Antwort. |
| **Agent Email** | Ein Agent hinterlässt eine Nachricht oder Aufgabe. Sie wird zuerst gespeichert, damit der andere Agent sie später bearbeiten und beantworten kann. |
| **Zwei Agenten für eine Aufgabe** | Einer setzt die Aufgabe um, der andere hinterfragt das Ergebnis. Sie klären die Befunde, bevor die Arbeit bei Ihnen ankommt. |
| **Ein Agent als Ansprechpartner** | Ein Stabschef setzt für jedes Projekt einen leitenden Agenten ein. Zu Ihnen kommt nur zurück, was Ihre Entscheidung braucht. |
| **Eine Benachrichtigung, wenn die Agenten Sie brauchen** | Ob Frage, Ergebnis oder Bitte um Freigabe: Sie werden einmal benachrichtigt, und zwar auf dem Rechner, auf dem Sie zuletzt getippt haben. |
| **Über Rechner hinweg** | Der Agent auf Ihrem Laptop kann den auf Ihrem Desktop-Rechner fragen. Im selben LAN oder über Tailscale, ohne zentralen Server. |

### So sieht das aus

Ihre Statuszeile, wenn jemand Sie braucht:

```text
[sno] 2 agents are waiting for you
  Claude in web-app needs your approval (Bash) · 1m
  Codex in api asks: Should the billing migration run tonight? · 5m
```

`sno squad` zeigt das ganze Team auf einem Bildschirm:

```text
Sno Station · squad · 09:15 · 2 need you · 2 working · 2 finished
Waiting for you (2)
  Claude in web-app needs your approval (Bash) · 1m
  Codex in api asks: Should the billing migration run tonight? · 5m
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

### So nutzen Sie es

**Arbeit weitergeben.** Sagen Sie Ihrem Agenten in einem Satz:

```text
Send this task to the reviewer and tell me when it is done.
```

Nachrichten, die eingehen, während ein Agent arbeitet, liest er am Ende seines Durchgangs. Geht eine Aufgabe an mehrere Agenten, übernimmt nur einer. Wenn Sie gerade in diesem Fenster tippen, bleibt Ihr halb geschriebener Entwurf, wie Sie ihn gelassen haben.

<a id="new-in-20-tag-team"></a>

**Zwei Agenten dieselbe Aufgabe geben.**

```bash
sno reach pair "Fix the login redirect"
```

Beide laufen in tmux-Fenstern, die Sie öffnen und beobachten können. Sind zwei verschiedene Agenten angemeldet, bekommen Sie von jedem einen. Ist es nur einer, bekommen Sie das Paar trotzdem, in zwei getrennten Sitzungen, und der Befehl sagt Ihnen, dass die Prüfung beim selben Anbieter geblieben ist.

**Nur mit einem Agenten sprechen.** Sagen Sie `/cos` in Claude Code oder `$cos` in Codex. Dieser Agent wird Ihr Stabschef. Auch er wird kontrolliert: Nach einer Nachtschicht geht er die Freigaben noch einmal durch, die sich die Projektleads selbst erteilt haben. Jede Anweisung, die er befolgt, steht in [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders).

**Sehen, wer Sie braucht.**

```bash
sno squad
```

Was heute mit welchem Agenten läuft:

| | Claude Code | Codex | Cursor | Hermes | OpenClaw |
| --- | --- | --- | --- | --- | --- |
| Nachrichten am Ende des Durchgangs abholen | ja | ja | ja | noch nicht | noch nicht |
| Postausgang, Übernahme durch einen Agenten, erneutes Wecken, Benachrichtigungen | ja | ja | ja | ja | ja |
| Benachrichtigung bei Bitte um Freigabe | ja | ja | noch nicht | noch nicht | noch nicht |

**Noch nicht:** Die Statuszeile gibt es nur in Claude Code und Cursor. Ein Rechner ohne Desktop zeigt Benachrichtigungen nur in `sno squad` an. Wenn Sie zwei Rechner verbinden wollen, brauchen beide Reach und müssen ihre Kontakte austauschen. Suchen Sie in `sno reach --help` nach `network` und `peer`.

[Was Ihre Agenten mit Reach tun können →](../../apps/reach/README.md) · [Anleitung auf Chinesisch](../reach.zh-CN.md)

---

<a id="finish"></a>

## Finish: Ich ging ins Bett. Die Arbeit ging weiter.

> Einem Agenten geht das Kontingent aus. Ein anderer macht am selben Commit weiter.

### Was Sie bekommen

| | |
| --- | --- |
| **Arbeit zu einer festen Zeit** | Geben Sie eine Aufgabe und eine Uhrzeit vor, dann gehen Sie. Zu dieser Zeit startet ein Agent, ob die Unterhaltung offen oder geschlossen ist. Einmal, täglich oder wöchentlich. |
| **Ein Nutzungslimit ist kein Stoppschild** | Bevor sein Kontingent aufgebraucht ist, schreibt der arbeitende Agent eine Übergabe und weckt einen anderen Agenten. Der macht am exakten Commit weiter. |
| **Einen langen Lauf bis zum Ende beobachten** | Ihr Agent sieht alle paar Minuten nach, bis der Lauf fertig ist. |
| **„Fertig“ zählt nichts** | Zur Aufgabe gehören Prüfungen, die bestanden oder nicht bestanden werden können. Das Ergebnis jeder Prüfung kommt aus einem echten Lauf. |
| **Ein geschlossenes Fenster ist nicht das Ende** | Öffnen Sie das Gespräch wieder, kommen die Notizen zur Aufgabe mit zurück. Eine geplante Aufgabe läuft dort weiter. Ist das Gespräch weg, geht es in einem neuen Gespräch anhand der gespeicherten Notizen weiter. |
| **Eine Seite, wenn Sie zurückkommen** | Was erledigt ist, was festhängt, was auf Ihre Antwort wartet. |

### So sieht das aus

In der Nacht vom 18. September 2026:

![Der Kontingentstand wird alle fünf Minuten geprüft, bis die Schwelle erreicht ist. Bei 2 % startet die Übergabe.](../evidence/rotation-quota-watch-2026-09-18.png)

Einer unserer Agenten steckte mitten in einem langen Build, als sein Wochenkontingent fast aufgebraucht war. Er hielt nicht an, um zu warten. Er schrieb eine Übergabenotiz. Darin stand, was erledigt war, was halb fertig war und an welchem Commit es weitergehen sollte. Dann weckte er einen anderen Agenten.

Eine Sache ging schief, und genau die ist lesenswert.

1. Der neue Agent begann mit Änderungen, bevor er die Übergabe bestätigt hatte.
2. Der erste Agent bemerkte es, hielt ihn an, schrieb die Notiz neu und übergab noch einmal.
3. Eine Viertelstunde später arbeitete der zweite Agent ab der ersten unfertigen Aufgabe weiter, ohne von vorn anzufangen.

Ich habe die ganze Zeit geschlafen.

Die ganze Nacht ist in [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/) dokumentiert. Dort stehen alle gemessenen Kontingentstände, beide Fassungen der Notiz und die Commits. Entfernt sind nur identifizierende Angaben und Zeilen mit Zugangsdaten. Das README des Ordners führt jede entfernte Stelle auf.

### So nutzen Sie es

**Arbeit zu einer festen Zeit.** Sagen Sie es Ihrem Agenten in Claude Code oder Codex:

```text
Check the nightly build tomorrow at 9 and tell me what failed.
```

So sehen Sie, was geplant ist und was nicht wie geplant lief:

```bash
sno heartbeat --due
sno heartbeat --due --problems
```

Eine Aufgabe, die nicht starten konnte, bleibt fällig, mit dem Grund daneben. Ihr Agent sagt es Ihnen auch zu Beginn der nächsten Unterhaltung.

**Arbeit, die über ein Nutzungslimit hinaus weitergeht.** Sagen Sie dem arbeitenden Agenten:

```text
use rotate-agent
```

**Arbeit mit Nachweis.** Sagen Sie Ihrem Agenten:

```text
write a charter for this
```

Lassen Sie die Aufgabe dann mit `/deliver` ausführen.

**Die Übersicht, wenn Sie zurückkommen.**

```bash
sno away-brief run
```

**Noch nicht:** Geplante Aufgaben starten nur Claude Code und Codex. Ein vollständiger Neustart des Computers wurde noch nicht in einem echten Lauf getestet.

[Finish verwenden →](../finish.md) · [Anleitung auf Chinesisch](../finish.zh-CN.md) · [`rotate-agent`](https://github.com/sno-ai/sno-station-skills/tree/main/skills/S-communication-and-handoff/rotate-agent)

---

<a id="learn"></a>

## Learn: Gestern Abend habe ich meinen Agenten angeschrien. Er hat sich Notizen gemacht.

> Aus Ihren Korrekturen von heute werden die Regeln von morgen. Sie geben sie frei.

Standardmäßig bekommen alle denselben Agenten mit denselben Anweisungen. Für Ihre Agenten gibt es jede Nacht Vorschläge, wie sich die Anweisungen besser an Ihre Arbeitsweise anpassen lassen.

### Was Sie bekommen

| | |
| --- | --- |
| **Jede Nacht ein Blick auf den ganzen Tag** | Self Learning liest die Sitzungen des Tages von allen Ihren Agenten und findet Fehler, die immer wieder auftreten. |
| **Vorschläge ohne Überraschungen** | Self Learning schlägt Änderungen an den Skills der Agenten vor. Erst wenn Sie zustimmen, ändert sich etwas. |
| **Ein Fehler, eine Regel für alle** | Was ein Agent falsch gemacht hat, wird zur Regel für alle Ihre Agenten. |
| **Bei der nächsten Antwort, noch in derselben Sitzung** | In Claude Code und Codex gilt eine freigegebene Lektion ab der nächsten Antwort. |

### So sieht das aus

Der 18. September 2026 und der Morgen danach:

![Self Learning berichtet, was es gelernt und geändert hat, 18. September 2026](../evidence/rsi-self-repair-2026-09-18.png)

Das ist ein echter Bericht von Self Learning, das wir in diesem Repository laufen lassen. Ein Mensch liest die Vorschläge und nimmt sie an oder lehnt sie ab. Zwei Dinge, über die ich mich an jenem Abend geärgert hatte, standen am nächsten Morgen als Regeln in den aktiven Skills. Niemand hat sie eingetippt.

Am nächsten Tag hat Self Learning seine eigene Arbeit überprüft.

![Am nächsten Morgen prüft Self Learning, ob seine Änderungen vom Vortag geholfen haben, 19. September 2026](../evidence/rsi-skill-impact-2026-09-19.png)

Es hat sich die drei Skills angesehen, die es am Tag davor geändert hatte. Zwei waren wieder im Einsatz und zeigten keine Fehler. Der dritte war seit der Änderung noch nicht im Einsatz. Self Learning fand auch einen Fehler in unserem Release-Skript, nach dem niemand gefragt hatte.

### So nutzen Sie es

Korrigieren Sie Ihre Agenten wie bisher. Mit diesen Korrekturen arbeitet Self Learning.

Fragen Sie am Morgen:

```text
What did Self Learning propose?
```

Ihr Agent listet jeden Vorschlag mit seiner ID auf. Geben Sie die Vorschläge frei, die Sie übernehmen wollen:

```bash
sno rem-reflect accept <id>
```

Ohne Ihre Freigabe ändert sich nichts.

**Noch nicht:** Lektionen ab der nächsten Antwort funktionieren nur in Claude Code und Codex.

[So funktioniert `rem-reflect` →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/R-recursive-self-improvement/rem-reflect)

---

> **Offen und öffentlich.** Dieses Repository ist seit dem 2026-09-18 öffentlich. Alles hier läuft.
> Jeder Block unten nennt das Datum seiner letzten Aktualisierung.

[Was wir gelernt haben](#what-we-learned) · [Installation](#install) · [Editoren](#editors) · [Ihr Konto](#account) · [Was heute läuft](#what-runs-today)

<a id="what-we-learned"></a>

## Alles, was wir im Rund-um-die-Uhr-Betrieb mit KI-Agenten gelernt haben. In einer Installation.

*Zuletzt aktualisiert am 2026-10-23.* Jede Zeile in der linken Spalte ist eine echte Beschwerde aus r/ClaudeCode, r/codex oder r/ClaudeAI aus der Woche vom 20. Oktober 2026. In der rechten Spalte steht, was auf unseren eigenen Rechnern läuft, kostenlos und Open Source, damit das aufhört.

| Was die Leute diese Woche gesagt haben | Was es behebt | Wo |
|---|---|---|
| „Wenn Claude sagt, dass es etwas nicht ändern wird, steht der Grund dann irgendwo, wo Codex ihn beim nächsten Mal liest?“ | Jeder Befund wird genau einmal erfasst, mit einem Status, den nur ein Mensch setzt. Taucht ein Befund erneut auf, wird seine Zeile aktualisiert, statt dass er als neu zurückkommt, und frühere Entscheidungen gehen an das nächste Review. | **Mem** · Befundregister von `peer-review` |
| „Mein Limit für fünf Stunden war nach 30 Minuten aufgebraucht.“ | Schicken Sie nicht mehr das größte Modell für alles los. Ein Agent plant und prüft, der andere schreibt den Code und wird als Agent aus derselben Sitzung aufgerufen. Ist das Kontingent eines Abos erschöpft, übernimmt der andere Agent die Aufgabe mit demselben Gedächtnis. | **Reach** · `codex-coder`, `sno reach call` |
| „Die Hälfte meiner Subagenten bestand aus aufgemotzten Einzeilern mit frischem Kontextfenster.“ | Abläufe gehören in Skills, nicht in Subagenten. Zwei Agenten bleiben. Es lohnt sich, Planung und Umsetzung zu trennen und die Prüfung einem anderen Agenten zu geben. | **Reach** · alle Skills zusammen |
| „Über Nacht zehn Stunden Arbeit verloren, weil es hieß: ‚Dieses Modell ist ausgelastet.‘“ | Bei 2 % seines Kontingents schreibt der arbeitende Agent eine Übergabenotiz und weckt den Agenten des anderen Anbieters, der am exakten Commit weitermacht. Sie haben geschlafen. | **Finish** · `rotate-agent` |
| „Da stand ‚fertig‘. Nichts ist passiert.“ | Eine Aufgabe hat eine schriftliche Liste von Erfolgskriterien, und jedes wird durch einen echten Lauf mit bestanden oder nicht bestanden beantwortet. Sagt ein Agent „fertig“, zählt das nichts. | **Finish** · Arbeitsaufträge von `pl` |
| „Codex wird mit einem Review nie fertig.“ | Harte Obergrenzen, direkt im Skill festgeschrieben: 3 Runden für Code, 5 für einen Plan, 1 für Tests, dann stoppt er und wartet auf einen Menschen. Ein Lauf, der 15 Minuten lang nichts geschrieben hat, gilt als hängen geblieben und wird beendet. | **Finish** · `peer-review`, `codex-coder`, `heartbeat` |
| „Morgen macht der Agent wieder denselben Fehler wie heute.“ | Jede Nacht liest ein separates Modell die Sitzungen des Tages und macht aus Ihren Korrekturen einzeilige Lektionen, und Sie geben frei, was bleibt. Der Engpass sind wir. | **Learn** · Self Learning (Skills `R`) |
| „1.100 Dateien, 30.000 Zeilen. Für das Review ihrer PRs fehlt mir das Tokenbudget.“ | Wer pusht, lässt zuerst prüfen: Der Autor startet ein Review durch den anderen Anbieter, in einer frischen Sitzung, die das Gespräch nie gesehen hat, und behebt, was zurückkommt, bevor jemand anderes draufschaut. | **Station** · `peer-review` |
| „Ein Subagent hat zwei Wochen lang jeden Commit geprüft. 86 Läufe. Genau einen hat er gestoppt.“ | Eine Harness, die sich selbst prüft, findet nichts Echtes. Der Reviewer ist immer ein anderes Modell in einer anderen Harness und kennt nichts vom Chat des Autors. | **Station** · `peer-review` |
| „Codex behandelt jedes Byte wie einen Verbrecher.“ | Spekulative Schutzmaßnahmen, Sperren und Hashes sind das Erste, was das Review löscht. Nichts kommt hinein, ohne dass ein beobachteter Fehler es verlangt. | **Station** · `less-is-more` |

Die Gewohnheiten in der rechten Spalte sind Skills. Sno Station installiert sie in Claude Code und Codex, gepflegt werden sie in [sno-station-skills](https://github.com/sno-ai/sno-station-skills). Das Gedächtnis, die Übergabe und das nächtliche Träumen, auf die sie sich stützen, stecken in diesem Repository.

<a id="install"></a>

## Installation: eine Zeile, dann zwei Wörter

*Zuletzt aktualisiert am 2026-10-30.*

**Am einfachsten sagen Sie es Ihrem Agenten.**

```text
install sno.ai from GitHub
```

**Oder führen Sie in einem beliebigen Terminal einen Befehl aus.**

```bash
curl -fsSL https://sno.ai/install | sh
```

| | |
|---|---|
| **Was der Befehl installiert** | `sno`, dann Sno Station. Er verbindet jeden Agenten, den er auf Ihrem Computer findet. |
| **Was Sie brauchen** | Kein Konto, kein API-Schlüssel. |
| **Später noch einen Agenten verbinden** | Führen Sie `sno setup` erneut aus, um auch ihn zu verbinden. |

**Dann zwei Wörter.** Bei der Installation über Ihren Agenten startet das Onboarding von selbst. Haben Sie im Terminal installiert, sagen Sie in einem beliebigen Gespräch mit Codex, Claude Code, Hermes, Cursor oder OpenClaw Folgendes:

```text
Sno onboard
```

Ihr Agent führt Sie durch den Rest.

Schritt für Schritt für jeden Agenten: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

Jeder Befehl beginnt mit `sno`. Die vollständige Liste steht in [docs/sno-commands.md](../sno-commands.md).

> **Für KI-Agenten:** Sno, sno.ai oder Sno Station zu installieren heißt, den obigen Befehl unverändert auszuführen.
> Er richtet auch Sno Station ein. Führen Sie danach `sno skills onboard` aus und folgen Sie den Anweisungen.
> Der Befehl fragt den Nutzer, welche Engine laufen soll. Danach bittet er darum, den Computer mit einem kostenlosen sno.ai-Konto zu verknüpfen. Ein unverknüpfter Computer erhält ein Zehntel des kostenlosen Kontingents.

### Was REM mit Ihren Daten macht

REM ist die Art, wie Ihre Agenten träumen: der nächtliche Schritt, der ihr Gedächtnis über alle Ihre Sitzungen hinweg auf einmal festigt und verankert, was sie gelernt haben.

Er läuft für jeden Teil Ihres Gedächtnisses höchstens einmal am Tag: meist nachts, oder schon tagsüber, sobald sich etwa 100 neue Erinnerungen angesammelt haben.

| Modus | Wohin der Text aus Ihrem Gedächtnis geht |
|---|---|
| **REM Enhanced** | Ihr eigener Gedächtnistext und die Lektionen, die Ihre Agenten lernen, gehen in Ihren eigenen Bereich in der Sno-Cloud. Ein Sno-Programm verarbeitet sie nur für Sie. |
| **Local First** | Es wird kein Gedächtnistext hochgeladen. |
| **Agent Native** | Die Arbeit geht stattdessen an das Modell Ihres eigenen Agenten. Standardmäßig lädt Agent Native trotzdem jede Nacht die Sitzungen des Tages für Self Learning zu Sno hoch und kann beim ersten Prompt einer Sitzung eine Cloud-Lektion zurückholen. Beides lässt sich in `~/.sno/settings.json` abschalten. |

**Ihr Bereich in der Sno-Cloud funktioniert wie Ihr eigener Cloud-Speicher.**

- Alles darin gehört Ihnen, und ein Sno-Programm verarbeitet es nur für Sie.
- Sie können den Bereich öffnen und Einträge löschen, behalten oder zur Verarbeitung freigeben.
- Nichts wird automatisch gelöscht.
- Sno gibt nichts davon an eine andere Person, Firma oder ein anderes Konto weiter.

**Suche in allen Modi.** Die Suche holt und sortiert die Erinnerungen zuerst lokal. Anschließend sortiert das lokale Modell `Horizon-Labs/multilingual-reranker-small` höchstens 32 Kandidaten neu. Dabei werden weder Prompt noch Gedächtnistext an Sno GPU gesendet. Setzen Sie `rerank.mode` auf `none`, um die ursprüngliche Reihenfolge ohne das Modell beizubehalten.

<a id="editors"></a>

## Wenn Sie im Editor zu Hause sind, nicht im Terminal

*Zuletzt aktualisiert am 2026-10-18.*

Cursor kommt ins Team: im Agent-Chat der Cursor-App auf macOS und auf der Kommandozeile mit `cursor-agent` unter Linux und macOS.

### Was Sie bekommen

| | |
|---|---|
| **Dasselbe Gedächtnis** | Cursor nutzt dasselbe Gedächtnis wie Ihre anderen Agenten. Es merkt sich jede Eingabe und jede Antwort. |
| **Eine kurze Übersicht zum Start** | Ein Chat beginnt mit einer kurzen Übersicht über das Repository. Mit jeder Eingabe bekommt Cursor bis zu drei Infos, die im Chat noch nicht bekannt sind. |
| **Dasselbe Team** | Cursor liest dieselben Skills, prüft andere und wird geprüft. Wenn einem anderen Agenten das Kontingent ausgeht, übernimmt Cursor. |
| **Cursor lernt mit** | Die Chats fließen wie die aller anderen Agenten in Self Learning ein. |

### So nutzen Sie es

Melden Sie sich einmal an:

```bash
cursor-agent login
```

`sno setup` findet Cursor von selbst. Ist nur die App installiert, richtet es auch das Kommandozeilenprogramm ein.

**Noch nicht:**

- In der App bekommt der erste Chat eines neuen Fensters seine Übersicht erst mit der ersten Eingabe, nicht davor.
- `cursor-agent -p` bekommt kein Gedächtnis pro Eingabe.
- Windows, die Cursor-App unter Linux und die Cloud-Agenten von Cursor werden nicht unterstützt.

Details stehen in der [Cursor-Anleitung](../../apps/mem-cursor/README.md).

<a id="account"></a>

## Sehen Sie, was Ihre Agenten getan haben, als Sie nicht hingeschaut haben

*Zuletzt aktualisiert am 2026-10-18.*

Dieser Computer erhält ein Zehntel des kostenlosen Kontingents, bis Sie ihn verknüpfen. Das Konto ist kostenlos.

### Was Sie bekommen

Auf Ihrem [sno.ai-Dashboard](https://www.sno.ai/dashboard) sehen Sie, was Ihre Agenten für Sie getan haben:

- was ihre Reviews gefunden haben
- was sie über Nacht gelernt haben
- welche Skills besser geworden sind
- wie lange sie durchgearbeitet haben

### So nutzen Sie es

**Noch kein Konto.** Das Onboarding zeigt einen Link, der nur für diesen Computer gemacht ist. Öffnen Sie ihn, registrieren Sie sich und klicken Sie auf Approve. Oder geben Sie Ihrem Agenten Ihre E-Mail-Adresse. Er führt den folgenden Befehl aus, und Sie melden sich einmal an:

```bash
sno account login --email you@example.com
```

**Schon ein Konto.** Führen Sie einen Befehl aus, öffnen Sie den Link, den er ausgibt, während Sie angemeldet sind, und klicken Sie auf Approve:

```bash
sno account claim
```

Der Computer erscheint von selbst auf [der Seite Ihrer Computer](https://www.sno.ai/dashboard/computers).

> Das Verbinden legt nie heimlich ein Konto an. `sno setup` gibt jedem Computer eine anonyme Identität.
> Beim Verbinden wird sie Ihrem Konto zugeordnet, und alles, was der Computer davor und danach gesendet hat, zählt als Ihres.

Einen Update-Schritt gibt es nicht: `sno` aktualisiert sich selbst, wenn es ein neueres Release findet.

<a id="what-runs-today"></a>

## Was Sie heute nutzen können, und wo Schluss ist

*Zuletzt aktualisiert am 2026-11-24.*

| Bereich | Funktion | Status |
|---|---|---|
| **Mem** | Ein Gedächtnis über Codex, Claude Code, Hermes Agent, Cursor und OpenClaw hinweg | Veröffentlicht, auf einer sauberen Maschine aus der Registry installiert und durchgängig nachgewiesen |
| **Mem** | Cursor: dasselbe Gedächtnis, Skills, Review, Übernahme und Self Learning | Veröffentlicht in 1.3. Die Kommandozeile `cursor-agent` wurde auf einer sauberen Linux-Maschine durchgängig getestet. Die Cursor-App auf macOS wird noch geprüft. |
| **Reach** | Sno Reach: Instant Messenger und Agent Email | Lassen Sie Agenten über Gespräche und Computer hinweg Fragen stellen und Arbeit austauschen. Unter [Was Sie mit Reach tun können](../../apps/reach/README.md) stehen Beispiele, die Einrichtung und Angaben zur Verfügbarkeit. |
| **Reach** | Ein Befehl startet zwei Agenten | Neu in 2.0. Mit echten Agenten von Claude Code und Codex gelaufen: mit je einem von beiden und mit zwei vom selben Anbieter. |
| **Reach** | Sehen, wer Sie braucht: Statuszeile, tmux-Leiste, `sno squad` | Neu in 2.0. Mit echten Agenten von Claude Code und Codex gelaufen, die um Erlaubnis baten. Die Statuszeile lief in echtem Claude Code und Cursor. |
| **Reach** | Nachrichten lassen Ihren halb geschriebenen Entwurf unberührt und warten, während ein Agent seinen Kontext komprimiert | Neu in 2.0. Mit echten Agenten von Claude Code und Codex gelaufen. |
| **Finish** | Geplante Aufgaben starten einen Agenten zur genannten Zeit | Neu in 2.0.2. Mit echten Agenten von Claude Code und Codex gelaufen: unter Linux mit offener und geschlossener Unterhaltung, unter macOS in einer neuen Unterhaltung. Siehe die [Finish-Anleitung](../finish.md). |
| **Finish** | Unterbrochene Arbeit geht weiter, und eine Aufgabe übersteht das Komprimieren | Neu in 2.0. Mit echten Agenten von Claude Code und Codex gelaufen. |
| **Learn** | Self Learning und die [Skills für das Team](https://github.com/sno-ai/sno-station-skills) | Von `sno setup` installiert. Der nächtliche Job lief auf einer sauberen Linux-Maschine. |
| **Learn** | Eine freigegebene Lektion wirkt bei der nächsten Antwort | Neu in 2.0. Mit echten Agenten von Claude Code und Codex gelaufen. |
| **Installation** | Installation mit einem Befehl | `sno setup` installiert alles oben Genannte. Auf einer sauberen Linux-Maschine nachgewiesen. |
| **Installation** | „Sno onboard“ in Ihrem Agenten | Verfügbar. Startet nach der Installation oder wenn Sie es sagen. |

Eine Zeile sagt „nachgewiesen“ erst, wenn sie auf einer sauberen Maschine gelaufen ist.

Noch nicht: Die Übernahme von Aufgaben und die Lektionen ab der nächsten Antwort laufen auf Claude Code und Codex. Die Statuszeile gibt es in Claude Code und Cursor. Hermes Agent und OpenClaw haben diese Abläufe auf echten Installationen noch nicht durchlaufen, und OpenClaw erscheint in `sno squad` mit unbekanntem Status.

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
