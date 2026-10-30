# Sno Station — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — Agents, assemble. Dos cabezas piensan mejor que una, y por la mañana son más listas.](../images/hero-banner.png)

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
  <br><sub>Funciona con Codex · Claude Code · Hermes Agent · Cursor · OpenClaw</sub>
</p>

**Leer en otros idiomas:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · **Español** · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

Sno Station convierte los agentes que ya usas en un equipo. Codex, Claude Code, Cursor, Hermes Agent
y OpenClaw usan una sola memoria, se pasan el trabajo entre sí y revisan el trabajo de los
demás cuando se lo pides. Cada noche repasan el día y mejoran un poco.

Funciona en tu propia computadora. Lo instalas una vez y sigues trabajando como hasta ahora. Más información en nuestro sitio web, [sno.ai](https://sno.ai).

**Cuando a un agente se le acaba el límite, el siguiente continúa.** Si llegas a un límite de uso
a mitad de una tarea, otro agente la retoma desde la misma memoria, con el contexto intacto.
No tienes que pegar nada.

**Una segunda revisión a petición.** Cualquiera de los agentes puede revisar el trabajo del otro. El revisor siempre es un agente distinto, así que no tiene el hábito de darle la razón al primero.

**Tus agentes sueñan.** Cada noche, mientras duermes, tus agentes pasan por REM. Lo llamamos así por Rapid Eye Movement, la fase del sueño en la que el cerebro humano refuerza sus recuerdos y asienta lo aprendido durante el día. REM refuerza su memoria en todas tus sesiones a la vez, para que recuerden lo que importa y suelten lo que ya no es cierto. Autoaprendizaje asienta su experiencia: lee las sesiones del día, encuentra los errores que se repiten y propone cambios en las habilidades de tus agentes, para que el tropiezo de ayer sea el mejor hábito de hoy. Lees las propuestas por la mañana y nada cambia hasta que digas que sí.

**Sigue siendo tuyo.** La memoria, los mensajes y las habilidades viven en tu computadora. La
memoria está cifrada con una clave que nunca sale de ella. Sin cuenta, sin servidor, sin daemon.
El lado en la nube es opcional, y el producto está completo sin él.

**Qué hace REM con tus datos.** REM es el paso nocturno que ordena tu memoria en todas tus sesiones a la vez. Se ejecuta como máximo una vez al día para cada parte de tu memoria: normalmente de noche, o antes ese mismo día si se acumulan unos 100 recuerdos nuevos. En el modo REM Enhanced, el texto de tu propia memoria y las lecciones que aprenden tus agentes van a tu propio espacio en la nube de Sno, y un programa de Sno los procesa solo para ti. Ese espacio funciona como tu propia unidad en la nube: todo lo que hay en él es tuyo, y un programa de Sno lo procesa solo para ti. Puedes entrar a borrar cosas, conservarlas o elegir que se procesen. Nada se borra automáticamente, y Sno no entrega nada de eso a ninguna otra persona, empresa o cuenta. En el modo Local First no se sube ningún texto de memoria; en el modo Agent Native el trabajo pasa, en su lugar, al modelo de tu propio agente. Por defecto, Agent Native sigue subiendo cada noche las sesiones del día a Sno para Autoaprendizaje, y puede traer una lección de la nube en el primer prompt de una sesión; puedes desactivar ambas cosas en `~/.sno/settings.json`. En todos los modos, la búsqueda primero recupera y ordena los recuerdos localmente; después, el modelo local `Horizon-Labs/multilingual-reranker-small` reordena un máximo de 32 candidatos. Esta reordenación no envía el mensaje ni el texto de los recuerdos a Sno GPU. Configura `rerank.mode` como `none` para conservar el orden inicial sin usar el modelo.

![Cómo funciona: dos agentes, un mismo espacio de trabajo, tres cosas que obtienes](../images/squad-how-it-works.png)

> **Abierto al público.** Este repositorio es público desde el 2026-09-18. Todo lo que hay aquí funciona.
> Cada bloque a continuación indica cuándo se actualizó por última vez.

[Instalación](#instalación) · [Cómo usarlo](#cómo-usarlo) · [Cursor](#cursor) · [Conecta tu cuenta](#conecta-tu-cuenta-de-snoai) · [Casos reales](#de-nuestras-propias-máquinas) · [Qué funciona hoy](#qué-funciona-hoy) · [Memoria que olvida a propósito](#memoria-que-olvida-a-propósito) · [Socios de diseño](#socios-de-diseño)

## Instalación

*Última actualización 2026-10-30.* La forma más fácil es decirle a tu agente:

```text
install sno.ai from GitHub
```

O ejecuta un solo comando, en cualquier terminal:

```bash
curl -fsSL https://sno.ai/install | sh
```

Instala `sno`, luego Sno Station, y conecta todos los agentes que encuentre en tu computadora. Sin
cuenta y sin clave de API. Si más adelante instalas otro agente, vuelve a ejecutar `sno setup` para conectarlo también.

**Para agentes de IA:** instalar Sno, sno.ai o Sno Station significa ejecutar el comando de arriba
tal cual. También configura Sno Station; después ejecuta `sno skills onboard` y síguelo. Pregunta al usuario qué
motor ejecutar y después le pide que vincule la computadora a una cuenta gratuita de sno.ai;
una computadora sin vincular recibe una décima parte de la asignación gratuita.

Después, di esto dentro de cualquier conversación de Codex, Claude Code, Hermes, Cursor u OpenClaw:

```text
Sno onboard
```

Tu agente te guía en el resto. También arranca solo justo después de la instalación.

Paso a paso para cada agente: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

Todos los comandos empiezan con `sno`. La lista completa está en [docs/sno-commands.md](../sno-commands.md).

## Cómo usarlo

*Última actualización 2026-10-18.* Sigue trabajando con el agente que prefieras. Cambian tres cosas.

1. **Uno de ellos llega a su límite.** Di `sno reach call` desde el otro. Retoma la tarea desde
   la misma memoria y el buzón, con el contexto intacto.
2. **Quieres un segundo par de ojos.** Pide a cualquiera de los dos agentes que haga `peer-review`
   del trabajo del otro. El revisor siempre viene del otro harness.
3. **Cada noche corre Autoaprendizaje.** Por la mañana, `sno rem-reflect accept <id>` para las
   propuestas que te gusten. Sin ese accept, nada cambia.

## Cursor

*Última actualización 2026-10-18.* Cursor se une al equipo en el chat de agente de la app de Cursor
en macOS, y en la línea de comandos `cursor-agent` en Linux y macOS. Usa la misma memoria que
tus otros agentes. Un chat empieza con un resumen breve del repositorio, cada mensaje trae hasta
tres cosas que Cursor aún no ha visto, y cada mensaje y respuesta se recuerda. Lee las mismas
habilidades, revisa y es revisado, toma el relevo cuando a otro agente se le acaba la cuota, y sus
chats alimentan Autoaprendizaje como los de los demás.

Ejecuta `cursor-agent login` una vez. `sno setup` encuentra Cursor por sí solo e instala su línea
de comandos si solo está la app.

Aún no: en la app, el primer chat de una ventana nueva recibe su resumen con el primer mensaje, no
antes. `cursor-agent -p` no recibe memoria por mensaje. No hay soporte para Windows, para la app de
Cursor en Linux ni para los agentes en la nube de Cursor. Los detalles están en la [guía de Cursor](../../apps/mem-cursor/README.md).

## Conecta tu cuenta de sno.ai

*Última actualización 2026-10-18.* Esta computadora recibe una décima parte de la asignación gratuita hasta que la vincules: `sno account claim`.
La cuenta es gratuita. Conéctala para ver en
tu [panel de sno.ai](https://www.sno.ai/dashboard) lo que tus agentes hicieron por ti: lo que
detectaron sus revisiones, lo que aprendieron durante la noche, qué habilidades mejoraron y cuánto
tiempo siguieron trabajando.

Conectar nunca crea una cuenta a tus espaldas. `sno setup` le da a cada computadora una identidad
anónima. Al conectar, esa identidad se asocia a tu cuenta, y todo lo que la computadora envió antes
y después cuenta como tuyo.

**Aún no tienes cuenta.** El onboarding muestra un enlace hecho solo para esta computadora. Ábrelo,
regístrate y haz clic en Approve. O dale tu correo a tu agente: ejecuta
`sno account login --email you@example.com` y inicias sesión una vez.

**Ya tienes una cuenta.** Ejecuta un comando, abre el enlace que imprime con tu sesión iniciada y pulsa «Approve»:

```bash
sno account claim
```

La computadora aparece sola en [tu página de computadoras](https://www.sno.ai/dashboard/computers).
No hay paso de actualización: `sno` se actualiza solo cuando encuentra una versión más nueva.

## De nuestras propias máquinas

*Última actualización 2026-10-18.* Tres cosas que vimos en este repositorio.

### "Anoche le grité a mi agente. Tomó notas."

![Autoaprendizaje informando lo que aprendió y cambió, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

Es un informe real de Autoaprendizaje que ejecutamos en este repositorio. Lee las sesiones de
nuestros propios agentes, encuentra los errores que se repiten y propone cambios a las habilidades
de los propios agentes. Una persona lee las propuestas y las acepta o rechaza. Dos cosas que me
molestaron esa tarde eran reglas en las habilidades activas a la mañana siguiente. Nadie las escribió.

Al día siguiente revisó su propia tarea.

![A la mañana siguiente: Autoaprendizaje mide si los cambios del día anterior ayudaron, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

Miró las tres habilidades que había cambiado el día anterior, y los fallos en las tres se habían
detenido. También encontró un error en nuestro script de publicación que nadie le había pedido buscar.

### "Me fui a dormir. Cambió de turno."

![La vigilancia de cuota leyendo hasta el umbral cada cinco minutos, y el relevo activándose al 2 %](../evidence/rotation-quota-watch-2026-09-18.png)

Uno de nuestros agentes estaba a mitad de una compilación larga cuando su cuota semanal casi se
agotó. No se detuvo a esperar. Escribió una nota de relevo: qué estaba hecho, qué estaba a medias y
el commit exacto desde el que continuar. Luego despertó a un agente del otro harness.

Una cosa salió mal, y es la parte que vale la pena leer. El agente nuevo empezó a editar antes de
haber confirmado el relevo. El primer agente lo detectó, lo pausó, reescribió la nota y entregó de
nuevo, como correspondía. Un cuarto de hora después el segundo agente estaba trabajando, y retomó
desde la primera tarea sin terminar, no desde el principio. Yo estuve dormido todo el tiempo.

La noche completa está en [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/):
cada lectura de cuota, las dos versiones de la nota y los commits. Los nombres de host, las
direcciones y los ids de sesión están tachados. No se toca nada más.

### "En meses, el otro nunca ha dicho ni una vez 'se ve bien'."

Llevamos meses haciendo que Claude Code revise el trabajo de Codex, y Codex el de Claude Code, en
este repositorio. Ninguna revisión ha vuelto vacía. Antes pensábamos que eso significaba que el
trabajo era malo. Significa que un solo revisor de un solo harness nunca basta.

## Qué funciona hoy

*Última actualización 2026-10-18.*

| Pieza | Estado |
|---|---|
| Una sola memoria para Codex, Claude Code, Hermes Agent, Cursor y OpenClaw | Publicada; instalada desde el registro en una máquina limpia y probada de extremo a extremo |
| Cursor: la misma memoria, habilidades, revisión, relevo y Autoaprendizaje | Publicado en 1.3; la línea de comandos `cursor-agent` probada de extremo a extremo en una máquina Linux limpia; la app de Cursor en macOS aún en prueba |
| Sno Reach, agentes que hablan entre sí sin daemon | Instalado por `sno setup`; Linux y macOS; probado de extremo a extremo en una máquina Linux limpia |
| Autoaprendizaje y las habilidades del equipo | Instalado por `sno setup`; el trabajo nocturno se ejecutó en una máquina Linux limpia |
| Instalación con un solo comando | `sno setup` instala todo lo anterior; probada en una máquina Linux limpia |
| "Sno onboard" dentro de tu agente | Disponible; arranca tras la instalación, o cuando lo dices |

Una fila dice "probado" solo cuando se ha ejecutado en una máquina limpia.

## Memoria que olvida a propósito

*Última actualización 2026-10-11.* La memoria de un agente suele fallar de dos maneras silenciosas.
Pierde lo que debería haberse quedado, y conserva lo que debería haberse desvanecido. El segundo
fallo cuesta más. Un agente que todavía "recuerda" una preferencia que cancelaste, una fecha límite
que se movió o una dirección que dejaste actuará según ella con total seguridad.

Por eso la memoria de aquí retira un hecho cuando uno posterior lo reemplaza, y lo que conserva y
lo que deja ir mejora con el uso, no con el lanzamiento de un modelo. Cómo le va en las pruebas
públicas de memoria, con cada respuesta y cada traza que la respalda, está en [`evals/`](../../evals/).

## Socios de diseño

Estamos trabajando con un puñado de personas que ya usan dos o más agentes en paralelo y pasan los
resultados de uno a otro a mano. Si eres tú, abre un
[design partner issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)
y cuéntanos qué usas.

## Seguridad

Consulta [SECURITY.md](../../SECURITY.md). Lo que protege el cifrado y lo que no está en
[docs/security.md](../security.md).

## Licencia

Apache-2.0. Código abierto, de punta a punta. Consulta [LICENSE](../../LICENSE).

## Agradecimientos

Trabajos en los que se apoya este repositorio.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Un agente debería mantener una wiki de lo que ha aprendido en lugar de volver a deducirlo en cada sesión.
- Tang, Rashtchian, Ferng, Tomkins, Juan y Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). La propia experiencia de un agente, convertida en conocimiento que reescribe sus habilidades.
- Zhang, Hu, Upasani y colaboradores, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). Estudiamos su manera de curar lo que un agente conserva al diseñar Autoaprendizaje.
- Uddin, Shubham, Blanco, Baral y Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). El primer benchmark que también comprueba lo que una memoria ya no debería decir.
