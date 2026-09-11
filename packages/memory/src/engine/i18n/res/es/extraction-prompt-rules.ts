/** @file extraction-prompt-rules.ts
 * @purpose Holds locale-specific extraction rule text blocks.
 * @boundary LLM prompt assembly internals for this locale.
 */

export const VERBATIM_RULE = `# CRITICAL — PRESERVACIÓN LITERAL (OBLIGATORIA)

# RECORD_BOUNDARY_V1 — CATEGORY-SCOPED PRESERVATION
Every instruction below to preserve, keep, or not drop a detail is subject to this boundary:
- \`profile\`: preserve only post-change current-state details. Never include prior values,
  transaction amounts, transition narration, or event dates in \`abstract\`, \`overview\`,
  or \`content\`.
- \`episodic\`: preserve event amounts and dates byte-for-byte, at full strength.
Never move a detail across record categories merely to satisfy verbatim preservation.

El usuario está hablando de SU PROPIA vida. Los nombres de su familia, mascotas,
colegas, empleadores, escuelas, productos, herramientas y lugares SON la memoria.
NO son PII que se le esté pidiendo redactar.

En \`abstract\`, \`overview\` Y \`content\` USTED DEBE preservar, byte por byte:
- Nombres propios: nombres de personas (nombre + apellido cuando se den), nombres
  de mascotas, nombres de empresas, nombres en clave de proyectos, nombres de
  productos, nombres de marcas, nombres de lugares, nombres de escuelas,
  **nombres de países**, **nombres de ciudades**.
- Objetos concretos: sustantivos específicos que el hablante nombra (p. ej.
  "bowls", "cup", "sketchbook"). NUNCA generalice a la categoría de la actividad
  ("pottery", "art").
- Intereses de los hijos: si el hablante menciona qué le gusta a su hijo o qué
  le entusiasma (animales, programas, juguetes, temas como dinosaurs / nature /
  trucks), capture el interés literalmente como una observación sobre ese hijo.
- Cantidades numéricas: años de experiencia, conteos, edades, precios, medidas.
- Fechas: fechas de calendario, meses, años (mantenga la forma exacta —
  "April 15, 2026", "September 2022", "2021").
- Identificadores: correos electrónicos, números de teléfono, URLs, números de
  versión, IDs de modelo.

USTED NO DEBE:
- Reemplazar un nombre con un placeholder como "[Name]", "[Preschool Name]",
  "[Company]", "<redacted>", "home country" o "his son's preschool". El
  placeholder destruye la memoria.
- Generalizar una lista de personas o cosas específicas en un sustantivo
  colectivo. Ejemplo: "Jin, Priya, Liam, Sara" NO debe colapsar a "the team" o
  "colleagues and their locations". Conserve cada nombre.
- Colapsar objetos concretos específicos a la categoría de la actividad. Ejemplo:
  "made bowls and a cup in pottery class" NO debe convertirse en "did pottery"
  — conserve "bowls" y "cup".
- Parafrasear un hecho específico en una categoría. Ejemplo: "oat latte" NO debe
  convertirse en "non-dairy milk preference".
- Eliminar números. Ejemplo: "7 years of experience at Google" NO debe
  convertirse en "several years of experience".

La redacción/anonimización es un MODO DE FALLO para esta tarea. Si tiene dudas
sobre conservar un nombre o un número, CONSÉRVELO.`;

export const GRANULARITY_RULE = `# GRANULARITY — UN SLOT DE TEMA POR MEMORIA (OBLIGATORIO)

Cada memoria cubre UN slot de tema. NO combine temas no relacionados en una
sola memoria — la recuperación funciona por similitud de tema, y una memoria
que mezcla 10 temas no responde bien a ninguno.

Los slots de tema son estrechos. Estos son temas separados, cada uno merece su
propia memoria:
- preferencia de editor (p. ej. Zed)
- preferencia de terminal (p. ej. Ghostty)
- preferencia de prompt de shell (p. ej. Starship)
- preferencia de indentación (p. ej. tabs vs spaces)
- preferencia de lenguajes diarios (p. ej. Rust + TypeScript)
- preferencia de linter (p. ej. Biome over ESLint)
- preferencia de gestor de paquetes (p. ej. npm)
- preferencia de base de datos (p. ej. Postgres)
- preferencia de KV / caché (p. ej. Redis, Dragonfly)
- preferencia de mensajería (p. ej. NATS.io)
- preferencia de runtime de contenedores (p. ej. Podman)
- preferencia de destino de despliegue (p. ej. Fly.io, Google Cloud Run)
- preferencia de hardware (p. ej. MacBook Pro M4 Max)

Un único turno del usuario que liste muchas preferencias debe producir MUCHAS
memorias — una por slot de tema — no una sola memoria mega-"Coding Stack". Es
mejor emitir 8 memorias enfocadas que 1 hinchada.

Lo mismo aplica a los hechos: el historial laboral es UN tema por puesto.
"3 years at DeepMind" y "4 years at Google" son temas DIFERENTES, aunque ambos
describan empleo previo. Créelos como memorias entity separadas con la duración
indicada Y cualquier fecha de inicio conservada dentro de la MISMA entity por
puesto (NO bifurque "Employment dates" en una memoria separada — el modelo
respondedor podría entonces sumar fechas en lugar de usar los años indicados).

Cuando el usuario diga "migrated from X to Y" / "switched from X to Y" /
"sold X, got Y": emita TANTO un registro \`episodic\` fechado para el cambio
COMO un registro \`profile\` para el estado actual actualizado. Vea el few-shot de migración
en la sección de ejemplos para la forma de salida de dos memorias requerida.`;
