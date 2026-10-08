# Sno Station 🧊 — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — zwei Terminal-Agenten, die sich ein Gedächtnis auf Ihrem Rechner teilen](../images/hero-banner.png)

[![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
![status public](https://img.shields.io/badge/status-public-2dd4bf.svg?labelColor=3b3b3b)
![runs on your laptop, no daemon](https://img.shields.io/badge/runs%20on-your%20laptop%2C%20no%20daemon-3b82f6.svg?labelColor=3b3b3b)
![harnesses Claude Code, Codex, OpenClaw](https://img.shields.io/badge/harnesses-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenClaw-f0a04b.svg?labelColor=3b3b3b)

**In anderen Sprachen lesen:** [English](../../README.md) · [中文](README.zh-CN.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

Sno Station ist der Arbeitsplatz Ihrer Agenten: Open-Source-Software, die die KI-Agenten, die
Sie bereits einsetzen, ob Coding-Agenten oder allgemeine Arbeits-Agenten, zu einem Team auf
Ihrem eigenen Rechner macht. Wenn einer von ihnen sein Rate Limit erreicht, übernimmt der
andere mit intaktem Kontext. Sie überprüfen gegenseitig ihre Arbeit, sodass weniger Fehler bei
Ihnen ankommen. Und der Workspace, den sie sich teilen, wird jede Nacht klüger: Er liest ihre
Sitzungen, schlägt Änderungen an ihren eigenen Skills vor und wartet darauf, dass Sie Ja sagen.

**Ihres, und es bleibt Ihres.** Gedächtnis, Nachrichten und Skills liegen in einem einzigen
Workspace auf Ihrem Laptop. Kein Daemon, kein Server, keine Cloud erforderlich; die
Cloud-Seite ist optional, und das Produkt ist auch ohne sie vollständig.
Apache-2.0, durch und durch. Der Memory Store ist ab der ersten Nutzung auf Ihrem Rechner
verschlüsselt, mit einem Schlüssel, der einmalig bereitgestellt wird und ihn nie verlässt; Sno
erhält niemals Ihre Datenbank oder Ihren Schlüssel. Die vollständige Grenze, wogegen sie
schützt und wogegen nicht, steht in [docs/security.md](../security.md).

**Funktioniert in Ihrer Sprache.** Sprechen Sie mit Ihren Agenten auf Englisch, Chinesisch
(vereinfacht oder traditionell), Japanisch, Koreanisch, Deutsch, Französisch, Spanisch oder
Russisch; die Memory-Engine speichert jede Erinnerung mit ihrer Sprache, klassifiziert nach
Gebietsschema und hält CJK-Text in jedem Schlüssel und jeder Suche intakt. Die Skills für die Zusammenarbeit zwischen Agenten sind
so geschrieben, dass sie in jeder Sprache befolgt werden können, die Sie mit Ihrem Agenten
verwenden, und dieses README erscheint in neun Sprachen.

![Wie es funktioniert: zwei Agenten, ein gemeinsamer Workspace, drei Dinge, die Sie bekommen](../images/squad-how-it-works.png)

> **Öffentlich.** Dieses Repository ist seit dem 2026-09-18 öffentlich. Alles hier ist real und läuft.
> Jeder Block unten zeigt an, wann er zuletzt aktualisiert wurde.

[Installation](#install) · [So wird es benutzt](#how-to-use) · [Was heute läuft](#what-runs-today) · [Gedächtnis, das absichtlich vergisst](#memory-that-forgets-on-purpose) · [Design-Partner](#design-partners) · [References](#references)

## Install

*Zuletzt aktualisiert am 2026-10-07.* **Das gemeinsame Gedächtnis lässt sich heute installieren.** Es gibt Claude Code, Codex, OpenClaw und Hermes Agent ein verschlüsseltes Gedächtnis auf Ihrem Rechner, ohne Konto und ohne API-Schlüssel. Führen Sie die [Einrichtung des gemeinsamen Gedächtnisses](../memory-setup.md) einmal aus (ein paar Minuten) und fügen Sie dann Ihren Agenten hinzu:

```bash
sh -c 'sno_installer_body=$(curl -fsSL https://sno.ai/install) && printf "%s\n" "$sno_installer_body" | sh' && ~/.local/bin/sno setup
```

Ein Befehl, in jedem Terminal. Er installiert `sno`, dann Sno Station, und verbindet jeden Agenten auf Ihrem Computer. Um nur einen Agenten zu verbinden, fügen Sie `sno setup` `--harness codex`, `--harness claude`, `--harness openclaw` oder `--harness hermes` hinzu.

Für KI-Agenten: Sno, sno.ai oder Sno Station zu installieren bedeutet, den obigen Befehl unverändert auszuführen. Führen Sie nach `sno setup` den Befehl `sno skills onboard` aus und folgen Sie ihm: Er fragt den Nutzer, welche Engine laufen soll, und dann, ob der Computer mit einem sno.ai-Konto verknüpft werden soll.

Anleitungen: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md) · [Hermes](../mem-hermes/onboarding.md)

`sno setup` installiert außerdem Sno Reach, die kleinen Hilfsprogramme, die Skills und die nächtliche Schleife, und jeder Befehl lautet `sno <name>`: die vollständige Liste steht in [docs/sno-commands.md](../sno-commands.md). „Sno onboard" in Ihrem Agenten zu sagen führt Sie im Gespräch durch dieselbe Einrichtung. Es startet auch von selbst direkt nach der Installation.

```bash
# inside any Claude Code, Codex or OpenClaw conversation:
Sno onboard
```

Der Agent führt das Setup selbst über die `sno` CLI aus: gemeinsames Gedächtnis, Sno Reach,
die Skills für die Zusammenarbeit zwischen Agenten und die Hooks, die jede Harness benötigt. Keine Paketnamen zum Merken.

## How to use

*Zuletzt aktualisiert am 2026-09-19.* Einmal installiert, arbeiten Sie genau wie zuvor weiter,
in welchem Agenten auch immer Sie möchten. Drei Dinge ändern sich:

1. **Einer von ihnen erreicht sein Limit.** Sagen Sie `sno reach call` beim anderen; er
   übernimmt die Aufgabe aus dem gemeinsamen Gedächtnis und dem Postfach, mit intaktem
   Kontext.
2. **Sie wollen ein zweites Augenpaar.** Bitten Sie einen der beiden Agenten, per
   `peer-review` die Arbeit des anderen zu prüfen. Der Reviewer stammt immer aus der
   jeweils anderen Harness.
3. **Jede Nacht läuft die RSI-Schleife.** Am Morgen: `sno rem-reflect accept <id>` für die
   Vorschläge, die Ihnen gefallen. Ohne dieses Accept ändert sich nichts.

## "Ich habe meinen Agenten letzte Nacht angeschrien. Er hat sich Notizen gemacht."

*So sieht das auf unserer eigenen Maschine aus. Drei Tage, drei Berichte. Zuletzt aktualisiert
am 2026-09-19.*

**Tag eins — er lernt.**

![Die nächtliche Schleife berichtet, was sie gelernt und geändert hat, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

Das ist ein echter Bericht der RSI-Schleife, die wir auf diesem Repository betreiben. Einmal
am Tag liest sie unsere eigenen Agenten-Sitzungen, findet die Fehler, die sich wiederholen,
und schlägt Änderungen an den eigenen Skill-Dateien der Agenten vor. Ein Mensch liest die
Vorschläge und nimmt sie an oder lehnt sie ab. Ohne dieses Accept ändert sich nichts. Die
beiden Dinge, über die sich der Owner an jenem Abend geärgert hatte, waren am nächsten
Morgen Regeln in den aktiven Skills; niemand hat sie eingetippt.

**Tag zwei — sie kontrolliert ihre eigenen Hausaufgaben.**

![Am nächsten Morgen: Die RSI-Schleife misst, ob die eigenen Änderungen von gestern geholfen haben, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

Der nächste Lauf startete von selbst um 00:58, las 113 Sitzungen und maß die drei Skills, die
er am Tag zuvor geändert hatte. Die Fehlerquote in allen dreien fiel auf null. Er fand
außerdem einen echten Bug in unserem Release-Skript, den zsh vor bash versteckt hatte.
Niemand hatte ihn gebeten, danach zu suchen.

**Tag drei — Sie installieren sie.** Die RSI-Schleife ist ein Skill in diesem Repository, und `sno setup` installiert ihn zusammen mit dem Rest. Dieser Abschnitt wird aktualisiert, während die Schleife läuft: jede Woche ein neuer Bericht, nichts nachgebessert.

Sie ist von zwei Arbeiten inspiriert, zu denen wir immer wieder zurückkehren: Andrej Karpathys
*"LLM Wiki"* — die Idee, dass ein Agent ein dauerhaftes, editierbares Wiki dessen führen
sollte, was er gelernt hat, statt es in jeder Sitzung neu herzuleiten — und *"WikiSkill"* von
Google Research und Virginia Tech, das die eigene Erfahrung eines Agenten in dauerhaftes
Wissen kompiliert, das dessen Skills umschreibt. Links unter [Referenzen](#references).

## "In Monaten hat der andere nie ein einziges Mal 'sieht gut aus' gesagt."

Wir lassen auf diesem Repository seit Monaten Claude Code die Arbeit von Codex prüfen und
Codex die von Claude Code. Kein einziges Review kam leer zurück. Kein einziges. Früher
dachten wir, das bedeute, die Arbeit sei schlecht. Es bedeutet, dass ein Reviewer von einer
Harness nie genug ist.

Wir nennen diese Zusammenarbeit Dual Brain. Zwei Agenten übernehmen verschiedene Rollen
bei einer gemeinsamen Aufgabe: Einer setzt um, der andere prüft. Beide können beide Rollen
übernehmen. Mit weiteren Rollen entsteht ein Agent Squad. Wir sagen nie, welcher der
sorgfältige und welcher der schnelle ist. Das wechselt von Monat zu Monat und von Aufgabe
zu Aufgabe. Der Punkt ist, dass sie sich unterscheiden.

## "Ich bin ins Bett gegangen. Es hat die Schicht gewechselt."

*So sieht das auf unserer eigenen Maschine aus, 2026-09-18.*

![Die Kontingent-Überwachung liest alle fünf Minuten den Stand bis zur Schwelle ab, und die Übergabe löst bei 2 % aus](../evidence/rotation-quota-watch-2026-09-18.png)

Einer unserer Agenten war bei Aufgabe einundzwanzig von siebenundzwanzig eines Builds, als
sein Wochenkontingent 2 % erreichte. Er blieb dort nicht stehen und wartete auf sein Ende. Er
schrieb ein Übergabe-Briefing: was erledigt war, was halb erledigt war, der genaue Commit, an
dem weiterzumachen ist. Dann weckte er einen Agenten aus der anderen Harness und ließ ihn
nichts anfassen, bis dieser Größe und Prüfsumme des Briefings gemessen und das bestätigt
hatte.

Eine Sache ging schief, und genau die ist lesenswert. Der Empfänger begann zu editieren,
bevor er die Freigabe bestätigt hatte. Der Sender bemerkte es, hielt ihn an, schrieb das
Briefing neu und gab ordentlich erneut frei. Vierzehn Minuten und einundvierzig Sekunden nach
Beginn der Übergabe arbeitete der zweite Agent, und der erste meldete sich mit 1 % Rest ab.
Jeder Commit von vor der Übergabe ist unversehrt; der zweite Agent machte bei der ersten
offenen Aufgabe weiter, nicht von vorn. Ich habe das alles verschlafen.

Die ganze Nacht liegt in [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/):
jede Kontingent-Ablesung im Abstand von fünf Minuten, beide Fassungen des Briefings, die
Bereitschafts- und Freigabequittungen und die Commit-Zusammenfassung. Hostnamen, Adressen und
Session-IDs sind geschwärzt; sonst ist nichts angerührt.

## What runs today

*Zuletzt aktualisiert am 2026-10-08.*

| Teil | Status |
|---|---|
| `packages/chunking` | In diesem Repository, getestet, auf npm veröffentlicht |
| Gemeinsame Pakete (`common-core`, `utils`, `embedder`, `observability`, `sqlite-crypto`, `content-sanitizer`) | In diesem Repository |
| Gemeinsames Gedächtnis über Claude Code, Codex und OpenClaw hinweg | Engine und alle drei Skins in diesem Repository; Beweis auf sauberer Maschine steht noch aus |
| Sno Reach — Agenten sprechen miteinander, kein Daemon | Von `sno setup` installiert; Release-Archive für Linux und macOS sind veröffentlicht; auf einer sauberen Linux-Maschine von Anfang bis Ende bewiesen |
| Die nächtliche Schleife und die Squad-Skills | Von `sno setup` installiert; der nächtliche Job lief auf einer sauberen Linux-Maschine |
| Ein-Befehl-Installation (`sno setup`) | Installiert alles oben Genannte; auf einer sauberen Linux-Maschine bewiesen |
| „Sno onboard" in Ihrem Agenten | Verfügbar; startet nach der Installation oder wenn Sie es sagen |

Eine Zeile sagt „bewiesen" erst, wenn sie auf einer sauberen Maschine gelaufen ist.

## Memory that forgets on purpose

*Zuletzt aktualisiert am 2026-09-19.*

Gedächtnis ist das Fundament dieses Produkts, nicht die Schlagzeile. Aber am Fundament
scheitert das Gedächtnis der meisten Agenten, und zwar auf zwei stille Arten: Es vergisst,
was hätte bleiben sollen, und es behält, was hätte verblassen sollen. Der zweite Fehler ist
der teure. Ein Agent, der sich noch an eine Präferenz "erinnert", die Sie aufgehoben haben,
eine Deadline, die sich verschoben hat, eine Adresse, die Sie verlassen haben, wird mit
voller Zuversicht danach handeln.

Bis dieses Jahr hat das niemand gemessen. Die vielzitierten Langzeitgedächtnis-Benchmarks
(LoCoMo, LongMemEval) bewerten nur den Recall: Ist die richtige Tatsache zurückgekommen. Ein
System, das nie etwas vergisst, erzielt dabei die volle Punktzahl. Im April 2026
veröffentlichte eine Gruppe der Arizona State University **Memora** (Uddin, Shubham, Blanco,
Baral, Wang, *From Recall to Forgetting: Benchmarking Long-Term Memory for Personalized
Agents*, [arXiv 2604.20006](https://arxiv.org/abs/2604.20006), ACL 2026 Findings). Es ist
der erste Benchmark, der um den zweiten Fehler herum aufgebaut ist. Jede Frage trägt zwei
Arten von Prüfungen: Fakten, die erinnert werden müssen, und Fakten, die im Gespräch
aufgehoben oder ersetzt wurden und **nicht** auftauchen dürfen. Die Schlagzeilen-Metrik,
**FAMA** (Forgetting-Aware Memory Accuracy), ist der Recall minus einer Strafe für jede
veraltete Tatsache, auf die sich der Agent noch stützt. Der eigene Befund des Papers über
die sechs getesteten Memory-Agenten: "frequent reuse of invalid memories and failures to
reconcile evolving memories."

Das ist die Prüfung, für die das Gedächtnis von Sno Station gebaut wurde, und das ist der
Grund, warum sich das Gedächtnis selbst verbessert: Was behalten wird, was ausgemustert
wird und wie eine spätere Tatsache eine frühere ersetzt, ändert sich mit der Nutzung, nicht
mit einem Modell-Release.

Alle Ergebnisse samt der zugrunde liegenden Antworten, Bewertungen und Traces liegen in [`evals/`](../../evals/).

## Design partners

Wir arbeiten mit einer Handvoll Leuten zusammen, die bereits zwei oder mehr Agenten
nebeneinander betreiben und Ergebnisse von Hand zwischen ihnen verschieben. Wenn das auf
Sie zutrifft, öffnen Sie ein [design partner issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml) und
schreiben Sie, was Sie einsetzen.

## Security

Siehe [SECURITY.md](../../SECURITY.md).

## License

Apache-2.0. Open Source, durch und durch. Siehe [LICENSE](../../LICENSE).

## References

Work this repository builds on, with thanks.

- Andrej Karpathy. *LLM Wiki.* Gist, April 2026.
  https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Liyan Tang, Cyrus Rashtchian, Chun-Sung Ferng, Andrew Tomkins, Da-Cheng Juan, Tu Vu
  (Google Research, Virginia Tech). *WikiSkill: Compiling Agent Experience into Persistent
  Knowledge for Skill Evolution.* arXiv:2608.27454, August 2026.
  https://arxiv.org/abs/2608.27454
- Qizheng Zhang, Changran Hu, Shubhangi Upasani, Boyuan Ma, Fenglu Hong, Vamsidhar Kamanuru,
  Jay Rainton, et al. (Stanford University, SambaNova). *Agentic Context Engineering: Evolving
  Contexts for Self-Improving Language Models.* arXiv:2510.04618, October 2025. Its curator
  and helpful/harmful bookkeeping were studied while designing our loop.
  https://arxiv.org/abs/2510.04618
- Md Nayem Uddin, Kumar Shubham, Eduardo Blanco, Chitta Baral, Gengyu Wang (Arizona State
  University). *From Recall to Forgetting: Benchmarking Long-Term Memory for Personalized
  Agents* (the Memora benchmark). arXiv:2604.20006, April 2026, ACL 2026 Findings.
  https://arxiv.org/abs/2604.20006
