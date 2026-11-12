# Sno Station: Una persona. Todo un equipo de ingeniería de agentes de IA.

**Sno Station es la estación de trabajo de tus agentes de programación con IA.** Claude Code, Codex y Cursor corren cada uno en su propio harness. Sno Station es el lugar donde esos harness se sientan lado a lado y trabajan como un solo equipo. No es otro agente ni otro modelo: pone a trabajar los que ya usas.

Empieza por el trabajo que, si no, tendrías que vigilar tú. Un agente construye, otro revisa, y resuelven entre ellos lo que encuentran antes de que el resultado te llegue. Cuando uno llega a su límite de uso, el otro retoma la tarea. Lo que corriges hoy es mañana una regla en sus habilidades.

Para tenerlo, dile a tu agente:

```text
install sno.ai from GitHub
```

Tu agente lo instala, conecta todos los agentes que encuentra en tu computadora y te hace dos preguntas cortas. Después, dales a dos agentes su primera tarea:

```bash
sno reach pair "Fix the login redirect"
```

Uno construye, el otro lo pone a prueba, y puedes mirar a los dos. Corre en tu propia computadora con Claude Code, Codex, Cursor, Hermes Agent y OpenClaw. Sin clave de API. Código abierto. [¿Prefieres un solo comando en la terminal?](#install)

[![GitHub stars](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![latest release](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)

**Leer en otros idiomas:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · **Español** · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

## Entrega el trabajo esta noche. Por la mañana te esperan resultados, no tres preguntas.

Tres cosas que nos pasaron antes de construir esto:

- Un agente se detuvo a hacer una pregunta que no necesitaba hacer. Volvimos siete horas después y nada se había movido.
- Un agente nos entregó quince preguntas pequeñas. Treinta minutos de nuestra atención después, resultó que podía haber respondido todas él solo.
- Un agente intentó despertar a otro en plena noche y no pudo. Los dos se quedaron ahí hasta la mañana.

Tus agentes son rápidos. Lo lento es la espera: a que respondas tú, a que se reinicie un límite de uso, a que alguien lleve un resultado a la ventana siguiente. Por eso toda la estación de trabajo está construida alrededor de una regla: **el trabajo no se detiene porque un agente se haya detenido.**

- **Un límite de uso no es una señal de alto.** Otro agente continúa desde el commit exacto.
- **El autor no tiene la última palabra.** Revisa un agente distinto, en una sesión que nunca vio la conversación.
- **"Hecho" no cuenta para nada.** Cada comprobación de éxito se responde con una ejecución real.
- **Vuelves a una sola página.** Qué se hizo, qué está atascado, qué espera tu respuesta.

**El equipo entrega. Tú lanzas.**

**Dale una estrella ahora. La próxima vez que un agente se te quede parado a las 2 de la madrugada, querrás saber dónde estaba esto.**

A continuación, tres formas de usarlo: arrancar un constructor y un revisor con un solo comando, llevar todo el equipo a través de un solo agente, y aprobar esta noche una lección que funciona en la próxima respuesta. Cada una viene con algo que vimos en nuestras propias máquinas.

<a id="new-in-20-tag-team"></a>

## Me fui a dormir. Ellos cambiaron de turno y luego discutieron el código.

```bash
sno reach pair "Fix the login redirect"
```

Un agente construye. El otro pone a prueba lo construido. Lo que encuentran lo resuelven entre ellos, así que el trabajo te llega ya discutido. Los dos corren en ventanas de tmux que puedes abrir y mirar. Con sesión iniciada en dos agentes distintos, tienes uno de cada uno. Con uno solo, sigues teniendo la pareja en dos sesiones separadas, y el comando te avisa de que la revisión se quedó en la misma familia.

**Cuando uno se queda sin cuota, el otro entra de turno.** Para una ejecución larga, dile al agente que trabaja que use `rotate-agent`. Al 2% de su cuota escribe una nota de relevo y despierta a un agente distinto, que continúa desde el commit exacto. Y cuando el contexto de un agente se llena y se compacta, sigue sabiendo qué estaba haciendo y qué ya falló.

**El otro ve lo que el primero no puede.** Pide a cualquiera de los dos agentes que haga `peer-review` del trabajo del otro. El revisor siempre trabaja en una sesión nueva que nunca vio la conversación, y es un agente distinto siempre que tengas dos. Una revisión no siempre encuentra un problema. Pero sigue encontrando los que el autor no podía ver, porque un agente que se revisa a sí mismo trae los mismos hábitos con los que escribió el código.

Lo que vimos la noche del 2026-09-18:

![La vigilancia de cuota leyendo hasta el umbral cada cinco minutos, y el relevo activándose al 2%](../evidence/rotation-quota-watch-2026-09-18.png)

Uno de nuestros agentes estaba metido de lleno en una compilación larga cuando su cuota semanal casi se agotó. No se detuvo a esperar. Escribió una nota de relevo: qué estaba hecho, qué estaba a medias y el commit exacto desde el que continuar. Luego despertó a un agente distinto.

Una cosa salió mal, y es la parte que vale la pena leer. El agente nuevo empezó a editar antes de haber confirmado el relevo. El primer agente lo detectó, lo pausó, reescribió la nota y entregó de nuevo, como correspondía. Un cuarto de hora después el segundo agente estaba trabajando, y retomó desde la primera tarea sin terminar, no desde el principio. Yo estuve dormido todo el tiempo.

La noche completa está en [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/): cada lectura de cuota, las dos versiones de la nota y los commits. Solo se quitaron los datos identificativos y las líneas con credenciales, y el README de esa carpeta enumera cada uno. Los tiempos, los errores y las correcciones están tal como ocurrieron.

## Hablamos con un solo agente. Él dirige al resto.

Llevar cinco agentes antes significaba cinco terminales, y nosotros en medio, llevando lo que decía uno al siguiente. Ese oficio se acabó.

Di `/cos` en Claude Code, o `$cos` en Codex. Ese agente pasa a ser tu jefe de gabinete, el único con el que tratas. Abre un agente líder para cada proyecto, los líderes reparten el trabajo hacia abajo, y a ti solo te llega lo que necesita tu decisión. Al que manda también lo revisan: después de un turno de noche repasa las aprobaciones que los líderes de proyecto se dieron a sí mismos, y un error de gestión que se repite se convierte en una regla para todos. Sno Station instala las habilidades que llevan esta delegación, revisión y aprendizaje, y puedes leer cada instrucción en [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders).

**Deja de vigilar terminales.** Con jefe de gabinete o sin él, tu línea de estado de Claude Code o Cursor te dice cuándo alguien te necesita. La instalación la deja configurada:

```text
❄ 2 need you · claude: approve
```

`sno squad` despliega todo el equipo a pantalla completa: quién te necesita, quién está trabajando, qué está terminado.

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

**Deja de llevar mensajes.** Los agentes se envían tareas y peticiones de revisión directamente. El texto completo llega primero al buzón del otro agente. Si estás escribiendo en esa ventana, o el agente está compactando su contexto, el mensaje espera allí y tu borrador a medias se queda como lo dejaste.

## Anoche le grité a mi agente. Tomó notas.

Recién instalado, cada agente le llega a todo el mundo con las mismas instrucciones. A los tuyos se les propone una reescritura cada noche, hecha a tu forma de trabajar. Tú decides qué se queda.

Hoy corriges a un agente. Esta noche Self Learning lee las sesiones del día de todos tus agentes, encuentra los errores que se repiten y propone cambios en las habilidades de los propios agentes. Por la mañana, pregúntale a tu agente qué propuso Self Learning. Te lista cada propuesta con su id, y apruebas las que quieras:

```bash
sno rem-reflect accept <id>
```

Sin ese accept, nada cambia. En Claude Code y Codex, una lección aceptada se aplica desde la próxima respuesta. No la próxima sesión. La próxima respuesta.

Lo que vimos el 2026-09-18 y a la mañana siguiente:

![Self Learning informando lo que aprendió y cambió, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

Es un informe real de Self Learning, que ejecutamos en este repositorio. Una persona lee las propuestas y las acepta o las rechaza. Dos cosas que me enfadaron esa tarde eran reglas en las habilidades activas a la mañana siguiente. Nadie las tecleó.

Al día siguiente revisó su propia tarea.

![A la mañana siguiente: Self Learning mide si sus propios cambios de ayer ayudaron, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

Miró las tres habilidades que había cambiado el día anterior. Las dos que se habían vuelto a usar no mostraron fallos, y la tercera aún no se había usado. También encontró un error en nuestro script de publicación que nadie le había pedido buscar.

## La estación de trabajo donde tus agentes de IA se vuelven un equipo que se dirige solo y mejora cada noche

Todo lo anterior, en una línea cada cosa. Nada de esto hay que aprenderlo de antemano.

| Lo que obtienes | La línea que lo consigue |
|---|---|
| **Un límite de uso no es una señal de alto.** Antes de que se agote su cuota, el agente que trabaja escribe una nota de relevo con el trabajo sin terminar y el commit exacto, y un agente distinto continúa desde ahí. | Dile al agente que trabaja: `use rotate-agent` |
| **El autor no tiene la última palabra.** El trabajo pasa a un agente distinto, en una sesión nueva que nunca vio la conversación. | `sno reach pair "the task"`, o dile a un agente: `peer-review this` |
| **"Hecho" no cuenta para nada.** La tarea lleva comprobaciones de aprobado o fallido, y cada una se responde con una ejecución real. | Dile a tu agente: `write a charter for this`, y después haz `/deliver` |
| **Una sola página cuando vuelves.** Qué se hizo, qué está atascado, qué espera tu respuesta. | `sno away-brief run` |
| **Una caída o una ventana cerrada no es el final.** La tarea vuelve en la misma conversación, o en una nueva creada a partir de la nota guardada, y te dicen cuál fue el caso: reanudada, reconstruida o perdida. | Nada que ejecutar. Queda activo tras la instalación |
| **Nadie explica el proyecto dos veces.** Tus agentes comparten una sola memoria, y un hecho se retira cuando uno más nuevo lo reemplaza. | Nada que ejecutar. Queda activo tras la instalación |

Dile a tu agente:

```text
install sno.ai from GitHub
```

**Y dale una estrella a este repositorio.** Construimos Sno Station con Sno Station. Lo que nos enseñan nuestros propios turnos de noche se publica aquí, versión tras versión. Qué partes corren hoy en cada agente está en [qué puedes usar hoy](#what-runs-today).

---

> **Abierto al público.** Este repositorio es público desde el 2026-09-18. Todo lo que hay aquí funciona.
> Cada bloque a continuación indica cuándo se actualizó por última vez.

[Lo que aprendimos](#what-we-learned) · [Instalación](#install) · [Editores](#editors) · [Tu cuenta](#account) · [Qué funciona hoy](#what-runs-today) · [Memoria que olvida a propósito](#memory)

<a id="what-we-learned"></a>

## Todo lo que aprendimos con agentes de IA trabajando día y noche. En una sola instalación.

*Última actualización 2026-10-23.* Cada línea de la columna izquierda es una queja real de r/ClaudeCode, r/codex o r/ClaudeAI de la semana del 20 de octubre de 2026. La columna derecha es lo que corre en nuestras propias máquinas, gratis y de código abierto, para que eso deje de pasar.

| Lo que dijo la gente esta semana | Qué lo arregla | Dónde |
|---|---|---|
| “Ran out of my 5-hour limit within 30 minutes.” | Deja de mandar al modelo más grande a hacerlo todo. Un agente planifica y revisa; el otro escribe el código, llamado como agente desde la misma sesión. Cuando una suscripción se agota, la otra retoma la tarea desde la misma memoria. | `codex-coder`, `sno reach call` |
| “Lost 10 hours of overnight work to ‘this model is at capacity’.” | Al 2% de su cuota, el agente que trabaja escribe una nota de relevo y despierta al agente del otro proveedor, que continúa desde el commit exacto. Tú dormías. | `rotate-agent` |
| “1,100 files, 30,000 lines. I don't have the token budget to review their PRs.” | Quien hace push, revisa primero: el autor lanza una revisión hecha por el otro proveedor, en una sesión nueva que nunca vio la conversación, y corrige lo que vuelve antes de que nadie más mire. | `peer-review` |
| “A reviewer subagent checked every commit for two weeks. 86 runs, it stopped exactly one.” | Un harness que se revisa a sí mismo no encuentra nada real. El revisor siempre es un modelo distinto en un harness distinto, sin nada del chat del autor. | `peer-review` |
| “Codex never finishes a review.” | Topes fijos escritos en la habilidad: 3 rondas para código, 5 para un plan, 1 para pruebas; después se detiene y espera a una persona. Una ejecución que lleva 15 minutos sin escribir nada se mata por atascada. | `peer-review`, `codex-coder`, `heartbeat` |
| “Codex treats every byte like a criminal.” | Las salvaguardas especulativas, los bloqueos y los hashes son lo primero que borra la revisión. Nada entra sin un fallo observado que lo pida. | `less-is-more` |
| “When Claude says it won't change something, is that reason stored anywhere Codex reads next time?” | Cada hallazgo se registra una sola vez, con un estado que solo fija una persona. Un hallazgo que se plantea otra vez actualiza su fila en lugar de volver como nuevo, y las decisiones anteriores se entregan a la siguiente revisión. | registro de hallazgos de `peer-review` |
| “It said done. Nothing happened.” | Una tarea lleva una lista escrita de comprobaciones de éxito, cada una respondida con aprobado o fallido por una ejecución real. Que un agente diga "hecho" no cuenta para nada. | órdenes de trabajo de `pl` |
| “Tomorrow it makes the same mistake it made today.” | Cada noche un modelo aparte lee las sesiones del día, convierte tus correcciones en lecciones de una línea, y tú apruebas lo que se queda. El cuello de botella somos nosotros. | Self Learning (habilidades `R`) |
| “Half my subagents were glorified one-liners with a fresh context window.” | Los procedimientos viven en habilidades, no en subagentes. Quedan dos agentes, para separar plan y ejecución, y para la revisión, porque esas dos divisiones son las que rinden. | todo el conjunto |

Los hábitos de la columna derecha son habilidades que Sno Station instala en Claude Code y Codex y que se mantienen en [sno-station-skills](https://github.com/sno-ai/sno-station-skills); la memoria, el relevo y el sueño nocturno en los que se apoyan son este repositorio.

<a id="install"></a>

## Instalación: una línea y luego dos palabras

*Última actualización 2026-10-30.* La forma más fácil es decirle a tu agente:

```text
install sno.ai from GitHub
```

O ejecuta un solo comando, en cualquier terminal:

```bash
curl -fsSL https://sno.ai/install | sh
```

Instala `sno`, luego Sno Station, y conecta todos los agentes que encuentre en tu computadora. Sin cuenta y sin clave de API. Si más adelante instalas otro agente, vuelve a ejecutar `sno setup` para conectarlo también.

**Para agentes de IA:** instalar Sno, sno.ai o Sno Station significa ejecutar el comando de arriba tal cual. También configura Sno Station; después ejecuta `sno skills onboard` y síguelo. Pregunta al usuario qué motor ejecutar y después le pide que vincule la computadora a una cuenta gratuita de sno.ai; una computadora sin vincular recibe una décima parte de la asignación gratuita.

Si lo instalaste a través de tu agente, el onboarding arranca solo. Si lo instalaste desde una terminal, di esto dentro de cualquier conversación de Codex, Claude Code, Hermes, Cursor u OpenClaw:

```text
Sno onboard
```

Tu agente te guía en el resto.

Paso a paso para cada agente: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

Todos los comandos empiezan con `sno`. La lista completa está en [docs/sno-commands.md](../sno-commands.md).

**Qué hace REM con tus datos.** REM es la forma en que tus agentes sueñan: el paso nocturno que refuerza su memoria en todas tus sesiones a la vez y asienta lo que aprendieron. Se ejecuta como máximo una vez al día para cada parte de tu memoria: normalmente de noche, o antes ese mismo día si se acumulan unos 100 recuerdos nuevos. En el modo REM Enhanced, el texto de tu propia memoria y las lecciones que aprenden tus agentes van a tu propio espacio en la nube de Sno, y un programa de Sno los procesa solo para ti. Ese espacio funciona como tu propia unidad en la nube: todo lo que hay en él es tuyo, y un programa de Sno lo procesa solo para ti. Puedes entrar a borrar cosas, conservarlas o elegir que se procesen. Nada se borra automáticamente, y Sno no entrega nada de eso a ninguna otra persona, empresa o cuenta. En el modo Local First no se sube ningún texto de memoria; en el modo Agent Native el trabajo pasa, en su lugar, al modelo de tu propio agente. Por defecto, Agent Native sigue subiendo cada noche las sesiones del día a Sno para Self Learning, y puede traer una lección de la nube en el primer prompt de una sesión; puedes desactivar ambas cosas en `~/.sno/settings.json`. En todos los modos, la búsqueda primero recupera y ordena los recuerdos localmente; después, el modelo local `Horizon-Labs/multilingual-reranker-small` reordena un máximo de 32 candidatos. Esta reordenación no envía ningún prompt ni texto de memoria a Sno GPU. Configura `rerank.mode` como `none` para conservar el orden inicial sin usar el modelo.

<a id="editors"></a>

## Si vives en un editor y no en una terminal

*Última actualización 2026-10-18.* Cursor se une al equipo en el chat de agente de la app de Cursor en macOS, y en la línea de comandos `cursor-agent` en Linux y macOS. Usa la misma memoria que tus otros agentes. Un chat empieza con un resumen breve del repositorio, cada mensaje trae hasta tres cosas que Cursor aún no ha visto, y cada mensaje y respuesta se recuerda. Lee las mismas habilidades, revisa y es revisado, toma el relevo cuando a otro agente se le acaba la cuota, y sus chats alimentan Self Learning como los de los demás.

Ejecuta `cursor-agent login` una vez. `sno setup` encuentra Cursor por sí solo e instala su línea de comandos si solo está la app.

Aún no: en la app, el primer chat de una ventana nueva recibe su resumen con el primer mensaje, no antes. `cursor-agent -p` no recibe memoria por mensaje. No hay soporte para Windows, para la app de Cursor en Linux ni para los agentes en la nube de Cursor. Los detalles están en la [guía de Cursor](../../apps/mem-cursor/README.md).

<a id="account"></a>

## Mira lo que hicieron tus agentes mientras no mirabas

*Última actualización 2026-10-18.* Esta computadora recibe una décima parte de la asignación gratuita hasta que la vincules: `sno account claim`. La cuenta es gratuita. Conéctala para ver en tu [panel de sno.ai](https://www.sno.ai/dashboard) lo que tus agentes hicieron por ti: lo que detectaron sus revisiones, lo que aprendieron durante la noche, qué habilidades mejoraron y cuánto tiempo siguieron trabajando.

Conectar nunca crea una cuenta a tus espaldas. `sno setup` le da a cada computadora una identidad anónima. Al conectar, esa identidad se asocia a tu cuenta, y todo lo que la computadora envió antes y después cuenta como tuyo.

**Aún no tienes cuenta.** El onboarding muestra un enlace hecho solo para esta computadora. Ábrelo, regístrate y haz clic en Approve. O dale tu correo a tu agente: ejecuta `sno account login --email you@example.com` y tú inicias sesión una vez.

**Ya tienes una cuenta.** Ejecuta un comando, abre el enlace que imprime con tu sesión iniciada y haz clic en Approve:

```bash
sno account claim
```

La computadora aparece sola en [tu página de computadoras](https://www.sno.ai/dashboard/computers). No hay paso de actualización: `sno` se actualiza solo cuando encuentra una versión más nueva.

<a id="what-runs-today"></a>

## Qué puedes usar hoy y hasta dónde llega

*Última actualización 2026-11-04.*

| Pieza | Estado |
|---|---|
| Una sola memoria para Codex, Claude Code, Hermes Agent, Cursor y OpenClaw | Publicada; instalada desde el registro en una máquina limpia y probada de extremo a extremo |
| Cursor: la misma memoria, habilidades, revisión, relevo y Self Learning | Publicado en 1.3; la línea de comandos `cursor-agent` probada de extremo a extremo en una máquina Linux limpia; la app de Cursor en macOS aún en prueba |
| Sno Reach, agentes que hablan entre sí sin daemon | Instalado por `sno setup`; Linux y macOS; probado de extremo a extremo en una máquina Linux limpia |
| Self Learning y las habilidades del equipo | Instalado por `sno setup`; el trabajo nocturno se ejecutó en una máquina Linux limpia |
| Instalación con un solo comando | `sno setup` instala todo lo anterior; probada en una máquina Linux limpia |
| "Sno onboard" dentro de tu agente | Disponible; arranca tras la instalación, o cuando lo dices |
| Un solo comando inicia dos agentes | Nuevo en 2.0; ejecutado con agentes reales de Claude Code y Codex, uno de cada uno y dos del mismo proveedor |
| Ver quién te necesita: línea de estado, barra de tmux, `sno squad` | Nuevo en 2.0; ejecutado con agentes reales de Claude Code y Codex pidiendo permiso, y la línea de estado en Claude Code y Cursor reales |
| El trabajo interrumpido continúa, y una tarea sobrevive a la compactación | Nuevo en 2.0; ejecutado con agentes reales de Claude Code y Codex |
| Una lección aprobada funciona desde la próxima respuesta | Nuevo en 2.0; ejecutado con agentes reales de Claude Code y Codex |
| Los mensajes esperan mientras escribes o un agente compacta su contexto | Nuevo en 2.0; ejecutado con agentes reales de Claude Code y Codex |

Una fila dice "probado" solo cuando se ha ejecutado en una máquina limpia.

Aún no: la continuación de tareas y las lecciones desde la próxima respuesta funcionan en Claude Code y Codex. La línea de estado funciona en Claude Code y Cursor. Hermes Agent y OpenClaw no han pasado por estos recorridos en instalaciones reales, y OpenClaw aparece en `sno squad` con su estado desconocido.

<a id="memory"></a>

## Memoria que olvida a propósito

*Última actualización 2026-10-11.* La memoria de un agente suele fallar de dos maneras silenciosas. Pierde lo que debería haberse quedado, y conserva lo que debería haberse desvanecido. El segundo fallo cuesta más. Un agente que todavía "recuerda" una preferencia que cancelaste, una fecha límite que se movió o una dirección que dejaste actuará según ella con total seguridad.

Por eso la memoria de aquí retira un hecho cuando uno posterior lo reemplaza, y lo que conserva y lo que deja ir mejora con el uso, no con el lanzamiento de un modelo. Cómo le va en las pruebas públicas de memoria, con cada respuesta y cada traza que la respalda, está en [`evals/`](../../evals/).

## ¿Usas dos agentes a la vez? Escríbenos

Estamos trabajando con un puñado de personas que ya usan dos o más agentes en paralelo y pasan los resultados de uno a otro a mano. Si eres tú, abre un [design partner issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml) y cuéntanos qué usas.

## Qué protege el cifrado y qué no

Consulta [SECURITY.md](../../SECURITY.md). Lo que protege el cifrado y lo que no está en [docs/security.md](../security.md).

## Apache-2.0, de punta a punta

Apache-2.0. Código abierto, de punta a punta. Consulta [LICENSE](../../LICENSE).

## Los hombros en los que nos apoyamos

Trabajos en los que se apoya este repositorio.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Un agente debería mantener una wiki de lo que ha aprendido en lugar de volver a deducirlo en cada sesión.
- Tang, Rashtchian, Ferng, Tomkins, Juan y Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). La propia experiencia de un agente, convertida en conocimiento que reescribe sus habilidades.
- Zhang, Hu, Upasani y colaboradores, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). Estudiamos su manera de curar lo que un agente conserva al diseñar Self Learning.
- Uddin, Shubham, Blanco, Baral y Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). El primer benchmark que también comprueba lo que una memoria ya no debería decir.
