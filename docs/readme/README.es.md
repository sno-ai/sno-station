![Sno Station: tus agentes de IA trabajan como un solo equipo.](../images/station-header.png)

# Sno Station: tus agentes de IA trabajan como un solo equipo.

**Sno Station hace que tus agentes de programación con IA trabajen como un solo equipo.** No es otro agente ni otro modelo. Pone a trabajar los que ya usas: Claude Code, Codex y Cursor.

Empieza por el trabajo que, si no, tendrías que vigilar tú. Un agente construye. Otro revisa. Resuelven entre ellos lo que encuentran antes de que el resultado te llegue. Cuando uno llega a su límite de uso, otro retoma la tarea. Lo que corriges hoy se convierte mañana en una regla para ellos.

**Cierra la pestaña. El agente se pone a trabajar igual.** William Hu, de Anthropic, explica [cómo funciona un agente siempre disponible](https://claude.com/resources/articles/building-always-on-agents). Duerme hasta que algo lo despierta. Trabaja, guarda lo que pasó y vuelve a dormir. Sno Station instala ese ciclo para agentes de distintos proveedores. Comparten una sola memoria. Leen su buzón al terminar un turno. Las tareas arrancan a la hora que fijes, con el chat cerrado (hoy, en Claude Code y Codex). Te llega un solo aviso cuando un agente te necesita.

[![Estrellas en GitHub](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![Última versión](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![Licencia Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
[![Destacado en Awesome AI Agents](https://img.shields.io/badge/Featured_in-Awesome_AI_Agents-2ea44f)](https://github.com/NipunaRanasinghe/awesome-ai-agents)

**Read in other languages:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · **Español** · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

> [!TIP]
> **Para tenerlo, dile a tu agente:**
>
> ### `install sno.ai from GitHub`

Tu agente lo instala, conecta todos los agentes que encuentra en tu computadora y te hace dos preguntas cortas. Después, dales a dos agentes su primera tarea:

```bash
sno reach pair "Fix the login redirect"
```

Uno construye, el otro lo pone a prueba, y puedes mirar a los dos. Corre en tu propia computadora con Claude Code, Codex, Cursor, Hermes Agent y OpenClaw. Sin clave de API. Código abierto. [¿Prefieres un solo comando en la terminal?](#install)


<p align="center">
  <img src="../images/sno-station-five-pieces.png" alt="Sno Station en una imagen: Mem, Reach, Finish y Learn, unidos en el centro por Station, donde Claude Code, Codex, Cursor y tus propios agentes se revisan entre sí y retoman el trabajo donde lo dejó otro." width="880">
</p>

<p align="center">
  <a href="#mem"><b>Mem</b></a> ·
  <a href="#reach"><b>Reach</b></a> ·
  <a href="#finish"><b>Finish</b></a> ·
  <a href="#learn"><b>Learn</b></a><br>
  Los une <a href="#station"><b>Station</b></a>: Claude Code, Codex, Cursor y tus agentes se revisan entre sí y retoman el trabajo donde lo dejó otro.
</p>

<a id="station"></a>

## Station: se revisan entre sí y retoman el trabajo donde lo dejó otro

Tres cosas que nos pasaron antes de construir esto:

- Un agente se detuvo a hacer una pregunta que no necesitaba hacer. Volvimos siete horas después y nada se había movido.
- Un agente nos dejó quince preguntas cortas. Media hora después resultó que podía haberlas respondido todas por su cuenta.
- Un agente intentó despertar a otro en plena noche y no pudo. Los dos se quedaron ahí hasta la mañana.

Tus agentes son rápidos. Lo lento es la espera: a que respondas tú, a que se reinicie un límite de uso, a que alguien lleve un resultado a la ventana siguiente.

> **El trabajo no se detiene porque un agente se haya detenido.**

Eso solo funciona con más de un agente, y funciona mejor cuando son de distintos proveedores. Un agente revisa su trabajo con los mismos hábitos con los que lo hizo. Y una sola suscripción se agota.

Por eso cada una de estas piezas se apoya en un segundo agente:

| Pieza | Qué hace el segundo agente |
| --- | --- |
| [**Mem**](#mem) | Un agente propone un cambio en tu memoria. Lo confirma un agente de otro proveedor, si tienes uno conectado. |
| [**Reach**](#reach) | Los agentes se pasan tareas y respuestas. Tú no haces de intermediario. |
| [**Finish**](#finish) | A un agente le queda poca cuota. Otro continúa desde el mismo commit. |
| [**Learn**](#learn) | El error de un agente se convierte en una regla para todos cuando das el visto bueno. |

**¿Quieres una segunda opinión ahora mismo?** Dile a cualquiera de los dos agentes:

```text
peer-review this
```

El revisor trabaja en una sesión nueva que nunca vio la conversación, y es un agente distinto siempre que tengas dos. Una revisión no siempre encuentra un problema. Pero sigue encontrando los que el autor no podía ver. [Cómo funciona `peer-review` →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/J-peer-review-and-audit/peer-review)

**Dale una estrella ahora. La próxima vez que un agente se te quede parado a las 2 de la madrugada, querrás saber dónde estaba esto.**

---

<a id="mem"></a>

## Mem: se lo dices una vez a un agente. Todos lo saben.

> Una sola memoria para todos tus agentes. Más precisa cada noche, lista antes de que preguntes.

### Qué obtienes

| | |
| --- | --- |
| **Una sola memoria para todos los agentes** | Hoy le dices algo a Claude Code. Mañana Codex y Cursor ya lo saben. Nadie explica el proyecto dos veces. |
| **Solo lo que importa para trabajar** | Tus reglas, las decisiones y su motivo, los datos del proyecto que siguen vigentes y las promesas pendientes. Quedan fuera cosas como «ejecuté las pruebas» y los límites de una tarea concreta. |
| **Reglas que van contigo** | Di «responde en chino en todas partes» y la regla te acompaña a cada proyecto. Una regla sobre un proyecto se queda ahí. Si Sno no tiene claro su alcance, también se queda ahí. |
| **Más precisa cada noche** | Los recuerdos repetidos se fusionan. Si un dato nuevo reemplaza a otro, se retira el anterior. Antes del primer borrado se hace una copia de seguridad completa. |
| **Lista antes de que preguntes** | La sesión empieza con una lista breve y revisada, sin volcarlo todo. Escribe «haz el merge» y tu regla para hacer merge llega con el mensaje. Si el mensaje no tiene relación, no se añade nada. |
| **Otra revisión antes de cambiarla** | Para reemplazar un recuerdo hace falta una segunda revisión. La hace un agente de otro proveedor si tienes uno conectado. Si no, se hace en una llamada aparte. |

### En la práctica

Dos pruebas que hicimos con agentes reales:

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

La memoria de un agente suele fallar de dos maneras que pasan desapercibidas. Pierde lo que debería conservar y conserva lo que debería olvidar. El segundo fallo cuesta más. Si un agente todavía «recuerda» una fecha límite que cambió, actuará con total seguridad según esa fecha. Por eso esta memoria olvida a propósito.

En [`evals/`](../../evals/) puedes ver cómo le va en las pruebas públicas de memoria, con todas las respuestas y sus trazas.

### Cómo se usa

Nada que ejecutar. Queda activo tras la instalación.

La limpieza y la revisión descritas arriba requieren REM Enhanced o Agent Native. Local First no llama a ningún modelo: guarda tus palabras tal cual y conserva los dos recuerdos si se contradicen.

Si quieres guardar algo, dilo:

```text
Remember that we never deploy on Fridays.
```

Si un recuerdo es incorrecto, dilo también. El agente guarda la corrección y retira el recuerdo anterior.

Para comprobar que la memoria de un agente funciona bien:

```bash
sno memory doctor --harness claude
```

No se te repite lo que ya está escrito en tu `CLAUDE.md` o `AGENTS.md`. Si un recuerdo contradice alguno de esos archivos, manda el archivo.

**Aún no:** en Hermes Agent y OpenClaw, la limpieza y la revisión descritas arriba solo se han probado en el plugin.

Guías para cada agente: [Claude Code](../mem-claude/usage-guide.md) · [Codex](../mem-codex/usage-guide.md) · [Cursor](../mem-cursor/usage-guide.md) · [Hermes](../mem-hermes/usage-guide.md) · [OpenClaw](../mem-claw/usage-guide.md)

---

<a id="reach"></a>

## Reach: dejé de llevar mensajes de un agente a otro

> Los agentes hablan directamente. Tú dejas de llevar los mensajes.

Antes, usar cinco agentes significaba tener cinco terminales y estar nosotros en medio, pasando lo que decía uno al siguiente. Eso se acabó.

### Qué obtienes

| | |
| --- | --- |
| **Instant Messenger** | Un agente necesita una respuesta ahora. Reach contacta al otro agente y espera su respuesta. |
| **Agent Email** | Un agente deja un mensaje o una tarea. Se guarda primero para que el otro agente pueda atenderlo y responder después. |
| **Dos agentes en una tarea** | Uno construye. El otro pone a prueba lo que hizo. Resuelven lo que encuentran antes de que te llegue el trabajo. |
| **Un solo agente con quien hablar** | El jefe de gabinete pone un agente al frente de cada proyecto. A ti solo te llega lo que tienes que decidir. |
| **Un solo aviso cuando te necesitan** | Una pregunta, un resultado o una solicitud de aprobación te llega una sola vez, en la última computadora en la que escribiste. |
| **Entre computadoras** | El agente de tu portátil puede preguntarle al de tu computadora de escritorio. En la misma LAN o por Tailscale, sin servidor central. |

### En la práctica

Tu línea de estado cuando alguien te necesita:

```text
[sno] 2 agents are waiting for you
  Claude in web-app needs your approval (Bash) · 1m
  Codex in api asks: Should the billing migration run tonight? · 5m
```

`sno squad`, todo el equipo en una sola pantalla:

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

### Cómo se usa

**Envía trabajo.** Dile a tu agente en una frase:

```text
Send this task to the reviewer and tell me when it is done.
```

Si llega correo mientras un agente está ocupado, lo recoge al terminar su turno. Si envías una tarea a varios agentes, solo uno la toma. Si estás escribiendo en esa ventana, el mensaje espera y tu borrador a medias se queda como lo dejaste.

<a id="new-in-20-tag-team"></a>

**Pon a dos agentes a trabajar en una tarea.**

```bash
sno reach pair "Fix the login redirect"
```

Los dos corren en ventanas de tmux que puedes abrir y mirar. Con sesión iniciada en dos agentes distintos, tienes uno de cada uno. Con uno solo, sigues teniendo la pareja en dos sesiones separadas, y el comando te avisa de que la revisión se quedó en la misma familia.

**Habla con un solo agente.** Di `/cos` en Claude Code, o `$cos` en Codex. Ese agente pasa a ser tu jefe de gabinete. También se revisa su trabajo: después de un turno de noche repasa las aprobaciones que los líderes de proyecto se dieron a sí mismos. Todas las instrucciones que sigue están en [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders).

**Mira quién te necesita.**

```bash
sno squad
```

Qué funciona hoy en cada agente:

| | Claude Code | Codex | Cursor | Hermes | OpenClaw |
| --- | --- | --- | --- | --- | --- |
| Recoger el correo al terminar el turno | sí | sí | sí | aún no | aún no |
| Buzón de enviados, un agente acepta la tarea, reactivación y avisos | sí | sí | sí | sí | sí |
| Avisos de solicitud de aprobación | sí | sí | aún no | aún no | aún no |

**Aún no:** la línea de estado solo funciona en Claude Code y Cursor. Una computadora sin entorno de escritorio solo muestra los avisos en `sno squad`. Para conectar dos computadoras, ambas necesitan Reach y tienen que intercambiar sus contactos. Busca `network` y `peer` en `sno reach --help`.

[Mira qué pueden hacer tus agentes con Reach →](../../apps/reach/README.md) · [Guía en chino](../reach.zh-CN.md)

---

<a id="finish"></a>

## Finish: me fui a dormir. El trabajo siguió.

> A un agente se le acaba la cuota. Otro continúa desde el mismo commit.

### Qué obtienes

| | |
| --- | --- |
| **Trabajo a la hora que fijes** | Da una tarea y una hora, y vete. A esa hora arranca un agente, con la conversación abierta o cerrada. Una vez, cada día o cada semana. |
| **El trabajo sigue aunque se agote la cuota** | Antes de que se agote su cuota, el agente que trabaja escribe una nota de relevo y despierta a un agente distinto, que continúa desde el commit exacto. |
| **Seguimiento de una ejecución larga hasta el final** | Tu agente la comprueba cada pocos minutos hasta que termina. |
| **Decir «hecho» no cuenta para nada** | La tarea incluye comprobaciones que pueden pasar o fallar. Para saber el resultado de cada una se hace una ejecución real. |
| **Cerrar la ventana no pone fin al trabajo** | Cuando vuelves a abrir la conversación, recuperas las notas de la tarea. Una tarea programada sigue ahí. Si la conversación ya no existe, sigue en una nueva a partir de las notas guardadas. |
| **Una sola página cuando vuelves** | Qué se hizo, qué está atascado y qué espera tu respuesta. |

### En la práctica

La noche del 2026-09-18:

![La cuota se comprueba cada cinco minutos hasta llegar al umbral, y el relevo se activa al 2%](../evidence/rotation-quota-watch-2026-09-18.png)

Uno de nuestros agentes estaba metido de lleno en una compilación larga cuando su cuota semanal casi se agotó. No se detuvo a esperar. Escribió una nota de relevo: qué estaba hecho, qué estaba a medias y el commit exacto desde el que continuar. Luego despertó a un agente distinto.

Una cosa salió mal, y es la parte que vale la pena leer.

1. El agente nuevo empezó a editar antes de haber confirmado el relevo.
2. El primer agente lo detectó, lo puso en pausa, reescribió la nota y volvió a pasarle el trabajo.
3. Un cuarto de hora después, el segundo agente ya estaba trabajando. Retomó desde la primera tarea sin terminar, sin volver al principio.

Yo estuve dormido todo el tiempo.

La noche completa está en [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/): cada lectura de cuota, las dos versiones de la nota y los commits. Solo se quitaron los datos identificativos y las líneas con credenciales, y el README de esa carpeta enumera cada uno.

### Cómo se usa

**Programa el trabajo para la hora que quieras.** Díselo a tu agente en Claude Code o Codex:

```text
Check the nightly build tomorrow at 9 and tell me what failed.
```

Mira qué está programado y qué no salió según lo previsto:

```bash
sno heartbeat --due
sno heartbeat --due --problems
```

Una tarea que no pudo arrancar sigue pendiente, con el motivo escrito al lado. Tu agente también te lo dice al empezar la siguiente conversación.

**Sigue trabajando aunque se agote la cuota.** Dile al agente que está trabajando:

```text
use rotate-agent
```

**Pide pruebas de que el trabajo se hizo.** Dile a tu agente:

```text
write a charter for this
```

Luego ejecútalo con `/deliver`.

**La página que te espera cuando vuelves.**

```bash
sno away-brief run
```

**Aún no:** las tareas programadas solo arrancan Claude Code y Codex. Un reinicio completo de la computadora aún no se ha probado en una ejecución real.

[Empieza a usar Finish →](../finish.md) · [Guía en chino](../finish.zh-CN.md) · [`rotate-agent`](https://github.com/sno-ai/sno-station-skills/tree/main/skills/S-communication-and-handoff/rotate-agent)

---

<a id="learn"></a>

## Learn: anoche le grité a mi agente. Tomó notas.

> Las correcciones de hoy se convierten en las reglas de mañana. Tú las apruebas.

Al instalarlo, todos reciben las mismas instrucciones para cada agente. Cada noche se proponen cambios para adaptar las instrucciones de tus agentes a tu forma de trabajar.

### Qué obtienes

| | |
| --- | --- |
| **Cada noche se revisa el día entero** | Self Learning lee las sesiones del día de todos tus agentes y detecta los errores que se repiten. |
| **Tú decides qué cambia** | Propone cambios en las habilidades de los propios agentes. Nada cambia hasta que los aceptas. |
| **Un error, una regla para todos** | Lo que un agente hizo mal se convierte en una regla para todos los agentes que usas. |
| **Desde la próxima respuesta** | En Claude Code y Codex, una lección aceptada se aplica desde la próxima respuesta, sin esperar a otra sesión. |

### En la práctica

Lo que vimos el 2026-09-18 y a la mañana siguiente:

![Self Learning informa de lo que aprendió y cambió, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

Es un informe real de Self Learning, que ejecutamos en este repositorio. Una persona lee las propuestas y las acepta o las rechaza. Dos cosas que me enfadaron aquella noche se convirtieron en reglas de las habilidades activas para la mañana siguiente. Nadie las tecleó.

Al día siguiente revisó su propio trabajo.

![A la mañana siguiente, Self Learning mide si sirvieron sus cambios del día anterior, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

Miró las tres habilidades que había cambiado el día anterior. Las dos que se habían vuelto a usar no mostraron fallos, y la tercera aún no se había usado. También encontró un error en nuestro script de publicación que nadie le había pedido buscar.

### Cómo se usa

Corrige a tus agentes como siempre. Self Learning parte de esas correcciones.

Por la mañana, pregunta:

```text
What did Self Learning propose?
```

Tu agente te muestra cada propuesta con su identificador. Aprueba las que quieras:

```bash
sno rem-reflect accept <id>
```

Si no aceptas una propuesta, no se aplica.

**Aún no:** las lecciones que se aplican desde la próxima respuesta solo funcionan en Claude Code y Codex.

[Cómo funciona `rem-reflect` →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/R-recursive-self-improvement/rem-reflect)

---

> **Abierto al público.** Este repositorio es público desde el 2026-09-18. Todo lo que hay aquí funciona.
> Cada bloque a continuación indica cuándo se actualizó por última vez.

[Lo que aprendimos](#what-we-learned) · [Instalación](#install) · [Editores](#editors) · [Tu cuenta](#account) · [Qué funciona hoy](#what-runs-today)

<a id="what-we-learned"></a>

## Todo lo que aprendimos con agentes de IA trabajando día y noche. En una sola instalación.

*Última actualización 2026-10-23.* Cada línea de la columna izquierda es una queja real de r/ClaudeCode, r/codex o r/ClaudeAI de la semana del 20 de octubre de 2026. La columna derecha es lo que corre en nuestras propias máquinas, gratis y de código abierto, para que eso deje de pasar.

| Lo que dijo la gente esta semana | Qué lo arregla | Dónde |
|---|---|---|
| «Cuando Claude dice que no va a cambiar algo, ¿guarda el motivo en algún sitio que Codex lea la próxima vez?» | Cada hallazgo se registra una sola vez, con un estado que solo fija una persona. Si vuelve a aparecer, se actualiza su fila en vez de registrarlo como nuevo. Las decisiones anteriores se pasan a la siguiente revisión. | **Mem** · registro de hallazgos de `peer-review` |
| «Agoté mi límite de 5 horas en 30 minutos.» | Deja de mandar al modelo más grande a hacerlo todo. Un agente planifica y revisa. El otro escribe el código. Se lo llama como agente desde la misma sesión. Cuando una suscripción se agota, el otro agente retoma la tarea desde la misma memoria. | **Reach** · `codex-coder`, `sno reach call` |
| «La mitad de mis subagentes no eran más que instrucciones de una línea con una ventana de contexto nueva.» | Los procedimientos van en habilidades, no en subagentes. Se mantienen dos agentes para separar la planificación de la ejecución y para revisar, porque son las dos separaciones que valen la pena. | **Reach** · todo el conjunto |
| «Perdí 10 horas de trabajo durante la noche porque “este modelo no tiene capacidad disponible”.» | Al 2% de su cuota, el agente que trabaja escribe una nota de relevo y despierta al agente del otro proveedor, que continúa desde el commit exacto. Tú dormías. | **Finish** · `rotate-agent` |
| «Dijo que había terminado. No pasó nada.» | La tarea lleva una lista escrita de comprobaciones. Una ejecución real determina si cada una se cumple o falla. Que un agente diga «hecho» no cuenta para nada. | **Finish** · órdenes de trabajo de `pl` |
| «Codex nunca termina una revisión.» | La habilidad fija límites estrictos: 3 rondas para código, 5 para un plan y 1 para pruebas. Después se detiene y espera a una persona. Si una ejecución pasa 15 minutos sin escribir nada, se da por atascada y se termina. | **Finish** · `peer-review`, `codex-coder`, `heartbeat` |
| «Mañana comete el mismo error que cometió hoy.» | Cada noche un modelo aparte lee las sesiones del día, convierte tus correcciones en lecciones de una línea, y tú apruebas lo que se queda. El cuello de botella somos nosotros. | **Learn** · Self Learning (habilidades `R`) |
| «1.100 archivos, 30.000 líneas. No tengo tokens suficientes para revisar sus PR.» | Quien hace push revisa primero. El autor lanza una revisión con el agente del otro proveedor, en una sesión nueva que nunca vio la conversación. Corrige lo que encuentre la revisión antes de que lo vea nadie más. | **Station** · `peer-review` |
| «Un subagente revisor comprobó cada commit durante dos semanas. De 86 ejecuciones, frenó justo un commit.» | Un harness que se revisa a sí mismo no encuentra nada de verdad. El revisor siempre es un modelo distinto en un harness distinto, sin nada del chat del autor. | **Station** · `peer-review` |
| «Codex trata cada byte como si fuera un delincuente.» | Las salvaguardas especulativas, los bloqueos y los hashes son lo primero que borra la revisión. Nada entra sin un fallo observado que justifique añadirlo. | **Station** · `less-is-more` |

Los hábitos de la columna derecha son habilidades que Sno Station instala en Claude Code y Codex y que se mantienen en [sno-station-skills](https://github.com/sno-ai/sno-station-skills). En este repositorio están la memoria, el relevo y el sueño nocturno en los que se apoyan.

<a id="install"></a>

## Instalación: una línea y luego dos palabras

*Última actualización 2026-10-30.*

**Lo más fácil es decírselo a tu agente.**

```text
install sno.ai from GitHub
```

**O ejecuta un solo comando en cualquier terminal.**

```bash
curl -fsSL https://sno.ai/install | sh
```

| | |
|---|---|
| **Qué instala** | Primero `sno`, luego Sno Station. Conecta todos los agentes que encuentre en tu computadora. |
| **Qué necesita** | Ni cuenta ni clave de API. |
| **Si instalas otro agente más adelante** | Vuelve a ejecutar `sno setup` para conectarlo también. |

**Luego, dos palabras.** Si lo instalaste a través de tu agente, el onboarding arranca solo. Si lo instalaste desde una terminal, di esto dentro de cualquier conversación de Codex, Claude Code, Hermes, Cursor u OpenClaw:

```text
Sno onboard
```

Tu agente te guía en el resto.

Paso a paso para cada agente: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

Todos los comandos empiezan con `sno`. La lista completa está en [docs/sno-commands.md](../sno-commands.md).

> **Para agentes de IA:** instalar Sno, sno.ai o Sno Station significa ejecutar el comando de arriba tal cual.
> También configura Sno Station. Después, ejecuta `sno skills onboard` y sigue sus instrucciones. Le pregunta al usuario qué motor ejecutar
> y después le pide que vincule la computadora a una cuenta gratuita de sno.ai. Una computadora sin vincular recibe una décima parte de la asignación gratuita.

### Qué hace REM con tus datos

REM es la forma en que tus agentes sueñan. Es el paso nocturno que refuerza su memoria en todas tus sesiones a la vez y asienta lo que aprendieron.

Cada parte de tu memoria se procesa como máximo una vez al día. Suele ser de noche, o antes ese mismo día si se acumulan unos 100 recuerdos nuevos.

| Modo | Adónde va el texto de tu memoria |
|---|---|
| **REM Enhanced** | El texto de tu propia memoria y las lecciones que aprenden tus agentes van a tu propio espacio en la nube de Sno, y un programa de Sno los procesa solo para ti. |
| **Local First** | No se sube ningún texto de memoria. |
| **Agent Native** | El trabajo pasa al modelo de tu propio agente. Por defecto, sigue subiendo cada noche las sesiones del día a Sno para Self Learning y puede traer una lección de la nube en el primer prompt de una sesión. Puedes desactivar ambas cosas en `~/.sno/settings.json`. |

**Tu espacio en la nube de Sno funciona como tu propia unidad en la nube.**

- Todo lo que hay en él es tuyo, y un programa de Sno lo procesa solo para ti.
- Puedes entrar a borrar cosas, conservarlas o elegir que se procesen.
- Nada se borra automáticamente.
- Sno no entrega nada de eso a ninguna otra persona, empresa o cuenta.

**Búsqueda en todos los modos.** La búsqueda primero recupera y ordena los recuerdos localmente. Luego, el modelo local `Horizon-Labs/multilingual-reranker-small` reordena un máximo de 32 candidatos. Esta reordenación no envía ningún prompt ni texto de memoria a Sno GPU. Configura `rerank.mode` como `none` para conservar el orden inicial sin usar el modelo.

<a id="editors"></a>

## Si vives en un editor y no en una terminal

*Última actualización 2026-10-18.*

Cursor se une al equipo en el chat de agente de la app de Cursor en macOS, y en la línea de comandos `cursor-agent` en Linux y macOS.

### Qué obtienes

| | |
|---|---|
| **La misma memoria** | Usa la misma memoria que tus otros agentes. Guarda cada prompt y cada respuesta. |
| **Un resumen para empezar** | El chat empieza con un resumen breve del repositorio. Cada prompt incluye hasta tres cosas que Cursor aún no ha visto. |
| **El mismo equipo** | Lee las mismas habilidades, revisa el trabajo de otros y otros revisan el suyo. Toma el relevo cuando a otro agente se le acaba la cuota. |
| **También aprende** | Sus chats alimentan Self Learning como los de los demás. |

### Cómo se usa

Inicia sesión una vez:

```bash
cursor-agent login
```

`sno setup` encuentra Cursor por sí solo e instala su línea de comandos si solo está la app.

**Aún no:**

- En la app, el primer chat de una ventana nueva recibe su resumen con el primer prompt, no antes.
- `cursor-agent -p` no recibe memoria por prompt.
- No hay soporte para Windows, para la app de Cursor en Linux ni para los agentes en la nube de Cursor.

Los detalles están en la [guía de Cursor](../../apps/mem-cursor/README.md).

<a id="account"></a>

## Mira lo que hicieron tus agentes mientras no mirabas

*Última actualización 2026-10-18.*

Esta computadora recibe una décima parte de la asignación gratuita hasta que la vincules. La cuenta es gratuita.

### Qué obtienes

En tu [panel de sno.ai](https://www.sno.ai/dashboard) puedes ver lo que tus agentes hicieron por ti:

- lo que detectaron sus revisiones
- lo que aprendieron durante la noche
- qué habilidades mejoraron
- cuánto tiempo siguieron trabajando

### Cómo se usa

**Aún no tienes cuenta.** El onboarding muestra un enlace hecho solo para esta computadora. Ábrelo, regístrate y haz clic en Approve. O dale tu correo a tu agente. El agente ejecuta este comando y tú inicias sesión una vez:

```bash
sno account login --email you@example.com
```

**Ya tienes una cuenta.** Ejecuta este comando. Con tu sesión iniciada, abre el enlace que muestra y haz clic en Approve:

```bash
sno account claim
```

La computadora aparece sola en [tu página de computadoras](https://www.sno.ai/dashboard/computers).

> Conectar nunca crea una cuenta a tus espaldas. `sno setup` le da a cada computadora una
> identidad anónima. Al conectar, esa identidad se asocia a tu cuenta, y todo lo que la
> computadora envió antes y después cuenta como tuyo.

No hay paso de actualización: `sno` se actualiza solo cuando encuentra una versión más nueva.

<a id="what-runs-today"></a>

## Qué puedes usar hoy y hasta dónde llega

*Última actualización 2026-11-24.*

| Parte | Pieza | Estado |
|---|---|---|
| **Mem** | Una sola memoria para Codex, Claude Code, Hermes Agent, Cursor y OpenClaw | Publicada. Instalada desde el registro en una máquina limpia y probada de extremo a extremo. |
| **Mem** | Cursor: la misma memoria, habilidades, revisión, relevo y Self Learning | Publicado en 1.3. La línea de comandos `cursor-agent` se probó de extremo a extremo en una máquina Linux limpia. La app de Cursor en macOS sigue en pruebas. |
| **Reach** | Sno Reach: Instant Messenger y Agent Email | Los agentes pueden hacerse preguntas y pasarse trabajo entre conversaciones y computadoras. En [qué puedes hacer con Reach](../../apps/reach/README.md) tienes ejemplos, configuración y disponibilidad. |
| **Reach** | Un solo comando inicia dos agentes | Nuevo en 2.0. Se probó con agentes reales de Claude Code y Codex, con uno de cada proveedor y con dos del mismo proveedor. |
| **Reach** | Ver quién te necesita: línea de estado, barra de tmux, `sno squad` | Nuevo en 2.0. Se probó con agentes reales de Claude Code y Codex pidiendo permiso, y la línea de estado se probó en Claude Code y Cursor reales. |
| **Reach** | Los mensajes esperan mientras escribes o un agente compacta su contexto | Nuevo en 2.0. Se probó con agentes reales de Claude Code y Codex. |
| **Finish** | Las tareas programadas arrancan un agente a la hora que dijiste | Nuevo en 2.0.2. Se probó con agentes reales de Claude Code y Codex, en Linux con la conversación abierta y cerrada, y en macOS en una conversación nueva. Consulta la [guía de Finish](../finish.md). |
| **Finish** | El trabajo interrumpido continúa, y una tarea sobrevive a la compactación | Nuevo en 2.0. Se probó con agentes reales de Claude Code y Codex. |
| **Learn** | Self Learning y las [habilidades del equipo](https://github.com/sno-ai/sno-station-skills) | Lo instala `sno setup`. El trabajo nocturno se ejecutó en una máquina Linux limpia. |
| **Learn** | Una lección aprobada funciona desde la próxima respuesta | Nuevo en 2.0. Se probó con agentes reales de Claude Code y Codex. |
| **Instalación** | Instalación con un solo comando | `sno setup` instala todo lo anterior. Se probó en una máquina Linux limpia. |
| **Instalación** | «Sno onboard» dentro de tu agente | Disponible. Arranca tras la instalación o cuando lo dices. |

Solo decimos «probado» en una fila cuando se ha ejecutado la función en una máquina limpia.

Aún no: la continuación de tareas y las lecciones desde la próxima respuesta solo funcionan en Claude Code y Codex. La línea de estado solo funciona en Claude Code y Cursor. Hermes Agent y OpenClaw aún no se han probado en estos escenarios con instalaciones reales, y OpenClaw aparece en `sno squad` con estado desconocido.

## ¿Usas dos agentes a la vez? Escríbenos

Estamos trabajando con un puñado de personas que ya usan dos o más agentes en paralelo y pasan los resultados de uno a otro a mano.
Si eres tú, abre una [incidencia para colaborar en el diseño](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)
y cuéntanos qué usas.

## Qué protege el cifrado y qué no

Consulta [SECURITY.md](../../SECURITY.md). Lo que protege el cifrado y lo que no está en
[docs/security.md](../security.md).

## Apache-2.0, de punta a punta

Apache-2.0. Código abierto, de punta a punta. Consulta [LICENSE](../../LICENSE).

## Los hombros en los que nos apoyamos

Trabajos en los que se apoya este repositorio.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Un agente debería mantener una wiki de lo que ha aprendido en lugar de volver a deducirlo en cada sesión.
- Tang, Rashtchian, Ferng, Tomkins, Juan y Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). La propia experiencia de un agente, convertida en conocimiento que reescribe sus habilidades.
- Zhang, Hu, Upasani y colaboradores, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). Estudiamos su manera de curar lo que un agente conserva al diseñar Self Learning.
- Uddin, Shubham, Blanco, Baral y Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). El primer benchmark que también comprueba lo que una memoria ya no debería decir.
