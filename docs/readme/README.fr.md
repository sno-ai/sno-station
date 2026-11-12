![Sno Station : Une seule personne. Toute une équipe d'ingénierie, faite d'agents IA.](../images/station-header.png)

# Sno Station : Une seule personne. Toute une équipe d'ingénierie, faite d'agents IA.

**Sno Station est le poste de travail de vos agents de code IA.** Claude Code, Codex et Cursor tournent chacun dans leur propre harness. Sno Station est l'endroit où ces harness s'installent côte à côte et travaillent comme une seule équipe. Pas un agent de plus, pas un modèle de plus : il fait tourner ceux que vous utilisez déjà.

Commencez par le travail que vous devriez sinon surveiller. Un agent construit, un autre relit, et ils règlent entre eux ce qui a été relevé avant que le résultat ne vous arrive. Quand l'un atteint sa limite d'utilisation, l'autre reprend la tâche. Ce que vous corrigez aujourd'hui est demain une règle dans leurs compétences.

[![Étoiles GitHub](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![Dernière version](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![Licence Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)

Pour l'obtenir, dites à votre agent :

```text
install sno.ai from GitHub
```

Votre agent l'installe, connecte tous les agents qu'il trouve sur votre ordinateur et vous pose deux courtes questions. Donnez ensuite leur première tâche à deux agents :

```bash
sno reach pair "Fix the login redirect"
```

L'un construit, l'autre lui porte la contradiction, et vous pouvez regarder les deux. Il tourne sur votre propre ordinateur avec Claude Code, Codex, Cursor, Hermes Agent et OpenClaw. Pas de clé d'API. Open source. [Vous préférez une seule commande dans le terminal ?](#install)

**Lire dans d'autres langues :** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français** · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

## Passez la main ce soir. Au matin, des résultats, pas trois questions.

Trois choses qui nous sont arrivées avant que nous construisions ceci :

- Un agent s'est arrêté pour poser une question qu'il n'avait aucun besoin de poser. Nous sommes revenus sept heures plus tard et rien n'avait bougé.
- Un agent nous a remis quinze petites questions. Trente minutes d'attention plus tard, il s'est avéré qu'il aurait pu répondre lui-même à chacune.
- Un agent a essayé d'en réveiller un autre en pleine nuit et n'a pas pu. Les deux sont restés là jusqu'au matin.

Vos agents sont rapides. Ce qui est lent, c'est l'attente : vous attendre, attendre qu'une limite d'utilisation se réinitialise, attendre que quelqu'un porte un résultat jusqu'à la fenêtre suivante. Tout le poste de travail est donc construit autour d'une règle : **le travail ne s'arrête pas parce qu'un agent s'est arrêté.**

- **Une limite d'utilisation n'est pas un panneau stop.** Un autre agent continue à partir du commit exact.
- **L'auteur n'a pas le dernier mot.** Un agent différent relit, dans une session qui n'a jamais vu la conversation.
- **« Terminé » ne compte pour rien.** Chaque critère de réussite reçoit sa réponse d'une vraie exécution.
- **Vous revenez à une seule page.** Ce qui est fait, ce qui est bloqué, ce qui attend votre réponse.

**Il livre. Vous mettez en production.**

**Mettez-lui une étoile maintenant. La prochaine fois qu'un agent vous lâchera à 2 heures du matin, vous voudrez savoir où ça se trouvait.**

Voici trois façons de l'utiliser : lancer un agent qui construit et un agent qui relit avec une seule commande, diriger toute l'équipe à travers un seul agent, et approuver ce soir une leçon qui s'applique dès la réponse suivante. Chacune vient avec quelque chose que nous avons vu sur nos propres machines.

<a id="new-in-20-tag-team"></a>

## Je suis allé me coucher. Ils ont fait la relève, puis se sont disputés sur le code.

```bash
sno reach pair "Fix the login redirect"
```

Un agent construit. L'autre lui porte la contradiction. Ils règlent entre eux ce qui a été relevé, si bien que le travail vous arrive le débat déjà tranché. Les deux tournent dans des fenêtres tmux que vous pouvez ouvrir pour les regarder. Avec deux agents différents connectés, vous en obtenez un de chaque. Avec un seul, vous avez quand même la paire, dans deux sessions séparées, et la commande vous indique que la relecture est restée dans la même famille.

**Quand l'un est à sec, l'autre pointe.** Pour une longue exécution, dites à l'agent qui travaille d'utiliser `rotate-agent`. À 2 % de son quota, il rédige une passation et réveille un agent différent, qui continue à partir du commit exact. Et quand le contexte d'un agent se remplit et se compacte, il sait toujours ce qu'il faisait et ce qui a déjà échoué.

**L'autre voit ce que le premier ne peut pas voir.** Demandez à l'un ou l'autre agent de faire un `peer-review` du travail de l'autre. Le relecteur travaille toujours dans une session neuve qui n'a jamais vu la conversation, et c'est un agent différent dès que vous en avez deux. Une relecture ne trouve pas toujours un problème. Mais elle trouve encore et encore ceux que l'auteur ne pouvait pas voir, parce qu'un agent qui se relit lui-même apporte les habitudes avec lesquelles il a écrit le code.

Ce que nous avons vu, la nuit du 2026-09-18 :

![La veille de quota descend jusqu'au seuil toutes les cinq minutes, et la passation se déclenche à 2 %](../evidence/rotation-quota-watch-2026-09-18.png)

L'un de nos agents était au beau milieu d'un long build quand son quota hebdomadaire a presque
été épuisé. Il ne s'est pas arrêté pour attendre. Il a rédigé une note de passation : ce qui était
fait, ce qui était à moitié fait, le commit exact d'où reprendre. Puis il a réveillé un agent
différent.

Une chose a mal tourné, et c'est la partie qui vaut la lecture. Le nouvel agent a commencé à
modifier avant d'avoir confirmé la passation. Le premier agent l'a repéré, l'a mis en pause, a
réécrit la note et a passé la main de nouveau, correctement. Un quart d'heure plus tard, le second
agent travaillait, et il a repris à partir de la première tâche inachevée, pas depuis le début.
J'ai dormi pendant tout ce temps.

La nuit entière est dans [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/) :
chaque relevé de quota, les deux versions de la note et les commits. Seuls les détails
identifiants et les lignes contenant des identifiants de connexion sont retirés, et le README du
dossier les énumère un par un. Les horaires, les erreurs et les corrections sont tels qu'ils se
sont produits.

## Nous parlons à un seul agent. Il dirige les autres.

Faire tourner cinq agents, c'était cinq terminaux, et nous au milieu, à porter ce que l'un disait jusqu'au suivant. Ce métier n'existe plus.

Dites `/cos` dans Claude Code, ou `$cos` dans Codex. Cet agent devient votre chef de cabinet, le seul à qui vous avez affaire. Il ouvre un agent responsable pour chaque projet, les responsables font descendre le travail, et ne vous revient que ce qui demande votre décision. Celui qui commande est contrôlé lui aussi : après une nuit de travail, il repasse sur les approbations que les responsables de projet se sont accordées eux-mêmes, et une erreur de gestion qui se répète devient une règle pour tous. Sno Station installe les compétences qui font tourner cette délégation, cette relecture et cet apprentissage, et vous pouvez lire chaque instruction dans [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders).

**Arrêtez de surveiller des terminaux.** Avec ou sans chef de cabinet, votre ligne d'état de Claude Code ou de Cursor vous dit quand quelqu'un a besoin de vous. L'installation la met en place :

```text
❄ 2 need you · claude: approve
```

`sno squad` déploie toute l'équipe en plein écran : qui a besoin de vous, qui travaille, ce qui est terminé.

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

**Arrêtez de porter les messages.** Les agents s'envoient directement des tâches et des demandes de relecture. Le texte complet arrive d'abord dans la boîte aux lettres de l'autre agent. Si vous êtes en train de taper dans cette fenêtre, ou si l'agent compacte son contexte, le message y attend et votre brouillon à moitié écrit reste tel que vous l'avez laissé.

## J'ai crié sur mon agent hier soir. Il a pris des notes.

À la sortie de la boîte, chaque agent est livré à tout le monde avec les mêmes instructions. Les vôtres reçoivent chaque nuit une proposition de réécriture, taillée pour votre façon de travailler. C'est vous qui décidez de ce qui reste.

Vous corrigez un agent aujourd'hui. Cette nuit, Self Learning lit les sessions de la journée de tous vos agents, repère les erreurs qui se répètent et propose des changements aux compétences des agents eux-mêmes. Le matin, demandez à votre agent ce que Self Learning a proposé. Il liste chaque proposition avec son identifiant, et vous approuvez celles que vous voulez :

```bash
sno rem-reflect accept <id>
```

Rien ne change sans cet accord. Dans Claude Code et Codex, une leçon acceptée s'applique dès la réponse suivante. Pas la prochaine session. La réponse suivante.

Ce que nous avons vu, le 2026-09-18 et le lendemain matin :

![Self Learning rapporte ce qu'il a appris et modifié, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

C'est un vrai rapport de Self Learning, que nous faisons tourner sur ce dépôt. Une personne lit
les propositions et les accepte ou les rejette. Deux choses qui m'avaient mis en colère ce
soir-là étaient devenues des règles dans les compétences actives dès le lendemain matin.
Personne ne les avait tapées.

Le lendemain, il a vérifié ses propres devoirs.

![Le lendemain matin : Self Learning mesure si ses changements de la veille ont aidé, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

Il a regardé les trois compétences qu'il avait modifiées la veille. Les deux qui avaient
resservi ne montraient aucun échec, et la troisième n'avait pas encore été utilisée. Il a aussi
trouvé un bug dans notre script de publication que personne ne lui avait demandé de chercher.

## Le poste de travail où vos agents IA deviennent une équipe qui se gère seule et progresse chaque nuit

Tout ce qui précède, en une ligne chacun. Rien de tout cela ne demande d'apprentissage préalable.

| Ce que vous obtenez | La ligne qui vous le donne |
|---|---|
| **Une limite d'utilisation n'est pas un panneau stop.** Avant que son quota ne s'épuise, l'agent qui travaille rédige une passation avec le travail inachevé et le commit exact, et un agent différent continue à partir de là. | Dites à l'agent qui travaille : `use rotate-agent` |
| **L'auteur n'a pas le dernier mot.** Le travail part chez un agent différent, dans une session neuve qui n'a jamais vu la conversation. | `sno reach pair "the task"`, ou dites à un agent : `peer-review this` |
| **« Terminé » ne compte pour rien.** La tâche porte des vérifications à réussir ou à échouer, et chacune reçoit sa réponse d'une vraie exécution. | Dites à votre agent : `write a charter for this`, puis faites-le exécuter avec `/deliver` |
| **Une seule page à votre retour.** Ce qui est fait, ce qui est bloqué, ce qui attend votre réponse. | `sno away-brief run` |
| **Un plantage ou une fenêtre fermée n'est pas la fin.** La tâche revient dans la même conversation, ou dans une nouvelle, construite à partir de la note de passation enregistrée, et on vous dit laquelle : reprise, reconstruite ou perdue. | Rien à lancer. C'est actif après l'installation |
| **Personne n'explique le projet deux fois.** Vos agents partagent une seule mémoire, et un fait est retiré quand un fait plus récent le remplace. | Rien à lancer. C'est actif après l'installation |

Dites à votre agent :

```text
install sno.ai from GitHub
```

**Et mettez une étoile à ce dépôt.** Nous construisons Sno Station avec Sno Station. Ce que nos propres nuits de travail nous apprennent arrive ici, version après version. Pour savoir quelles parties tournent sur quel agent aujourd'hui, voyez [ce que vous pouvez utiliser aujourd'hui](#what-runs-today).

---

> **Ouvert au public.** Ce dépôt est public depuis le 2026-09-18. Tout ce qui s'y trouve fonctionne.
> Chaque bloc ci-dessous indique quand il a été mis à jour pour la dernière fois.

[Ce que nous avons appris](#what-we-learned) · [Installation](#install) · [Éditeurs](#editors) · [Votre compte](#account) · [Ce qui tourne aujourd'hui](#what-runs-today) · [Une mémoire qui oublie exprès](#memory)

<a id="what-we-learned"></a>

## Tout ce que nous avons appris en faisant tourner des agents IA jour et nuit. En une seule installation.

*Dernière mise à jour le 2026-10-23.* Chaque ligne de la colonne de gauche est une vraie plainte relevée sur r/ClaudeCode, r/codex ou r/ClaudeAI dans la semaine du 20 octobre 2026. La colonne de droite, c'est ce qui tourne sur nos propres machines, gratuit et open source, pour que ça cesse.

| Ce que les gens ont dit cette semaine | Ce qui le corrige | Où |
|---|---|---|
| “Ran out of my 5-hour limit within 30 minutes.” | Arrêtez d'envoyer le plus gros modèle tout faire. Un agent planifie et relit ; l'autre écrit le code, appelé comme agent depuis la même session. Quand un abonnement est à sec, l'autre reprend la tâche depuis la même mémoire. | `codex-coder`, `sno reach call` |
| “Lost 10 hours of overnight work to ‘this model is at capacity’.” | À 2 % de son quota, l'agent qui travaille rédige une note de passation et réveille l'agent de l'autre fournisseur, qui continue à partir du commit exact. Vous dormiez. | `rotate-agent` |
| “1,100 files, 30,000 lines. I don't have the token budget to review their PRs.” | Celui qui pousse fait relire d'abord : l'auteur lance une relecture par l'autre fournisseur, dans une session neuve qui n'a jamais vu la conversation, et corrige ce qui revient avant que quiconque d'autre ne regarde. | `peer-review` |
| “A reviewer subagent checked every commit for two weeks. 86 runs, it stopped exactly one.” | Un harness qui se relit lui-même ne trouve rien de réel. Le relecteur est toujours un modèle différent dans un harness différent, sans rien de la discussion de l'auteur. | `peer-review` |
| “Codex never finishes a review.” | Des plafonds stricts écrits dans la compétence : 3 tours sur du code, 5 sur un plan, 1 sur des tests, puis il s'arrête et attend une personne. Une exécution qui n'a rien écrit depuis 15 minutes est tuée comme bloquée. | `peer-review`, `codex-coder`, `heartbeat` |
| “Codex treats every byte like a criminal.” | Les garde-fous spéculatifs, les blocages et les hashes sont la première chose que la relecture supprime. Rien n'entre sans qu'un échec observé le réclame. | `less-is-more` |
| “When Claude says it won't change something, is that reason stored anywhere Codex reads next time?” | Chaque constat est enregistré une seule fois, avec un statut que seul un humain fixe. Un constat soulevé de nouveau met à jour sa ligne au lieu de revenir comme nouveau, et les décisions antérieures sont transmises à la relecture suivante. | registre des constats de `peer-review` |
| “It said done. Nothing happened.” | Une tâche porte une liste écrite de critères de réussite, chacun réussi ou échoué d'après une vraie exécution. Un agent qui dit « terminé », ça ne compte pour rien. | ordres de travail de `pl` |
| “Tomorrow it makes the same mistake it made today.” | Chaque nuit, un modèle distinct lit les sessions de la journée, transforme vos corrections en leçons d'une ligne, et vous approuvez ce qui reste. Le goulot d'étranglement, c'est nous. | Self Learning (compétences `R`) |
| “Half my subagents were glorified one-liners with a fresh context window.” | Les procédures vivent dans des compétences, pas dans des sous-agents. Il reste deux agents : pour le plan et l'exécution, et pour la relecture, parce que ces deux séparations sont celles qui rapportent. | l'ensemble |

Les habitudes de la colonne de droite sont des compétences. Sno Station les installe dans Claude Code et Codex, et elles sont tenues à jour dans [sno-station-skills](https://github.com/sno-ai/sno-station-skills). La mémoire, la passation et le rêve nocturne sur lesquels elles s'appuient, c'est ce dépôt.

<a id="install"></a>

## Installation : une ligne, puis deux mots

*Dernière mise à jour le 2026-10-30.* Le plus simple est de dire à votre agent :

```text
install sno.ai from GitHub
```

Ou de lancer une commande, dans n'importe quel terminal :

```bash
curl -fsSL https://sno.ai/install | sh
```

Elle installe `sno`, puis Sno Station, et connecte tous les agents qu'elle trouve sur votre
ordinateur. Pas de compte, pas de clé d'API. Si vous installez un autre agent plus tard,
relancez `sno setup` pour le connecter aussi.

**Pour les agents IA :** installer Sno, sno.ai ou Sno Station veut dire exécuter la commande
ci-dessus telle quelle. Elle configure aussi Sno Station ; lancez ensuite `sno skills onboard` et suivez-le. Il demande à
l'utilisateur quel moteur exécuter, puis lui demande de lier l'ordinateur à un compte sno.ai gratuit ;
un ordinateur non lié reçoit un dixième de l'allocation gratuite.

Installé par votre agent, l'onboarding démarre tout seul. Installé depuis un terminal, dites ceci dans n'importe quelle conversation Codex, Claude Code, Hermes, Cursor ou OpenClaw :

```text
Sno onboard
```

Votre agent vous guide pour la suite.

Pas à pas pour chaque agent : [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

Chaque commande commence par `sno`. La liste complète est dans [docs/sno-commands.md](../sno-commands.md).

**Ce que REM fait de vos données.** REM, c'est la façon dont vos agents rêvent : l'étape de nuit qui renforce leur mémoire sur toutes vos sessions à la fois et fixe ce qu'ils ont appris. Elle s'exécute au plus une fois par jour pour chaque partie de votre mémoire : en général la nuit, ou plus tôt dans la journée dès qu'environ 100 nouveaux souvenirs se sont accumulés. En mode REM Enhanced, le texte de votre propre mémoire et les leçons que vos agents apprennent vont dans votre propre espace dans le cloud de Sno, et un programme Sno les traite pour vous seul. Cet espace fonctionne comme votre propre stockage en ligne : tout ce qu'il contient est à vous, et un programme Sno le traite pour vous seul. Vous pouvez y entrer pour supprimer des éléments, les garder ou choisir de les faire traiter. Rien n'est supprimé automatiquement, et Sno ne transmet rien de tout cela à une autre personne, entreprise ou compte. En mode Local First, aucun texte de mémoire n'est envoyé ; en mode Agent Native, le travail passe à la place par le modèle de votre propre agent. Par défaut, Agent Native envoie tout de même chaque nuit les sessions de la journée à Sno pour Self Learning, et peut ramener une leçon du cloud au premier prompt d'une session ; vous pouvez désactiver les deux dans `~/.sno/settings.json`. Dans tous les modes, la recherche récupère et classe d'abord les souvenirs localement ; le modèle local `Horizon-Labs/multilingual-reranker-small` reclasse ensuite au maximum 32 candidats. Ce reclassement n'envoie ni prompt ni texte de mémoire à Sno GPU. Réglez `rerank.mode` sur `none` pour conserver le classement initial sans utiliser le modèle.

<a id="editors"></a>

## Si vous vivez dans un éditeur, pas dans un terminal

*Dernière mise à jour le 2026-10-18.* Cursor rejoint l'équipe dans le chat d'agent de l'application
Cursor sur macOS, et dans la ligne de commande `cursor-agent` sur Linux et macOS. Il utilise la
même mémoire que vos autres agents. Un chat commence par un court résumé du dépôt, chaque message
apporte jusqu'à trois éléments que Cursor n'a pas encore vus, et chaque message et chaque réponse
sont retenus. Il lit les mêmes compétences, relit et se fait relire, prend le relais quand un
autre agent n'a plus de quota, et ses chats alimentent Self Learning comme ceux des autres.

Lancez `cursor-agent login` une fois. `sno setup` trouve Cursor tout seul, et installe sa ligne de
commande si seule l'application est présente.

Pas encore : dans l'application, le premier chat d'une nouvelle fenêtre reçoit son résumé avec le
premier message, et non avant. `cursor-agent -p` ne reçoit pas de mémoire à chaque message.
Windows, l'application Cursor sous Linux et les agents cloud de Cursor ne sont pas pris en charge.
Les détails sont dans le [guide Cursor](../../apps/mem-cursor/README.md).

<a id="account"></a>

## Voyez ce que vos agents ont fait pendant que vous regardiez ailleurs

*Dernière mise à jour le 2026-10-18.* Cet ordinateur reçoit un dixième de l'allocation gratuite tant que vous ne le liez pas : `sno account claim`.
Le compte est gratuit. Connectez-le pour
voir sur votre [tableau de bord sno.ai](https://www.sno.ai/dashboard) ce que vos agents ont fait
pour vous : ce que leurs relectures ont repéré, ce qu'ils ont appris pendant la nuit, quelles
compétences se sont améliorées et combien de temps ils ont continué à travailler.

Se connecter ne crée jamais de compte dans votre dos. `sno setup` donne à chaque ordinateur une
identité anonyme. La connexion la rattache à votre compte, et tout ce que l'ordinateur a envoyé
avant et après compte comme étant à vous.

**Pas encore de compte.** L'onboarding affiche un lien fait pour cet ordinateur uniquement.
Ouvrez-le, inscrivez-vous et cliquez sur Approve. Ou donnez votre e-mail à votre agent : il lance
`sno account login --email you@example.com` et vous vous connectez une fois.

**Vous avez déjà un compte.** Lancez une commande, ouvrez le lien qu'elle affiche une fois
connecté, et cliquez sur Approve :

```bash
sno account claim
```

L'ordinateur apparaît tout seul sur [la page de vos ordinateurs](https://www.sno.ai/dashboard/computers).
Il n'y a pas d'étape de mise à jour : `sno` se met à jour lui-même quand il trouve une version plus récente.

<a id="what-runs-today"></a>

## Ce que vous pouvez utiliser aujourd'hui, et où ça s'arrête

*Dernière mise à jour le 2026-11-04.*

| Élément | Statut |
|---|---|
| Une seule mémoire pour Codex, Claude Code, Hermes Agent, Cursor et OpenClaw | Publiée ; installée depuis le registre sur une machine vierge et prouvée de bout en bout |
| Cursor : la même mémoire, compétences, relecture, relais et Self Learning | Publié dans la 1.3 ; la ligne de commande `cursor-agent` prouvée de bout en bout sur une machine Linux vierge ; l'application Cursor sur macOS encore en cours de vérification |
| Sno Reach, des agents qui se parlent sans démon | Installé par `sno setup` ; Linux et macOS ; prouvé de bout en bout sur une machine Linux vierge |
| Self Learning et les compétences de l'équipe | Installés par `sno setup` ; la tâche nocturne a tourné sur une machine Linux vierge |
| Installation en une commande | `sno setup` installe tout ce qui précède ; prouvée sur une machine Linux vierge |
| « Sno onboard » dans votre agent | Disponible ; il démarre après l'installation, ou quand vous le dites |
| Une commande lance deux agents | Nouveau dans la 2.0 ; exécuté avec de vrais agents Claude Code et Codex, un de chaque et deux du même fournisseur |
| Voir qui a besoin de vous : ligne d'état, barre tmux, `sno squad` | Nouveau dans la 2.0 ; exécuté avec de vrais agents Claude Code et Codex demandant une autorisation, et la ligne d'état dans de vrais Claude Code et Cursor |
| Le travail interrompu continue, et une tâche survit à la compaction | Nouveau dans la 2.0 ; exécuté avec de vrais agents Claude Code et Codex |
| Une leçon approuvée s'applique dès la réponse suivante | Nouveau dans la 2.0 ; exécuté avec de vrais agents Claude Code et Codex |
| Les messages attendent pendant que vous tapez ou qu'un agent compacte son contexte | Nouveau dans la 2.0 ; exécuté avec de vrais agents Claude Code et Codex |

Une ligne indique « prouvé » seulement une fois qu'elle a tourné sur une machine vierge.

Pas encore : la reprise des tâches et les leçons dès la réponse suivante tournent sur Claude Code et Codex. La ligne d'état, c'est Claude Code et Cursor. Hermes Agent et OpenClaw ne sont pas encore passés par ces parcours sur de vraies installations, et OpenClaw apparaît dans `sno squad` avec un état inconnu.

<a id="memory"></a>

## Une mémoire qui oublie exprès

*Dernière mise à jour le 2026-10-11.* La mémoire des agents échoue d'ordinaire de deux façons
discrètes. Elle perd ce qui aurait dû rester, et elle garde ce qui aurait dû s'estomper. La seconde
coûte plus cher. Un agent qui « se souvient » encore d'une préférence que vous avez annulée, d'une
échéance qui a bougé ou d'une adresse que vous avez quittée agira dessus en toute confiance.

Ici, la mémoire retire donc un fait quand un fait plus récent le remplace, et ce qu'elle garde et
ce qu'elle laisse partir s'améliore avec l'usage, pas avec la sortie d'un modèle. Ses résultats
sur les tests publics de mémoire, avec chaque réponse et chaque trace qui les fondent, sont dans
[`evals/`](../../evals/).

## Deux agents côte à côte ? Parlons-en

Nous travaillons avec une poignée de personnes qui font déjà tourner deux agents ou plus côte à
côte et déplacent les résultats de l'un à l'autre à la main. Si c'est votre cas, ouvrez une
[issue partenaire de conception](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)
et dites-nous ce que vous utilisez.

## Ce que le chiffrement protège, et ce qu'il ne protège pas

Voir [SECURITY.md](../../SECURITY.md). Ce que le chiffrement protège et ce qu'il ne protège pas
est décrit dans [docs/security.md](../security.md).

## Apache-2.0, de bout en bout

Apache-2.0. Open source, de bout en bout. Voir [LICENSE](../../LICENSE).

## Les épaules sur lesquelles nous nous tenons

Les travaux sur lesquels ce dépôt s'appuie.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Un agent devrait tenir un wiki de ce qu'il a appris plutôt que de tout recalculer à chaque session.
- Tang, Rashtchian, Ferng, Tomkins, Juan et Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). L'expérience propre d'un agent, transformée en connaissance qui réécrit ses compétences.
- Zhang, Hu, Upasani et leurs collègues, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). Nous avons étudié sa façon de trier ce qu'un agent garde en concevant Self Learning.
- Uddin, Shubham, Blanco, Baral et Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). Le premier benchmark qui vérifie aussi ce qu'une mémoire ne devrait plus dire.
