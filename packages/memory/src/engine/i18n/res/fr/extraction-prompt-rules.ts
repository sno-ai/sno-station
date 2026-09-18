/** @file extraction-prompt-rules.ts
 * @purpose Holds locale-specific extraction rule text blocks.
 * @boundary LLM prompt assembly internals for this locale.
 */

export const VERBATIM_RULE = `# CRITICAL — PRÉSERVATION TEXTUELLE (OBLIGATOIRE)

# RECORD_BOUNDARY_V1 — CATEGORY-SCOPED PRESERVATION
Every instruction below to preserve, keep, or not drop a detail is subject to this boundary:
- \`profile\`: preserve only post-change current-state details. Never include prior values,
  transaction amounts, transition narration, or event dates in \`abstract\`, \`overview\`,
  or \`content\`.
- \`episodic\`: preserve event amounts and dates byte-for-byte, at full strength.
Never move a detail across record categories merely to satisfy verbatim preservation.

L'utilisateur parle de SA PROPRE vie. Les noms de sa famille, ses animaux, ses collègues,
employeurs, écoles, produits, outils et lieux SONT la mémoire. Ce ne sont PAS des PII
qu'on vous demande de masquer.

Dans \`abstract\`, \`overview\` ET \`content\`, vous DEVEZ préserver, octet par octet :
- Noms propres : noms de personnes (prénom + nom lorsqu'ils sont donnés), noms d'animaux,
  noms d'entreprises, noms de code de projets, noms de produits, marques, noms de lieux,
  noms d'écoles, **noms de pays**, **noms de villes**.
- Objets concrets : noms d'objets spécifiques que le locuteur cite (par ex. "bowls", "cup",
  "sketchbook"). NE JAMAIS généraliser à la catégorie d'activité ("pottery", "art").
- Centres d'intérêt des enfants : si le locuteur mentionne ce que son enfant aime ou ce qui
  l'enthousiasme (animaux, émissions, jouets, sujets comme dinosaurs / nature / trucks),
  capturez l'intérêt textuellement comme observation sur cet enfant.
- Quantités numériques : années d'expérience, dénombrements, âges, prix, mesures.
- Dates : dates calendaires, mois, années (gardez la forme exacte — "April 15, 2026",
  "September 2022", "2021").
- Identifiants : e-mails, numéros de téléphone, URL, numéros de version, ID de modèle.

Vous NE DEVEZ PAS :
- Remplacer un nom par un placeholder comme "[Name]", "[Preschool Name]", "[Company]",
  "<redacted>", "home country" ou "his son's preschool". Le placeholder
  détruit la mémoire.
- Généraliser une liste de personnes ou de choses spécifiques en un seul nom collectif.
  Exemple : "Jin, Priya, Liam, Sara" ne doit PAS s'effondrer en "the team" ou
  "colleagues and their locations". Conservez chaque nom.
- Réduire des objets concrets spécifiques à la catégorie d'activité. Exemple :
  "made bowls and a cup in pottery class" ne doit PAS devenir "did pottery" —
  conservez "bowls" et "cup".
- Paraphraser un fait spécifique en catégorie. Exemple : "oat latte" ne doit PAS
  devenir "non-dairy milk preference".
- Supprimer des nombres. Exemple : "7 years of experience at Google" ne doit PAS
  devenir "several years of experience".

Le masquage est un MODE D'ÉCHEC pour cette tâche. Si vous n'êtes pas sûr de conserver
un nom ou un nombre, CONSERVEZ-LE.`;

export const GRANULARITY_RULE = `# GRANULARITY — UN SEUL TOPIC SLOT PAR MEMORY (OBLIGATOIRE)

Chaque memory couvre UN seul topic slot. NE combinez PAS des sujets sans rapport dans une
même memory — le rappel fonctionne par similarité de sujet, et une memory mélangeant 10 sujets
ne répond bien à aucun.

Les topic slots sont étroits. Voici des sujets distincts, chacun méritant sa propre memory :
- préférence d'éditeur (par ex. Zed)
- préférence de terminal (par ex. Ghostty)
- préférence de shell prompt (par ex. Starship)
- préférence d'indentation (par ex. tabs vs spaces)
- préférence de langages quotidiens (par ex. Rust + TypeScript)
- préférence de linter (par ex. Biome over ESLint)
- préférence de gestionnaire de paquets (par ex. npm)
- préférence de base de données (par ex. Postgres)
- préférence KV / cache (par ex. Redis, Dragonfly)
- préférence de messagerie (par ex. NATS.io)
- préférence de runtime de conteneurs (par ex. Podman)
- préférence de cible de déploiement (par ex. Fly.io, Google Cloud Run)
- préférence matérielle (par ex. MacBook Pro M4 Max)

Un seul tour utilisateur listant de nombreuses préférences doit produire PLUSIEURS memories —
une par topic slot — et non une mega-memory "Coding Stack" unique. Il vaut mieux émettre
8 memories ciblées qu'une seule trop chargée.

Idem pour les entity memories : l'historique professionnel est UN sujet par poste. "3 years at DeepMind"
et "4 years at Google" sont des sujets DIFFÉRENTS, même s'ils décrivent tous deux un emploi
antérieur. Créez-les comme entity memories distincts avec la durée énoncée ET les éventuelles
dates de début conservées DANS LA MÊME entity par poste (NE forkez PAS "Employment dates"
dans une memory séparée — le modèle de réponse pourrait alors additionner les dates au lieu
d'utiliser les années énoncées).

Quand l'utilisateur dit "migrated from X to Y" / "switched from X to Y" / "sold X,
got Y" : émettez À LA FOIS un enregistrement \`episodic\` daté pour le changement ET un
enregistrement \`profile\` pour l'état courant mis à jour. Voir le few-shot de migration
pour la forme de sortie à deux memories requise.`;
