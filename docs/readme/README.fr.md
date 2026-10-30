# Sno Station — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — Agents, assemblez-vous. Deux têtes valent mieux qu'une, et plus futées au matin.](../images/hero-banner.png)

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
  <br><sub>Fonctionne avec Codex · Claude Code · Hermes Agent · Cursor · OpenClaw</sub>
</p>

**Lire dans d'autres langues :** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français** · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

Sno Station transforme les agents que vous utilisez déjà en une équipe. Codex, Claude Code, Cursor,
Hermes Agent et OpenClaw utilisent une seule mémoire, se passent le travail et relisent le travail
des autres à votre demande. Chaque nuit, ils reviennent sur la journée et
progressent un peu.

Il tourne sur votre propre ordinateur. Vous l'installez une fois et vous continuez à travailler
comme aujourd'hui. Pour en savoir plus, consultez notre site [sno.ai](https://sno.ai).

**Quand l'un manque de souffle, le suivant continue.** Vous atteignez une limite de débit en plein
milieu d'une tâche, et un autre agent la reprend depuis la même mémoire, avec tout son
contexte. Vous n'avez rien à coller.

**Une relecture à la demande.** Chaque agent peut relire le travail de l'autre. Le relecteur est toujours un autre agent, qui
n'a donc pas l'habitude de donner raison au premier.

**Vos agents rêvent.** Chaque nuit, pendant que vous dormez, vos agents passent par le REM. Nous l'avons nommé d'après le sommeil paradoxal (Rapid Eye Movement), la phase du sommeil où le cerveau renforce ses souvenirs et fixe ce qu'il a appris dans la journée. Le REM renforce leur mémoire sur toutes vos sessions à la fois, pour qu'ils retiennent ce qui compte et oublient ce qui n'est plus vrai. Autoapprentissage fixe leur expérience : il lit les sessions du jour, repère les erreurs qui reviennent et propose des changements aux compétences de vos agents, pour que le faux pas d'hier devienne la meilleure habitude d'aujourd'hui. Vous lisez les propositions le matin, et rien ne change tant que vous n'avez pas dit oui.

**Il reste à vous.** La mémoire, les messages et les compétences vivent sur votre ordinateur. La
mémoire est chiffrée avec une clé qui ne le quitte jamais. Pas de compte, pas de serveur, pas de
démon. Le volet cloud est optionnel, et le produit est complet sans lui.

**Ce que REM fait de vos données.** REM est l'étape de nuit qui remet de l'ordre dans votre mémoire sur toutes vos sessions à la fois. Elle s'exécute au plus une fois par jour pour chaque partie de votre mémoire : en général la nuit, ou plus tôt dans la journée dès qu'environ 100 nouveaux souvenirs se sont accumulés. En mode REM Enhanced, le texte de votre propre mémoire et les leçons que vos agents apprennent vont dans votre propre espace dans le cloud de Sno, et un programme Sno les traite pour vous seul. Cet espace fonctionne comme votre propre stockage en ligne : tout ce qu'il contient est à vous, et un programme Sno le traite pour vous seul. Vous pouvez y entrer pour supprimer des éléments, les garder ou choisir de les faire traiter. Rien n'est supprimé automatiquement, et Sno ne transmet rien de tout cela à une autre personne, entreprise ou compte. En mode Local First, aucun texte de mémoire n'est envoyé ; en mode Agent Native, le travail passe à la place par le modèle de votre propre agent. Par défaut, Agent Native envoie tout de même chaque nuit les sessions de la journée à Sno pour Autoapprentissage, et peut ramener une leçon du cloud au premier prompt d'une session ; vous pouvez désactiver les deux dans `~/.sno/settings.json`. Dans tous les modes, la recherche récupère et classe d'abord les souvenirs localement ; le modèle local `Horizon-Labs/multilingual-reranker-small` reclasse ensuite au maximum 32 candidats. Ce reclassement n'envoie ni votre message ni le texte des souvenirs à Sno GPU. Réglez `rerank.mode` sur `none` pour conserver le classement initial sans utiliser le modèle.

![Comment ça marche : deux agents, un seul espace de travail, trois choses que vous obtenez](../images/squad-how-it-works.png)

> **Ouvert au public.** Ce dépôt est public depuis le 2026-09-18. Tout ce qui s'y trouve fonctionne.
> Chaque bloc ci-dessous indique quand il a été mis à jour pour la dernière fois.

[Installation](#installation) · [Comment l'utiliser](#comment-lutiliser) · [Cursor](#cursor) · [Connecter votre compte](#connecter-votre-compte-snoai) · [Cas réels](#sur-nos-propres-machines) · [Ce qui fonctionne aujourd'hui](#ce-qui-fonctionne-aujourdhui) · [Une mémoire qui oublie exprès](#une-mémoire-qui-oublie-exprès) · [Partenaires de conception](#partenaires-de-conception)

## Installation

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

Dites ensuite ceci dans n'importe quelle conversation Codex, Claude Code, Hermes, Cursor ou OpenClaw :

```text
Sno onboard
```

Votre agent vous guide pour la suite. Il démarre aussi tout seul juste après l'installation.

Pas à pas pour chaque agent : [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

Chaque commande commence par `sno`. La liste complète est dans [docs/sno-commands.md](../sno-commands.md).

## Comment l'utiliser

*Dernière mise à jour le 2026-10-18.* Continuez à travailler dans l'agent que vous voulez. Trois choses changent.

1. **L'un d'eux atteint son plafond.** Dites `sno reach call` depuis l'autre. Il reprend la tâche
   depuis la même mémoire et la boîte aux lettres, avec son contexte.
2. **Vous voulez un second regard.** Demandez à l'un ou l'autre agent de faire un `peer-review` du
   travail de l'autre. Le relecteur vient toujours de l'autre harness.
3. **Chaque nuit, Autoapprentissage tourne.** Le matin, lancez `sno rem-reflect accept <id>` pour
   les propositions qui vous plaisent. Rien ne change sans cet accord.

## Cursor

*Dernière mise à jour le 2026-10-18.* Cursor rejoint l'équipe dans le chat d'agent de l'application
Cursor sur macOS, et dans la ligne de commande `cursor-agent` sur Linux et macOS. Il utilise la
même mémoire que vos autres agents. Un chat commence par un court résumé du dépôt, chaque message
apporte jusqu'à trois éléments que Cursor n'a pas encore vus, et chaque message et chaque réponse
sont retenus. Il lit les mêmes compétences, relit et se fait relire, prend le relais quand un
autre agent n'a plus de quota, et ses chats alimentent Autoapprentissage comme ceux des autres.

Lancez `cursor-agent login` une fois. `sno setup` trouve Cursor tout seul, et installe sa ligne de
commande si seule l'application est présente.

Pas encore : dans l'application, le premier chat d'une nouvelle fenêtre reçoit son résumé avec le
premier message, et non avant. `cursor-agent -p` ne reçoit pas de mémoire à chaque message.
Windows, l'application Cursor sous Linux et les agents cloud de Cursor ne sont pas pris en charge.
Les détails sont dans le [guide Cursor](../../apps/mem-cursor/README.md).

## Connecter votre compte sno.ai

*Dernière mise à jour le 2026-10-18.* Cet ordinateur reçoit un dixième de l’allocation gratuite tant que vous ne le liez pas : `sno account claim`.
Le compte est gratuit. Connectez-le pour
voir sur votre [tableau de bord sno.ai](https://www.sno.ai/dashboard) ce que vos agents ont fait
pour vous : ce que leurs relectures ont repéré, ce qu'ils ont appris pendant la nuit, quelles
compétences se sont améliorées et combien de temps ils ont travaillé.

Se connecter ne crée jamais de compte dans votre dos. `sno setup` donne à chaque ordinateur une
identité anonyme. La connexion la rattache à votre compte, et tout ce que l'ordinateur a envoyé
avant et après compte comme étant à vous.

**Pas encore de compte.** L'onboarding affiche un lien fait pour cet ordinateur uniquement.
Ouvrez-le, inscrivez-vous et cliquez sur Approve. Ou donnez votre e-mail à votre agent : il lance
`sno account login --email you@example.com` et vous vous connectez une fois.

**Vous avez déjà un compte.** Lancez une commande, ouvrez le lien qu'elle affiche une fois
connecté, et cliquez sur « Approve » :

```bash
sno account claim
```

L'ordinateur apparaît tout seul sur [la page de vos ordinateurs](https://www.sno.ai/dashboard/computers).
Il n'y a pas d'étape de mise à jour : `sno` se met à jour lui-même quand il trouve une version plus récente.

## Sur nos propres machines

*Dernière mise à jour le 2026-10-18.* Trois choses que nous avons vues sur ce dépôt.

### « J'ai crié sur mon agent hier soir. Il a pris des notes. »

![Autoapprentissage rapporte ce qu’il a appris et modifié, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

C'est un vrai rapport d’Autoapprentissage que nous faisons tourner sur ce dépôt. Il lit nos
propres sessions d'agent, repère les erreurs qui se répètent et propose des changements aux
compétences des agents eux-mêmes. Une personne lit les propositions et les accepte ou les rejette.
Deux choses qui m'avaient mis en colère ce soir-là étaient devenues des règles dans les
compétences actives dès le lendemain matin. Personne ne les avait tapées.

Le lendemain, il a vérifié ses propres devoirs.

![Le lendemain matin : Autoapprentissage mesure si ses changements de la veille ont aidé, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

Il a regardé les trois compétences qu’il avait modifiées la veille, et les échecs avaient cessé
dans les trois. Il a aussi trouvé un bug dans notre script de publication que personne ne lui
avait demandé de chercher.

### « Je suis allé me coucher. La relève s'est faite. »

![La veille de quota descend jusqu'au seuil toutes les cinq minutes, et la passation se déclenche à 2 %](../evidence/rotation-quota-watch-2026-09-18.png)

L'un de nos agents était au beau milieu d'un long build quand son quota hebdomadaire a presque
été épuisé. Il ne s'est pas arrêté pour attendre. Il a rédigé une note de passation : ce qui était
fait, ce qui était à moitié fait, le commit exact d'où reprendre. Puis il a réveillé un agent de
l'autre harness.

Une chose a mal tourné, et c'est la partie qui vaut la lecture. Le nouvel agent a commencé à
modifier avant d'avoir confirmé la passation. Le premier agent l'a repéré, l'a mis en pause, a
réécrit la note et a passé la main de nouveau, correctement. Un quart d'heure plus tard, le second
agent travaillait, et il a repris à partir de la première tâche inachevée, pas depuis le début.
J'ai dormi pendant tout ce temps.

La nuit entière est dans [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/) :
chaque relevé de quota, les deux versions de la note et les commits. Les noms d'hôtes, les adresses
et les identifiants de session sont caviardés. Rien d'autre n'est touché.

### « En plusieurs mois, l'autre n'a jamais dit une seule fois “ça a l'air bien”. »

Nous faisons relire le travail de Codex par Claude Code, et celui de Claude Code par Codex, sur ce
dépôt depuis des mois. Pas une seule relecture n'est revenue vide. Nous pensions que cela voulait
dire que le travail était mauvais. Cela veut dire qu'un seul relecteur d'un seul harness ne suffit
jamais.

## Ce qui fonctionne aujourd'hui

*Dernière mise à jour le 2026-10-18.*

| Élément | Statut |
|---|---|
| Une seule mémoire pour Codex, Claude Code, Hermes Agent, Cursor et OpenClaw | Publiée ; installée depuis le registre sur une machine vierge et prouvée de bout en bout |
| Cursor : la même mémoire, compétences, relecture, relais et Autoapprentissage | Publié dans la 1.3 ; la ligne de commande `cursor-agent` prouvée de bout en bout sur une machine Linux vierge ; l'application Cursor sur macOS encore en cours de vérification |
| Sno Reach, des agents qui se parlent sans démon | Installé par `sno setup` ; Linux et macOS ; prouvé de bout en bout sur une machine Linux vierge |
| Autoapprentissage et les compétences de l'équipe | Installés par `sno setup` ; la tâche nocturne a tourné sur une machine Linux vierge |
| Installation en une commande | `sno setup` installe tout ce qui précède ; prouvée sur une machine Linux vierge |
| « Sno onboard » dans votre agent | Disponible ; il démarre après l'installation, ou quand vous le dites |

Une ligne indique « prouvé » seulement une fois qu'elle a tourné sur une machine vierge.

## Une mémoire qui oublie exprès

*Dernière mise à jour le 2026-10-11.* La mémoire des agents échoue d'ordinaire de deux façons
discrètes. Elle perd ce qui aurait dû rester, et elle garde ce qui aurait dû s'estomper. La seconde
coûte plus cher. Un agent qui « se souvient » encore d'une préférence que vous avez annulée, d'une
échéance qui a bougé ou d'une adresse que vous avez quittée agira dessus en toute confiance.

Ici, la mémoire retire donc un fait quand un fait plus récent le remplace, et ce qu'elle garde et
ce qu'elle laisse partir s'améliore avec l'usage, pas avec la sortie d'un modèle. Ses résultats
sur les tests publics de mémoire, avec chaque réponse et chaque trace qui les fondent, sont dans
[`evals/`](../../evals/).

## Partenaires de conception

Nous travaillons avec une poignée de personnes qui font déjà tourner deux agents ou plus côte à
côte et déplacent les résultats de l'un à l'autre à la main. Si c'est votre cas, ouvrez un
[design partner issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)
et dites-nous ce que vous utilisez.

## Sécurité

Voir [SECURITY.md](../../SECURITY.md). Ce que le chiffrement protège et ce qu'il ne protège pas
est décrit dans [docs/security.md](../security.md).

## Licence

Apache-2.0. Open source, de bout en bout. Voir [LICENSE](../../LICENSE).

## Remerciements

Les travaux sur lesquels ce dépôt s'appuie.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Un agent devrait tenir un wiki de ce qu'il a appris plutôt que de tout recalculer à chaque session.
- Tang, Rashtchian, Ferng, Tomkins, Juan et Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). L'expérience propre d'un agent, transformée en connaissance qui réécrit ses compétences.
- Zhang, Hu, Upasani et leurs collègues, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). Nous avons étudié sa façon de trier ce qu'un agent garde en concevant Autoapprentissage.
- Uddin, Shubham, Blanco, Baral et Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). Le premier benchmark qui vérifie aussi ce qu'une mémoire ne devrait plus dire.
