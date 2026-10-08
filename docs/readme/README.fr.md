# Sno Station 🧊 — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — two terminal agents sharing one memory on your machine](../images/hero-banner.png)

[![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
![status public](https://img.shields.io/badge/status-public-2dd4bf.svg?labelColor=3b3b3b)
![runs on your laptop, no daemon](https://img.shields.io/badge/runs%20on-your%20laptop%2C%20no%20daemon-3b82f6.svg?labelColor=3b3b3b)
![harnesses Claude Code, Codex, OpenClaw](https://img.shields.io/badge/harnesses-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenClaw-f0a04b.svg?labelColor=3b3b3b)

**Lire dans d'autres langues :** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français** · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

Sno Station est le poste de travail de vos agents : un logiciel open source qui transforme les
agents IA que vous utilisez déjà — agents de codage et agents de travail généralistes — en une
seule équipe sur votre propre machine. Quand l'un d'eux atteint sa limite de débit, l'autre prend
le relais avec le contexte intact. Ils révisent le travail l'un de l'autre, si bien que moins
d'erreurs vous parviennent. Et l'espace de travail qu'ils partagent devient plus intelligent
chaque nuit : il lit leurs sessions, propose des changements à leurs propres compétences, et
attend que vous disiez oui.

**À vous, et ça le reste.** La mémoire, les messages et les compétences vivent dans un seul
espace de travail sur votre ordinateur portable. Pas de démon, pas de serveur, pas de cloud
requis ; le volet cloud, quand il arrivera, sera optionnel et le produit sera complet sans lui.
Apache-2.0, de bout en bout. Le magasin de mémoire est chiffré sur votre machine dès la première
utilisation, avec une clé provisionnée une seule fois et qui ne le quitte jamais ; Sno ne reçoit
jamais votre base de données ni votre clé. Le périmètre complet, ce qu'il protège et ce qu'il ne
protège pas, se trouve dans [docs/security.md](../security.md).

**Fonctionne dans votre langue.** Parlez à vos agents en anglais, chinois (simplifié ou
traditionnel), japonais, coréen, allemand, français, espagnol ou russe ; le moteur de mémoire
enregistre chaque souvenir avec sa langue, le classe par locale, et préserve le texte CJK intact
dans chaque clé et recherche. Les compétences Duo sont écrites pour
être suivies dans la langue que vous utilisez avec votre agent, et ce README est livré en neuf langues.

![How it works: two agents, one shared workspace, three things you get](../images/squad-how-it-works.png)

> **Public.** Ce dépôt est public depuis le 2026-09-18. Tout ce qui est là est réel et fonctionne.
> Chaque bloc ci-dessous indique quand il a été mis à jour pour la dernière fois.

[Installation](#install) · [Comment l'utiliser](#how-to-use) · [Ce qui fonctionne aujourd'hui](#what-runs-today) · [Une mémoire qui oublie exprès](#memory-that-forgets-on-purpose) · [Partenaires de conception](#design-partners) · [Références](#references)

## Installation

*Dernière mise à jour le 2026-10-07.* **La mémoire partagée s'installe dès aujourd'hui.** Elle donne à Claude Code, Codex, OpenClaw et Hermes Agent une mémoire chiffrée sur votre machine, sans compte et sans clé d'API. Lancez une fois la [configuration de la mémoire partagée](../memory-setup.md) (quelques minutes), puis ajoutez votre agent :

```bash
# Install the sno command once
sh -c 'sno_installer_body=$(curl -fsSL https://sno.ai/install) && printf "%s\n" "$sno_installer_body" | sh'
# Codex CLI
sno setup --harness codex
# Claude Code
sno setup --harness claude
# OpenClaw
sno setup --harness openclaw
# Hermes Agent
sno setup --harness hermes
```

Parcours : [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md) · [Hermes](../mem-hermes/onboarding.md)

`sno setup` installe aussi Sno Reach, les petits programmes auxiliaires, les skills et la boucle nocturne, et chaque commande s'écrit `sno <nom>` : la liste complète est dans [docs/sno-commands.md](../sno-commands.md). Dire « Sno onboarding » dans votre agent vous guide dans la même installation en conversation. Il démarre aussi tout seul juste après l'installation.

```bash
# inside any Claude Code, Codex or OpenClaw conversation:
Sno onboarding
```

L'agent exécute lui-même la configuration via le CLI `sno` : la mémoire partagée, Sno Reach, les
compétences Duo, et les hooks dont chaque harness a besoin. Aucun nom de paquet à retenir.

## Comment l'utiliser

*Dernière mise à jour le 2026-09-19.* Une fois installé, vous continuez à travailler exactement comme
avant, dans l'agent de votre choix. Trois choses changent :

1. **L'un d'eux atteint son plafond.** Dites `sno reach call` depuis l'autre ; il reprend la
   tâche depuis la mémoire partagée et la boîte aux lettres, contexte intact.
2. **Vous voulez un second regard.** Demandez à l'un ou l'autre agent de faire un `peer-review` du
   travail de l'autre. Le réviseur vient toujours de l'autre harness.
3. **Chaque nuit, la boucle RSI tourne.** Le matin, `sno rem-reflect accept <id>` pour les propositions
   que vous aimez. Rien ne change sans cet accord.

## « J'ai crié sur mon agent hier soir. Il a pris des notes. »

*À quoi cela ressemble sur notre propre machine. Trois jours, trois rapports. Dernière mise à jour le 2026-09-19.*

**Jour un — il apprend.**

![The nightly loop reporting what it learned and changed, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

C'est un rapport réel de la boucle RSI que nous exécutons sur ce dépôt. Une fois par jour, elle lit nos
propres sessions d'agent, trouve les erreurs qui se répètent, et propose des changements aux fichiers
de compétences des agents eux-mêmes. Un humain lit les propositions et les accepte ou les rejette. Rien
ne change sans cet accord. Les deux choses qui frustraient le propriétaire ce soir-là étaient devenues
des règles dans les compétences actives dès le lendemain matin ; personne ne les a tapées.

**Jour deux — elle vérifie ses propres devoirs.**

![The next morning: the RSI loop measures whether yesterday's own changes helped, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

L'exécution suivante s'est déclenchée d'elle-même à 00h58, a lu 113 sessions, et a mesuré les trois
compétences qu'elle avait changées la veille. Les échecs sont tombés à zéro sur les trois. Elle a
aussi trouvé un vrai bug dans notre script de release que zsh cachait à bash. Personne ne lui a
demandé de chercher.

**Jour trois — vous l'installez.** La boucle RSI est une compétence de ce dépôt, et `sno setup` l'installe avec le reste. Cette section se met à jour au fil des exécutions de la boucle : un nouveau rapport chaque semaine, rien de retouché.

Elle s'inspire de deux travaux auxquels nous revenons sans cesse : le *« LLM Wiki »* d'Andrej
Karpathy — l'idée qu'un agent devrait tenir un wiki persistant et modifiable de ce qu'il a appris
plutôt que de tout redériver à chaque session — et *« WikiSkill »* de Google Research et Virginia
Tech, qui compile l'expérience propre d'un agent en connaissance persistante qui réécrit ses
compétences. Liens dans [Références](#references).

## « En plusieurs mois, l'autre n'a jamais dit une seule fois « ça a l'air bien ». »

Nous faisons réviser le travail de Codex par Claude Code et celui de Claude Code par Codex sur ce
dépôt depuis des mois. Pas une seule révision n'est revenue vide. Pas une seule. Nous pensions que
cela signifiait que le travail était mauvais. Cela signifie qu'un seul réviseur d'un seul harness
n'est jamais suffisant.

Nous appelons la paire un Duo : la plus petite équipe. Nous ne disons jamais lequel est le prudent
et lequel est le rapide. Cela change selon le mois et selon la tâche. L'important, c'est qu'ils diffèrent.

## « Je suis allé me coucher. La relève s'est faite. »

*À quoi cela ressemble sur notre propre machine, le 2026-09-18.*

![La veille de quota descendant jusqu'au seuil toutes les cinq minutes, et la passation déclenchée à 2 %](../evidence/rotation-quota-watch-2026-09-18.png)

L'un de nos agents en était à vingt-et-une tâches sur un build de vingt-sept quand son quota
hebdomadaire est tombé à 2 %. Il ne s'est pas arrêté là pour attendre de mourir. Il a rédigé une
note de passation : ce qui était fait, ce qui était à moitié fait, le commit exact d'où reprendre.
Puis il a réveillé un agent de l'autre harness et ne l'a laissé toucher à rien tant qu'il n'avait
pas mesuré la taille et la somme de contrôle de la note, et ne l'avait pas dit.

Une chose a mal tourné, et c'est la partie qui vaut la lecture. Le receveur a commencé à éditer
avant d'avoir accusé réception de la libération. L'expéditeur l'a repéré, l'a mis en pause, a
réécrit la note, et a libéré de nouveau, proprement. Quatorze minutes et quarante-et-une secondes
après le début de la passation, le second agent travaillait et le premier a signé sa sortie avec
1 % restant. Chaque commit d'avant la passation est intact ; le second agent a repris à la première
tâche non cochée, pas depuis le début. J'ai dormi pendant tout ce temps.

La nuit entière est dans [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/) :
chaque relevé de quota à cinq minutes d'intervalle, les deux versions de la note, les reçus de
disponibilité et de libération, et le résumé des commits. Noms d'hôtes, adresses et identifiants
de session sont caviardés ; rien d'autre n'est touché.

## Ce qui fonctionne aujourd'hui

*Dernière mise à jour le 2026-10-07.*

| Élément | Statut |
|---|---|
| `packages/chunking` | Dans ce dépôt, testé, publié sur npm |
| Paquets partagés (`common-core`, `utils`, `embedder`, `observability`, `sqlite-crypto`, `content-sanitizer`) | Dans ce dépôt |
| Mémoire partagée entre Claude Code, Codex et OpenClaw | Moteur et les trois habillages dans ce dépôt ; preuve sur machine vierge en attente |
| Sno Reach — les agents qui se parlent, sans démon | Installé par `sno setup` ; les archives de version pour Linux et macOS sont publiées ; prouvé de bout en bout sur une machine Linux propre |
| La boucle nocturne et les skills de l'équipe | Installée par `sno setup` ; la tâche nocturne a tourné sur une machine Linux propre |
| Installation en une commande (`sno setup`) | Installe tout ce qui précède ; prouvée sur une machine Linux propre |
| « Sno onboarding » dans votre agent | Disponible ; il démarre après l'installation, ou quand vous le dites |

Une ligne indique « prouvé » seulement une fois qu'elle a tourné sur une machine vierge.

## Une mémoire qui oublie exprès

*Dernière mise à jour le 2026-09-19.*

La mémoire est le socle de ce produit, pas son titre. Mais c'est sur ce socle que la plupart des
mémoires d'agents échouent, et elles échouent de deux façons discrètes : elles oublient ce qui aurait
dû rester, et elles gardent ce qui aurait dû se dégrader. La seconde défaillance est la plus coûteuse.
Un agent qui « se souvient » encore d'une préférence que vous avez annulée, d'une échéance qui a
changé, d'une adresse que vous avez quittée, agira dessus en toute confiance.

Jusqu'à cette année, personne ne mesurait cela. Les benchmarks de mémoire à long terme les plus cités
(LoCoMo, LongMemEval) ne notent que le rappel : le bon fait est-il revenu. Un système qui n'oublie
jamais rien obtient un score parfait sur ces benchmarks. En avril 2026, un groupe de l'Arizona State a
publié **Memora** (Uddin, Shubham, Blanco, Baral, Wang, *From Recall to Forgetting: Benchmarking
Long-Term Memory for Personalized Agents*, [arXiv 2604.20006](https://arxiv.org/abs/2604.20006), ACL 2026 Findings). C'est le
premier benchmark construit autour de la seconde défaillance. Chaque question porte deux types de
vérifications : des faits qui doivent être rappelés, et des faits qui ont été annulés ou remplacés dans
la conversation et qui ne doivent **pas** ressurgir. Sa métrique phare, **FAMA** (Forgetting-Aware
Memory Accuracy), est le rappel moins une pénalité pour chaque fait obsolète sur lequel l'agent
s'appuie encore. La conclusion même de l'article sur les six agents de mémoire testés : « une
réutilisation fréquente de mémoires invalides et des échecs à réconcilier des mémoires évolutives ».

C'est l'examen que la mémoire de Sno Station a été construite pour réussir, et c'est la raison pour
laquelle la mémoire s'améliore elle-même : ce qui est gardé, ce qui est retiré, et comment un fait
ultérieur en remplace un antérieur, tout cela change avec l'usage, pas avec une sortie de modèle.

![Memora weekly track: FAMA and forgetting cost, Sno Station against the paper's six agents](../images/memora-forgetting-cost.png)

**Notre résultat sur le parcours hebdomadaire de l'article** (six personas, quatre-vingt-dix
questions, une exécution formelle, le 2026-09-06 ; [les quatre-vingt-dix réponses, jugements et
traces](../../evals/memora/formal-run-2026-09-06/) sont ici) :

| | Remember | Reason | Recommend | **FAMA** | MPA (rappel seul) | Coût de l'oubli |
|---|---:|---:|---:|---:|---:|---:|
| **Sno Station** | 77.4 | 93.3 | 90.9 | **87.2** | 91.0 | **3.76 pts (4.1% du rappel)** |
| LangMem (paper) | 71.2 | 30.0 | 48.9 | 50.0 | 57.7 | 7.70 (13.3%) |
| Nemori (paper) | 65.1 | 18.7 | 52.8 | 45.5 | 53.1 | 7.60 (14.3%) |
| MemoryOS (paper) | 51.8 | 20.7 | 62.6 | 45.0 | 51.7 | 6.70 (13.0%) |
| MemoBase (paper) | 43.6 | 18.0 | 68.9 | 43.5 | 51.5 | 8.00 (15.5%) |
| A-Mem (paper) | 71.8 | 2.0 | 35.0 | 36.3 | 39.3 | 3.00 (7.6%) |
| Mem-0 (paper) | 40.4 | 16.0 | 52.6 | 36.3 | 39.8 | 3.50 (8.8%) |

Comment le lire, honnêtement :

- Le **coût de l'oubli** est MPA moins FAMA : les points qu'un système perd à cause de faits
  obsolètes. Lisez-le comme une part du rappel propre du système, jamais comme des points bruts.
  A-Mem et Mem-0 perdent moins de points bruts seulement parce qu'ils rappellent si peu qu'il reste
  peu de chose à perdre.
- Le **raisonnement** (combiner plusieurs souvenirs) est le point le plus faible du champ publié, de
  2 à 30 sur 100. Le nôtre est à 93.3.
- Les six agents de l'article ont été notés avec le juge de l'article (GPT-4o-mini) ; les nôtres avec
  notre propre pile de juges, recalculée avec la formule de pénalité par question de l'article (§4.2).
  Comparaison directionnelle, pas certifiée. Notre FAA (part des faits annulés correctement laissés
  de côté) est mesurée à 0.833 ; l'article ne publie pas de FAA par agent, donc aucune FAA de
  concurrent n'est affichée.

Les trois autres ensembles de preuves suivent la même règle : un résultat sélectionné chacun,
avec les réponses ou les enregistrements de récupération dans `evals/` :

| Benchmark | Ce qu'il mesure | Résultat |
|---|---|---|
| **LoCoMo** | QA sur conversation longue, 1542 questions | 96.76% (ensemble de réponses fusionné : les questions encore fausses après chaque correction ont été répondues à nouveau, les déjà correctes ont été reportées ; le reçu le précise) |
| **R@5** sur LongMemEval-S (500 questions) | Récupération : le bon souvenir est-il dans le top cinq | 95.4% (R@10 98.6, R@20 99.4) |
| **Sno Memory Bench** | 23 tests de bout en bout maison, y compris des cas garder-contre-retirer que les benchmarks publics ne couvrent pas | 23 sur 23 |

## Partenaires de conception

Nous travaillons avec une poignée de personnes qui font déjà tourner deux agents ou plus côte
à côte et déplacent les résultats entre eux à la main. Si c'est votre cas, ouvrez un
[design partner issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml) et dites ce que vous utilisez.

## Sécurité

Voir [SECURITY.md](../../SECURITY.md).

## Licence

Apache-2.0. Open source, de bout en bout. Voir [LICENSE](../../LICENSE).

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
