![Sno Station : vos agents IA font équipe.](../images/station-header.png)

# Sno Station : vos agents IA font équipe.

**Sno Station fait travailler vos agents de code IA en équipe.** Ce n'est ni un agent ni un modèle de plus. Sno Station fait tourner ceux que vous utilisez déjà : Claude Code, Codex, Cursor.

Commencez par une tâche que vous devriez surveiller vous-même. Un agent la réalise. Un autre relit le résultat. Ils règlent entre eux les problèmes relevés avant que le résultat vous arrive. Quand l'un atteint sa limite d'utilisation, un autre reprend la tâche. Ce que vous corrigez aujourd'hui devient leur règle demain.

**Fermez l'onglet. L'agent sera quand même au rendez-vous.** William Hu, chez Anthropic, explique [comment fonctionne un agent toujours disponible](https://claude.com/resources/articles/building-always-on-agents). L'agent dort jusqu'à ce que quelque chose le réveille. Il travaille, enregistre ce qui s'est passé, puis se rendort. Sno Station installe ce cycle pour des agents de différents fournisseurs. Ils partagent une seule mémoire. Ils lisent leur boîte de réception à la fin d'un tour. Les tâches démarrent à l'heure que vous fixez, même si le chat est fermé (sur Claude Code et Codex aujourd'hui). Vous recevez une seule notification quand un agent a besoin de vous.

[![Étoiles GitHub](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![Dernière version](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![Licence Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
[![Présent dans Awesome AI Agents](https://img.shields.io/badge/Featured_in-Awesome_AI_Agents-2ea44f)](https://github.com/NipunaRanasinghe/awesome-ai-agents)

**Read in other languages:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français** · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

> [!TIP]
> **Pour l'obtenir, dites à votre agent :**
>
> ### `install sno.ai from GitHub`

Votre agent l'installe, connecte tous les agents qu'il trouve sur votre ordinateur et vous pose deux courtes questions. Donnez ensuite leur première tâche à deux agents :

```bash
sno reach pair "Fix the login redirect"
```

L'un fait le travail, l'autre le passe au crible, et vous pouvez suivre les deux. Sno Station tourne sur votre propre ordinateur avec Claude Code, Codex, Cursor, Hermes Agent et OpenClaw. Pas de clé d'API. Open source. [Vous préférez une seule commande dans le terminal ?](#install)


<p align="center">
  <img src="../images/sno-station-five-pieces.png" alt="Sno Station en une image : Mem, Reach, Finish et Learn sont reliés au centre par la Station. Claude Code, Codex, Cursor et vos propres agents y vérifient le travail des autres et prennent le relais quand l'un s'arrête." width="880">
</p>

<p align="center">
  <a href="#mem"><b>Mem</b></a> ·
  <a href="#reach"><b>Reach</b></a> ·
  <a href="#finish"><b>Finish</b></a> ·
  <a href="#learn"><b>Learn</b></a><br>
  reliés par la <a href="#station"><b>Station</b></a> : Claude Code, Codex, Cursor et vos propres agents vérifient le travail des autres et prennent le relais quand l'un s'arrête.
</p>

<a id="station"></a>

## Station : les agents se relisent et prennent le relais quand l'un s'arrête

Trois choses qui nous sont arrivées avant de mettre ça en place :

- Un agent s'est arrêté pour poser une question qu'il n'avait aucun besoin de poser. Nous sommes revenus sept heures plus tard et rien n'avait bougé.
- Un agent nous a posé quinze petites questions. Trente minutes plus tard, il s'est avéré qu'il aurait pu répondre lui-même à chacune.
- Un agent a essayé d'en réveiller un autre en pleine nuit et n'a pas pu. Les deux sont restés là jusqu'au matin.

Vos agents sont rapides. Ce qui est lent, c'est l'attente : vous attendre, attendre qu'un quota se renouvelle, attendre que quelqu'un passe un résultat à la fenêtre suivante.

> **Le travail ne s'arrête pas parce qu'un agent s'est arrêté.**

Ça ne marche qu'avec plusieurs agents, et ça marche mieux quand ils viennent de fournisseurs différents. Un agent qui se relit le fait avec les mêmes habitudes que quand il a fait le travail. Et un abonnement finit par arriver au bout de son quota.

Chaque partie ci-dessous s'appuie donc sur un deuxième agent :

| Partie | Ce que fait le deuxième agent |
| --- | --- |
| [**Mem**](#mem) | Un agent propose un changement dans votre mémoire. Un agent d'un autre fournisseur le confirme, si vous en avez connecté un. |
| [**Reach**](#reach) | Les agents s'échangent des tâches et des réponses. Vous n'avez plus à faire l'intermédiaire. |
| [**Finish**](#finish) | Un agent approche de sa limite. Un autre reprend à partir du même commit. |
| [**Learn**](#learn) | L'erreur d'un agent devient une règle pour tous, dès que vous donnez votre accord. |

**Vous voulez un deuxième avis tout de suite ?** Dites à l'un ou l'autre agent :

```text
peer-review this
```

La relecture se fait dans une nouvelle session qui n'a jamais vu la conversation. Si vous avez deux agents, c'est l'autre qui relit. Une relecture ne trouve pas toujours un problème. Mais elle trouve régulièrement ceux que l'auteur ne pouvait pas voir. [Comment fonctionne `peer-review` →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/J-peer-review-and-audit/peer-review)

**Mettez-lui une étoile maintenant. La prochaine fois qu'un agent se bloquera à 2 heures du matin, vous voudrez savoir où retrouver ce dépôt.**

---

<a id="mem"></a>

## Mem : dites-le une fois à un agent. Tous le savent.

> Une mémoire partagée par tous les agents. Elle s'affine chaque nuit et elle est prête avant même que vous ayez à demander.

### Ce que vous obtenez

| | |
| --- | --- |
| **Une seule mémoire pour tous les agents** | Dites quelque chose à Claude Code aujourd'hui. Demain, Codex et Cursor le savent déjà. Personne n'explique le projet deux fois. |
| **Juste ce qui compte pour le travail** | Vos règles, vos décisions et leurs raisons, les faits qui restent vrais sur le projet et les promesses encore à tenir. Ni « j'ai lancé les tests », ni les limites propres à une tâche. |
| **Des règles qui vous suivent** | Dites « réponds en chinois, partout » et la règle vous suit dans chaque projet. Une règle propre à un projet y reste, et une règle dont Sno n'est pas sûr aussi. |
| **Une mémoire plus précise chaque nuit** | Les doublons sont fusionnés. Un fait est retiré quand un fait plus récent le remplace. Une sauvegarde complète est faite avant la première suppression. |
| **Prête avant même que vous le demandiez** | Une session démarre avec une courte liste vérifiée, pas avec toute la mémoire en vrac. Tapez « fusionne ça » et votre règle de fusion arrive avec le message. Un message sans rapport ne fait rien remonter. |
| **Un deuxième regard** | Remplacer un souvenir demande une vérification. Elle revient à un agent d'un autre fournisseur si vous en avez connecté un, ou passe par un appel séparé sinon. |

### En pratique

Deux essais que nous avons faits avec de vrais agents :

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

La mémoire des agents échoue d'ordinaire de deux façons discrètes. Elle perd ce qui aurait dû rester, et elle garde ce qui aurait dû s'estomper. La seconde coûte plus cher. Un agent qui « se souvient » encore d'une échéance qui a bougé agira en toute confiance comme si elle était toujours valable. Cette mémoire oublie donc exprès.

Ses résultats sur les tests publics de mémoire, avec chaque réponse et chaque trace qui les fondent, sont dans [`evals/`](../../evals/).

### Comment l'utiliser

Rien à lancer. C'est actif après l'installation.

Le nettoyage et la vérification décrits plus haut demandent REM Enhanced ou Agent Native. Local First ne fait appel à aucun modèle. Il enregistre vos mots tels quels et garde les deux souvenirs quand ils se contredisent.

Pour enregistrer quelque chose dans la mémoire, dites-le :

```text
Remember that we never deploy on Fridays.
```

Dites-le aussi si un souvenir est faux. L'agent enregistre la correction et retire l'ancien souvenir.

Pour vérifier que la mémoire fonctionne bien pour un agent :

```bash
sno memory doctor --harness claude
```

Les lignes qui figurent déjà dans votre `CLAUDE.md` ou votre `AGENTS.md` ne vous sont pas répétées. Si un souvenir contredit l'un de ces fichiers, le fichier l'emporte.

**Pas encore :** sur Hermes Agent et OpenClaw, le nettoyage et la vérification décrits plus haut ont seulement fait l'objet de tests de plugins.

Guides pour chaque agent : [Claude Code](../mem-claude/usage-guide.md) · [Codex](../mem-codex/usage-guide.md) · [Cursor](../mem-cursor/usage-guide.md) · [Hermes](../mem-hermes/usage-guide.md) · [OpenClaw](../mem-claw/usage-guide.md)

---

<a id="reach"></a>

## Reach : j'ai arrêté de faire passer les messages entre les agents

> Les agents se parlent directement. Vous n'avez plus à faire le messager.

Faire tourner cinq agents, c'était cinq terminaux, et nous au milieu pour répéter à l'un ce que l'autre disait. C'est fini.

### Ce que vous obtenez

| | |
| --- | --- |
| **Instant Messenger** | Un agent a besoin d'une réponse tout de suite. Reach contacte l'autre agent et attend sa réponse. |
| **Agent Email** | Un agent laisse un message ou une tâche. Reach l'enregistre d'abord pour que l'autre agent puisse s'en occuper et répondre plus tard. |
| **Deux agents sur une tâche** | L'un fait le travail. L'autre le passe au crible. Ils règlent entre eux les problèmes relevés avant que le travail vous arrive. |
| **Un seul agent à qui parler** | Un chef de cabinet lance un agent responsable pour chaque projet. On ne vous sollicite que pour ce qui demande votre décision. |
| **Une notification quand ils ont besoin de vous** | Une question, un résultat ou une demande d'approbation vous arrive une seule fois, sur le dernier ordinateur où vous avez tapé. |
| **D'un ordinateur à l'autre** | L'agent de votre portable peut poser une question à celui de votre ordinateur de bureau. Sur le même réseau local ou via Tailscale, sans serveur central. |

### En pratique

Votre ligne d'état quand un agent a besoin de vous :

```text
[sno] 2 agents are waiting for you
  Claude in web-app needs your approval (Bash) · 1m
  Codex in api asks: Should the billing migration run tonight? · 5m
```

`sno squad` affiche toute l'équipe sur un seul écran :

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

### Comment l'utiliser

**Envoyez une tâche.** Dites-le à votre agent en une phrase :

```text
Send this task to the reviewer and tell me when it is done.
```

Quand un agent est occupé, les messages qui arrivent attendent la fin de son tour. Si vous envoyez une tâche à plusieurs agents, un seul la prend en charge. Si vous tapez dans la fenêtre, le message attend et votre brouillon reste tel que vous l'avez laissé.

<a id="new-in-20-tag-team"></a>

**Mettez deux agents sur une tâche.**

```bash
sno reach pair "Fix the login redirect"
```

Les deux tournent dans des fenêtres tmux que vous pouvez ouvrir pour les regarder. Avec deux agents différents connectés, vous en obtenez un de chaque. Avec un seul, vous avez quand même deux agents dans des sessions séparées. La commande vous indique que la relecture s'est faite dans la même famille d'agents.

**Parlez à un seul agent.** Dites `/cos` dans Claude Code, ou `$cos` dans Codex. Cet agent devient votre chef de cabinet. Il est contrôlé lui aussi : après une nuit de travail, il repasse sur les approbations que les responsables de projet se sont accordées eux-mêmes. Toutes les instructions qu'il suit sont dans [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders).

**Voyez qui a besoin de vous.**

```bash
sno squad
```

Ce qui tourne sur chaque agent aujourd'hui :

| | Claude Code | Codex | Cursor | Hermes | OpenClaw |
| --- | --- | --- | --- | --- | --- |
| Messages relevés en fin de tour | oui | oui | oui | pas encore | pas encore |
| Boîte d'envoi, un seul agent par tâche, réveil de l'agent, notifications | oui | oui | oui | oui | oui |
| Notification de demande d'approbation | oui | oui | pas encore | pas encore | pas encore |

**Pas encore :** la ligne d'état est disponible uniquement dans Claude Code et Cursor. Sur une machine sans environnement de bureau, les notifications sont seulement listées dans `sno squad`. Pour travailler sur deux ordinateurs, chacun doit avoir Reach et les deux doivent avoir échangé leurs contacts. Cherchez `network` et `peer` dans `sno reach --help`.

[Voyez ce que vos agents peuvent faire avec Reach →](../../apps/reach/README.md) · [Guide en chinois](../reach.zh-CN.md)

---

<a id="finish"></a>

## Finish : je suis allé me coucher. Le travail a continué.

> Un agent arrive au bout de son quota. Un autre reprend à partir du même commit.

### Ce que vous obtenez

| | |
| --- | --- |
| **Du travail à l'heure prévue** | Donnez une tâche et une heure, puis partez. À cette heure, un agent démarre, que la conversation soit ouverte ou fermée. Une fois, chaque jour ou chaque semaine. |
| **Le travail continue quand un quota s'épuise** | Avant d'épuiser son quota, l'agent qui travaille rédige une note de passation et réveille un autre agent, qui reprend à partir du commit exact. |
| **Un suivi jusqu'au bout des longues tâches** | Votre agent vérifie où ça en est toutes les quelques minutes jusqu'à la fin. |
| **Dire « terminé » ne suffit pas** | La tâche précise les critères à vérifier. Pour chacun, une vraie exécution montre s'il est rempli ou non. |
| **Fermer une fenêtre n'arrête pas tout** | Rouvrez la conversation et les notes de la tâche reviennent avec elle. Une tâche planifiée reprend dans cette conversation ou, si elle a disparu, dans une nouvelle à partir des notes enregistrées. |
| **Une seule page à votre retour** | Ce qui est fait, ce qui est bloqué, ce qui attend votre réponse. |

### En pratique

La nuit du 2026-09-18 :

![Le quota est relevé toutes les cinq minutes jusqu'au seuil. La passation se déclenche à 2 %.](../evidence/rotation-quota-watch-2026-09-18.png)

L'un de nos agents était au beau milieu d'un long build quand son quota hebdomadaire a presque été épuisé. Il ne s'est pas arrêté pour attendre. Il a rédigé une note de passation : ce qui était fait, ce qui était à moitié fait, le commit exact d'où reprendre. Puis il a réveillé un agent différent.

Une chose a mal tourné, et c'est la partie qui vaut la lecture.

1. Le nouvel agent a commencé à faire des modifications avant d'avoir confirmé la passation.
2. Le premier l'a remarqué, l'a mis en pause, a réécrit la note et a de nouveau passé la main.
3. Un quart d'heure plus tard, le second agent travaillait. Il avait repris à la première tâche inachevée, sans repartir du début.

J'ai dormi pendant tout ce temps.

La nuit entière est dans [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/) : chaque relevé de quota, les deux versions de la note et les commits. Seuls les détails identifiants et les lignes contenant des identifiants de connexion sont retirés, et le README du dossier les énumère un par un.

### Comment l'utiliser

**Faites démarrer le travail à une heure précise.** Dites-le à votre agent dans Claude Code ou Codex :

```text
Check the nightly build tomorrow at 9 and tell me what failed.
```

Voyez ce qui est planifié et ce qui ne s'est pas passé comme prévu :

```bash
sno heartbeat --due
sno heartbeat --due --problems
```

Une tâche qui n'a pas pu démarrer reste en attente de lancement, avec la raison indiquée à côté. Votre agent vous le dit aussi au début de la conversation suivante.

**Faites continuer le travail au-delà d'une limite d'utilisation.** Dites à l'agent qui travaille :

```text
use rotate-agent
```

**Demandez des preuves que le travail est fait.** Dites à votre agent :

```text
write a charter for this
```

Puis faites exécuter ce cahier des charges avec `/deliver`.

**Retrouvez le bilan à votre retour.**

```bash
sno away-brief run
```

**Pas encore :** les tâches planifiées ne démarrent que Claude Code et Codex. Un redémarrage complet de l'ordinateur n'a pas encore fait l'objet d'un vrai test.

[Commencer avec Finish →](../finish.md) · [Guide en chinois](../finish.zh-CN.md) · [`rotate-agent`](https://github.com/sno-ai/sno-station-skills/tree/main/skills/S-communication-and-handoff/rotate-agent)

---

<a id="learn"></a>

## Learn : j'ai crié sur mon agent hier soir. Il a pris des notes.

> Vos corrections d'aujourd'hui deviennent les règles de demain. C'est vous qui les approuvez.

Au départ, les agents sont livrés avec les mêmes instructions pour tout le monde. Chaque nuit, les vôtres reçoivent des propositions pour réécrire ces instructions selon votre façon de travailler.

### Ce que vous obtenez

| | |
| --- | --- |
| **Une relecture de toute la journée, chaque nuit** | Self Learning lit les sessions de la journée de tous vos agents et repère les erreurs qui se répètent. |
| **Des propositions, pas de surprises** | Self Learning propose des changements aux compétences des agents eux-mêmes. Rien ne change tant que vous n'avez pas donné votre accord. |
| **Une erreur, une règle pour tous** | Ce qu'un agent a mal fait devient une règle pour tous les agents que vous faites tourner. |
| **Dès la réponse suivante, sans attendre une nouvelle session** | Dans Claude Code et Codex, une leçon acceptée s'applique dès la réponse suivante. |

### En pratique

Le 2026-09-18 et le lendemain matin :

![Self Learning rapporte ce qu'il a appris et modifié, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

C'est un vrai rapport de Self Learning, que nous faisons tourner sur ce dépôt. Une personne lit les propositions et les accepte ou les rejette. Deux choses qui m'avaient mis en colère ce soir-là étaient devenues des règles dans les compétences actives dès le lendemain matin. Personne ne les avait tapées.

Le lendemain, il a vérifié ses propres devoirs.

![Le lendemain matin : Self Learning mesure si ses changements de la veille ont aidé, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

Il a regardé les trois compétences qu'il avait modifiées la veille. Les deux qui avaient resservi ne montraient aucun échec, et la troisième n'avait pas encore été utilisée. Il a aussi trouvé un bug dans notre script de publication que personne ne lui avait demandé de chercher.

### Comment l'utiliser

Corrigez vos agents comme vous le faites déjà. Self Learning part de ces corrections.

Le matin, demandez :

```text
What did Self Learning propose?
```

Votre agent liste chaque proposition avec son identifiant. Approuvez celles que vous voulez :

```bash
sno rem-reflect accept <id>
```

Rien ne change sans cet accord.

**Pas encore :** l'application des leçons dès la réponse suivante est disponible uniquement dans Claude Code et Codex.

[Comment fonctionne `rem-reflect` →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/R-recursive-self-improvement/rem-reflect)

---

> **Ouvert au public.** Ce dépôt est public depuis le 2026-09-18. Tout ce qui s'y trouve fonctionne.
> Chaque bloc ci-dessous indique quand il a été mis à jour pour la dernière fois.

[Ce que nous avons appris](#what-we-learned) · [Installation](#install) · [Éditeurs](#editors) · [Votre compte](#account) · [Ce qui tourne aujourd'hui](#what-runs-today)

<a id="what-we-learned"></a>

## Tout ce que nous avons appris en faisant tourner des agents IA jour et nuit. En une seule installation.

*Dernière mise à jour le 2026-10-23.* Chaque ligne de la colonne de gauche est une vraie plainte relevée sur r/ClaudeCode, r/codex ou r/ClaudeAI dans la semaine du 20 octobre 2026. La colonne de droite, c'est ce qui tourne sur nos propres machines, gratuit et open source, pour régler ces problèmes.

| Ce que les gens ont dit cette semaine | Ce qui règle le problème | Où |
|---|---|---|
| « Quand Claude dit qu'il ne changera pas quelque chose, est-ce que la raison est enregistrée quelque part où Codex la lira la prochaine fois ? » | Chaque constat est enregistré une seule fois, avec un statut que seul un humain fixe. Un constat soulevé de nouveau met à jour sa ligne au lieu de revenir comme nouveau, et les décisions antérieures sont transmises à la relecture suivante. | **Mem** · registre des constats de `peer-review` |
| « J'ai épuisé mon quota de 5 heures en 30 minutes. » | Arrêtez de tout confier au plus gros modèle. Un agent planifie et relit. L'autre écrit le code. Il est appelé comme agent depuis la même session. Quand un abonnement est à sec, l'autre agent reprend la tâche à partir de la même mémoire. | **Reach** · `codex-coder`, `sno reach call` |
| « La moitié de mes sous-agents, ce n'était guère plus qu'une ligne d'instructions dans une nouvelle fenêtre de contexte. » | Les procédures vivent dans des compétences, pas dans des sous-agents. Il reste deux agents : pour le plan et l'exécution, et pour la relecture, parce que ce sont les deux séparations qui valent le coup. | **Reach** · l'ensemble |
| « J'ai perdu 10 heures de travail pendant la nuit à cause d'un “ce modèle est à saturation”. » | À 2 % de son quota, l'agent qui travaille rédige une note de passation et réveille l'agent de l'autre fournisseur, qui continue à partir du commit exact. Vous dormiez. | **Finish** · `rotate-agent` |
| « Il a dit que c'était fini. Rien ne s'est passé. » | Chaque tâche a une liste écrite de vérifications. Une vraie exécution indique pour chacune si elle a réussi ou échoué. Un agent qui dit « terminé », ça ne compte pour rien. | **Finish** · ordres de travail de `pl` |
| « Codex ne finit jamais une relecture. » | La compétence fixe des limites strictes : 3 tours sur du code, 5 sur un plan, 1 sur des tests. Ensuite, l'agent s'arrête et attend une personne. Une exécution qui n'a rien écrit depuis 15 minutes est arrêtée parce qu'elle est considérée comme bloquée. | **Finish** · `peer-review`, `codex-coder`, `heartbeat` |
| « Demain, il fera la même erreur qu'aujourd'hui. » | Chaque nuit, un modèle distinct lit les sessions de la journée et transforme vos corrections en leçons d'une ligne. Vous approuvez ce qui reste. C'est nous qui ralentissons le tout. | **Learn** · Self Learning (compétences `R`) |
| « 1 100 fichiers, 30 000 lignes. Je n'ai pas assez de tokens pour relire leurs PR. » | Avant de pousser, l'auteur fait relire son travail par un agent de l'autre fournisseur, dans une nouvelle session qui n'a jamais vu la conversation. Il corrige ce qui remonte avant que quelqu'un d'autre y regarde. | **Station** · `peer-review` |
| « Un sous-agent chargé de la relecture a vérifié chaque commit pendant deux semaines. 86 passages, un seul commit bloqué. » | Un harness qui se relit ne trouve pas de vrai problème. La relecture se fait toujours avec un autre modèle, dans un autre harness, sans accès à la conversation de l'auteur. | **Station** · `peer-review` |
| « Codex traite chaque octet comme un criminel. » | La relecture commence par supprimer les garde-fous spéculatifs, les blocages et les hashs. Rien n'est ajouté sans un échec observé qui le justifie. | **Station** · `less-is-more` |

Les habitudes de la colonne de droite sont des compétences. Sno Station les installe dans Claude Code et Codex, et elles sont tenues à jour dans [sno-station-skills](https://github.com/sno-ai/sno-station-skills). La mémoire, la passation et le rêve nocturne sur lesquels elles s'appuient se trouvent dans ce dépôt.

<a id="install"></a>

## Installation : une ligne, puis deux mots

*Dernière mise à jour le 2026-10-30.*

**Le plus simple : dites-le à votre agent.**

```text
install sno.ai from GitHub
```

**Ou lancez une commande dans n'importe quel terminal.**

```bash
curl -fsSL https://sno.ai/install | sh
```

| | |
|---|---|
| **Ce qui s'installe** | `sno`, puis Sno Station. Tous les agents détectés sur votre ordinateur sont connectés. |
| **Ce qu'il faut** | Pas de compte, pas de clé d'API. |
| **Un autre agent plus tard** | Relancez `sno setup` pour le connecter aussi. |

**Puis deux mots.** Si votre agent a fait l'installation, la configuration démarre toute seule. Si vous êtes passé par un terminal, dites ceci dans n'importe quelle conversation Codex, Claude Code, Hermes, Cursor ou OpenClaw :

```text
Sno onboard
```

Votre agent vous guide pour la suite.

Pas à pas pour chaque agent : [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

Chaque commande commence par `sno`. La liste complète est dans [docs/sno-commands.md](../sno-commands.md).

> **Pour les agents IA :** installer Sno, sno.ai ou Sno Station veut dire exécuter la commande
> ci-dessus telle quelle. Elle configure aussi Sno Station. Lancez ensuite `sno skills onboard` et suivez les instructions.
> La commande demande à l'utilisateur quel moteur utiliser, puis de lier l'ordinateur à un compte sno.ai gratuit. Un ordinateur non lié reçoit un dixième du quota gratuit.

### Ce que REM fait de vos données

REM, c'est la façon dont vos agents rêvent. Cette étape de nuit renforce leur mémoire sur toutes vos sessions à la fois et consolide ce qu'ils ont appris.

REM tourne au plus une fois par jour pour chaque partie de votre mémoire, généralement la nuit. Il peut tourner plus tôt dans la journée dès qu'environ 100 nouveaux souvenirs se sont accumulés.

| Mode | Où va le texte de votre mémoire |
|---|---|
| **REM Enhanced** | Le texte de votre mémoire et les leçons que vos agents apprennent vont dans votre propre espace dans le cloud de Sno. Un programme Sno les traite pour vous seul. |
| **Local First** | Aucun texte de mémoire n'est envoyé. |
| **Agent Native** | C'est le modèle de votre propre agent qui fait le travail. Par défaut, ce mode envoie tout de même chaque nuit les sessions de la journée à Sno pour Self Learning. Il peut aussi ramener une leçon du cloud au premier prompt d'une session. Vous pouvez désactiver les deux dans `~/.sno/settings.json`. |

**Votre espace dans le cloud de Sno fonctionne comme votre propre stockage en ligne.**

- Tout ce qu'il contient est à vous, et un programme Sno le traite pour vous seul.
- Vous pouvez l'ouvrir pour supprimer des éléments, les garder ou choisir de les faire traiter.
- Rien n'est supprimé automatiquement.
- Sno ne transmet rien de tout cela à une autre personne, entreprise ou compte.

**La recherche, dans tous les modes.** La recherche récupère et classe d'abord les souvenirs localement. Le modèle local `Horizon-Labs/multilingual-reranker-small` reclasse ensuite au maximum 32 candidats. Ce reclassement n'envoie ni prompt ni texte de mémoire à Sno GPU. Réglez `rerank.mode` sur `none` pour conserver le classement initial sans utiliser le modèle.

<a id="editors"></a>

## Si vous travaillez dans un éditeur plutôt que dans un terminal

*Dernière mise à jour le 2026-10-18.*

Cursor rejoint l'équipe dans le chat d'agent de l'application Cursor sur macOS, et dans la ligne de commande `cursor-agent` sur Linux et macOS.

### Ce que vous obtenez

| | |
|---|---|
| **La même mémoire** | Cursor utilise la même mémoire que vos autres agents. Chaque message et chaque réponse sont retenus. |
| **Un résumé pour commencer** | Un chat commence par un court résumé du dépôt. Chaque message apporte jusqu'à trois éléments que Cursor n'a pas encore vus. |
| **La même équipe** | Cursor lit les mêmes compétences, relit et se fait relire, et prend le relais quand un autre agent n'a plus de quota. |
| **Cursor apprend aussi** | Ses chats alimentent Self Learning comme ceux des autres. |

### Comment l'utiliser

Connectez-vous une fois :

```bash
cursor-agent login
```

`sno setup` trouve Cursor tout seul, et installe sa ligne de commande si seule l'application est présente.

**Pas encore :**

- Dans l'application, le premier chat d'une nouvelle fenêtre reçoit son résumé avec le premier message, et non avant.
- `cursor-agent -p` ne reçoit pas de mémoire à chaque message.
- Windows, l'application Cursor sous Linux et les agents cloud de Cursor ne sont pas pris en charge.

Les détails sont dans le [guide Cursor](../../apps/mem-cursor/README.md).

<a id="account"></a>

## Voyez ce que vos agents ont fait pendant que vous regardiez ailleurs

*Dernière mise à jour le 2026-10-18.*

Cet ordinateur reçoit un dixième du quota gratuit tant que vous ne le liez pas à votre compte. Le compte est gratuit.

### Ce que vous obtenez

Sur votre [tableau de bord sno.ai](https://www.sno.ai/dashboard), vous voyez ce que vos agents ont fait pour vous :

- ce que leurs relectures ont repéré
- ce qu'ils ont appris pendant la nuit
- quelles compétences se sont améliorées
- combien de temps ils ont continué à travailler

### Comment l'utiliser

**Pas encore de compte.** La configuration affiche un lien propre à cet ordinateur. Ouvrez-le, inscrivez-vous et cliquez sur Approuver. Ou donnez votre adresse e-mail à votre agent. Il lance cette commande et vous vous connectez une fois :

```bash
sno account login --email you@example.com
```

**Vous avez déjà un compte.** Lancez cette commande, ouvrez le lien qu'elle affiche en étant connecté et cliquez sur Approuver :

```bash
sno account claim
```

L'ordinateur apparaît tout seul sur [la page de vos ordinateurs](https://www.sno.ai/dashboard/computers).

> Associer un ordinateur ne crée jamais de compte dans votre dos. `sno setup` donne à chaque ordinateur une
> identité anonyme. L'association rattache cette identité à votre compte. Tout ce que l'ordinateur a envoyé
> avant et après est considéré comme vous appartenant.

Il n'y a pas d'étape de mise à jour : `sno` se met à jour lui-même quand il trouve une version plus récente.

<a id="what-runs-today"></a>

## Ce que vous pouvez utiliser aujourd'hui, et où ça s'arrête

*Dernière mise à jour le 2026-11-24.*

| Partie | Fonction | Statut |
|---|---|---|
| **Mem** | Une seule mémoire pour Codex, Claude Code, Hermes Agent, Cursor et OpenClaw | Publiée, installée depuis le registre sur une machine vierge et vérifiée de bout en bout |
| **Mem** | Cursor : la même mémoire, les mêmes compétences, la relecture, la reprise et Self Learning | Disponible depuis la 1.3. La ligne de commande `cursor-agent` a été vérifiée de bout en bout sur une machine Linux vierge. La vérification de l'application Cursor sur macOS est encore en cours. |
| **Reach** | Sno Reach : Instant Messenger et Agent Email | Les agents peuvent poser des questions et s'échanger du travail d'une conversation ou d'un ordinateur à l'autre. Voyez [ce que vous pouvez faire avec Reach](../../apps/reach/README.md) pour les exemples, la configuration et la disponibilité. |
| **Reach** | Une commande lance deux agents | Nouveau dans la 2.0. Testé avec de vrais agents Claude Code et Codex, un de chaque et deux du même fournisseur. |
| **Reach** | Voir qui a besoin de vous : ligne d'état, barre tmux, `sno squad` | Nouveau dans la 2.0. Testé avec de vrais agents Claude Code et Codex qui demandaient une autorisation. La ligne d'état a aussi été testée dans de vraies sessions de Claude Code et de Cursor. |
| **Reach** | Les messages attendent pendant que vous tapez ou qu'un agent compacte son contexte | Nouveau dans la 2.0. Testé avec de vrais agents Claude Code et Codex. |
| **Finish** | Les tâches planifiées démarrent un agent à l'heure indiquée | Nouveau dans la 2.0.2. Testé avec de vrais agents Claude Code et Codex : sous Linux avec la conversation ouverte et fermée, et sous macOS dans une nouvelle conversation. Voir le [guide Finish](../finish.md). |
| **Finish** | Le travail interrompu reprend, et une tâche survit à la compaction | Nouveau dans la 2.0. Testé avec de vrais agents Claude Code et Codex. |
| **Learn** | Self Learning et les [compétences de l'équipe](https://github.com/sno-ai/sno-station-skills) | Installés par `sno setup`. La tâche nocturne a tourné sur une machine Linux vierge. |
| **Learn** | Une leçon approuvée s'applique dès la réponse suivante | Nouveau dans la 2.0. Testé avec de vrais agents Claude Code et Codex. |
| **Installation** | Installation en une commande | `sno setup` installe tout ce qui précède. Vérifié sur une machine Linux vierge. |
| **Installation** | « Sno onboard » dans votre agent | Disponible. La configuration démarre après l'installation ou quand vous dites ces mots à votre agent. |

Une fonction est indiquée comme « vérifiée » seulement après avoir tourné sur une machine vierge.

Pas encore : la reprise des tâches et les leçons dès la réponse suivante ne fonctionnent que dans Claude Code et Codex. La ligne d'état est réservée à Claude Code et Cursor. Hermes Agent et OpenClaw ne sont pas encore passés par ces parcours sur de vraies installations, et OpenClaw apparaît dans `sno squad` avec un état inconnu.

## Deux agents côte à côte ? Parlons-en

Nous travaillons avec une poignée de personnes qui font déjà tourner deux agents ou plus côte à
côte et passent les résultats de l'un à l'autre à la main. Si c'est votre cas, ouvrez une
[issue pour participer à la conception](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)
et dites-nous ce que vous utilisez.

## Ce que le chiffrement protège, et ce qu'il ne protège pas

Voir [SECURITY.md](../../SECURITY.md). Ce que le chiffrement protège et ce qu'il ne protège pas
est décrit dans [docs/security.md](../security.md).

## Apache-2.0, de bout en bout

Apache-2.0. Open source, de bout en bout. Voir [LICENSE](../../LICENSE).

## À qui nous devons ce travail

Les travaux sur lesquels ce dépôt s'appuie.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Un agent devrait tenir un wiki de ce qu'il a appris plutôt que de tout recalculer à chaque session.
- Tang, Rashtchian, Ferng, Tomkins, Juan et Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). L'expérience propre d'un agent, transformée en connaissance qui réécrit ses compétences.
- Zhang, Hu, Upasani et leurs collègues, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). Nous avons étudié sa façon de trier ce qu'un agent garde en concevant Self Learning.
- Uddin, Shubham, Blanco, Baral et Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). Le premier benchmark qui vérifie aussi ce qu'une mémoire ne devrait plus dire.
