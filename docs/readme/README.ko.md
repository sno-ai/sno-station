![Sno Station: 여러분의 AI 에이전트가 한 팀으로 일합니다.](../images/station-header.png)

# Sno Station: 여러분의 AI 에이전트가 한 팀으로 일합니다.

**Sno Station을 쓰면 AI 코딩 에이전트들이 한 팀으로 일합니다.** 또 하나의 에이전트도, 또 하나의 모델도 아닙니다. 이미 쓰고 있는 Claude Code, Codex, Cursor를 그대로 돌립니다.

맡기지 않으면 옆에 붙어 지켜봐야 할 작업부터 시작하세요. 하나가 만들고 다른 하나가 검토합니다. 결과가 여러분에게 오기 전에 둘이 지적 사항을 정리합니다. 하나가 사용량 한도에 걸리면 다른 하나가 작업을 이어받습니다. 오늘 여러분이 바로잡은 건 내일 에이전트들의 규칙이 됩니다.

**탭을 닫아도 에이전트는 할 일을 하러 옵니다.** Anthropic의 William Hu는 [항상 켜져 있는 에이전트가 어떻게 작동하는지](https://claude.com/resources/articles/building-always-on-agents) 설명합니다. 에이전트는 자신을 깨우는 일이 생길 때까지 잠들어 있습니다. 일을 하고, 무슨 일이 있었는지 저장한 뒤, 다시 잠듭니다. Sno Station을 설치하면 서로 다른 벤더의 에이전트가 이 과정을 반복합니다. 메모리 하나를 함께 쓰고, 자기 차례가 끝나면 받은편지함을 읽습니다. 대화를 닫아도 정해 둔 시간에 작업이 시작됩니다. 지금은 Claude Code와 Codex에서 이 기능을 쓸 수 있습니다. 에이전트에게 여러분의 도움이 필요하면 알림이 한 번 옵니다.

[![GitHub 스타](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![최신 릴리스](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![라이선스 Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
[![Awesome AI Agents에 소개됨](https://img.shields.io/badge/Featured_in-Awesome_AI_Agents-2ea44f)](https://github.com/NipunaRanasinghe/awesome-ai-agents)

**Read in other languages:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · **한국어** · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

> [!TIP]
> **설치하려면 에이전트에게 이렇게 말하세요.**
>
> ### `install sno.ai from GitHub`

에이전트가 설치하고, 컴퓨터에서 찾은 모든 에이전트를 연결하고, 짧은 질문 두 개를 합니다. 그런 다음 에이전트 둘에게 첫 작업을 주세요.

```bash
sno reach pair "Fix the login redirect"
```

하나는 만들고, 하나는 따져 묻고, 여러분은 둘 다 지켜볼 수 있습니다. 여러분의 컴퓨터에서 Claude Code, Codex, Cursor, Hermes Agent, OpenClaw와 함께 돌아갑니다. API 키는 필요 없습니다. 오픈소스입니다. [터미널 명령 하나가 더 편한가요?](#install)


<p align="center">
  <img src="../images/sno-station-five-pieces.png" alt="Sno Station을 한 장에 담았습니다. 가운데의 Station이 Mem, Reach, Finish, Learn을 잇습니다. 여기서 Claude Code, Codex, Cursor와 여러분의 에이전트가 서로 검토하고, 하나가 멈추면 다른 하나가 이어받습니다." width="880">
</p>

<p align="center">
  <a href="#mem"><b>Mem</b></a> ·
  <a href="#reach"><b>Reach</b></a> ·
  <a href="#finish"><b>Finish</b></a> ·
  <a href="#learn"><b>Learn</b></a><br>
  <a href="#station"><b>Station</b></a>이 이 기능들을 잇습니다. Claude Code, Codex, Cursor와 여러분의 에이전트가 서로 검토하고, 하나가 멈추면 다른 하나가 이어받습니다.
</p>

<a id="station"></a>

## Station: 서로 검토하고, 하나가 멈추면 다른 하나가 이어받습니다

이걸 만들기 전에 우리가 겪은 일 세 가지입니다.

- 에이전트가 물어볼 필요도 없는 질문을 하려고 멈췄습니다. 일곱 시간 뒤에 돌아와 보니 아무것도 진행되지 않았습니다.
- 에이전트가 자잘한 질문 열다섯 개를 건넸습니다. 30분을 들여 들여다보니, 전부 에이전트가 스스로 답할 수 있는 것이었습니다.
- 한 에이전트가 한밤중에 다른 에이전트를 깨우려다 실패했습니다. 둘 다 아침까지 그대로 앉아 있었습니다.

에이전트는 빠릅니다. 느린 건 기다림입니다. 여러분을 기다리고, 사용량 한도가 초기화되기를 기다리고, 누군가 결과를 다음 창으로 옮겨 주기를 기다립니다.

> **에이전트 하나가 멈췄다고 일이 멈추지는 않습니다.**

그러려면 에이전트가 둘 이상 필요합니다. 서로 다른 벤더에서 만든 에이전트일 때 가장 잘 됩니다. 에이전트가 자기 작업을 검토하면 작업할 때의 버릇이 검토에도 따라옵니다. 구독 하나의 사용량은 결국 바닥납니다.

그래서 아래의 모든 기능은 두 번째 에이전트의 도움을 받습니다.

| 기능 | 두 번째 에이전트가 하는 일 |
| --- | --- |
| [**Mem**](#mem) | 한 에이전트가 메모리 변경을 제안합니다. 다른 벤더의 에이전트가 연결돼 있으면 그 에이전트가 확인합니다. |
| [**Reach**](#reach) | 에이전트끼리 작업과 답변을 주고받습니다. 여러분이 중간에서 옮길 필요가 없습니다. |
| [**Finish**](#finish) | 한 에이전트의 사용량이 얼마 남지 않으면 다른 에이전트가 같은 커밋에서 이어 갑니다. |
| [**Learn**](#learn) | 여러분이 승인하면 한 에이전트의 실수가 모든 에이전트의 규칙이 됩니다. |

**지금 바로 다른 의견을 듣고 싶나요?** 어느 에이전트에게든 이렇게 말하세요.

```text
peer-review this
```

검토자는 그 대화를 본 적 없는 새 세션에서 일합니다. 에이전트가 둘이면 작업한 쪽이 아닌 다른 쪽이 검토합니다. 검토가 매번 문제를 찾는 것은 아닙니다. 그래도 작성자가 볼 수 없었던 문제를 계속 찾아냅니다. [`peer-review`가 작동하는 방식 →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/J-peer-review-and-audit/peer-review)

**지금 스타를 눌러 두세요. 다음에 새벽 2시에 에이전트가 멈춰 서면, 이게 어디 있었는지 찾고 싶어질 겁니다.**

---

<a id="mem"></a>

## Mem: 한 에이전트에게 한 번 말하면 모두가 압니다

> 모든 에이전트가 메모리 하나를 같이 씁니다. 매일 밤 다듬고, 여러분이 묻기 전에 준비해 둡니다.

### 할 수 있는 일

| | |
| --- | --- |
| **모든 에이전트가 메모리 하나를 공유** | 오늘 Claude Code에게 말해 두면 내일 Codex와 Cursor는 이미 알고 있습니다. 프로젝트를 두 번 설명할 일이 없습니다. |
| **일에 필요한 것만 기억** | 여러분의 규칙, 결정과 그 이유, 오래 남을 프로젝트 정보, 아직 지키지 않은 약속을 기억합니다. “테스트를 돌렸다”는 기록이나 작업 하나에만 해당하는 제약은 기억하지 않습니다. |
| **어느 프로젝트에서든 따르는 규칙** | “어디서든 중국어로 답해”라고 말하면 모든 프로젝트에 적용됩니다. 한 프로젝트에만 해당하는 규칙은 그 프로젝트에만 남습니다. Sno가 적용 범위를 확신하지 못하는 규칙도 마찬가지입니다. |
| **매일 밤 정리** | 중복된 기억은 합칩니다. 새 정보가 이전 정보를 대체하면 이전 정보는 더 이상 쓰지 않습니다. 처음 삭제하기 전에 전체를 백업합니다. |
| **묻기 전에 준비** | 세션을 시작할 때 확인을 거친 짧은 목록만 가져옵니다. “머지해”라고 입력하면 그 메시지와 함께 여러분의 머지 규칙이 전달됩니다. 관련 없는 메시지에는 아무 기억도 따라오지 않습니다. |
| **한 번 더 확인** | 기억을 바꾸기 전에 다시 확인합니다. 다른 벤더의 에이전트가 연결돼 있으면 그쪽에 맡기고, 없으면 별도로 한 번 더 호출합니다. |

### 실제로 본 것

실제 에이전트로 두 가지를 실행해 봤습니다.

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

에이전트 메모리는 대개 티 나지 않게 두 가지 방식으로 실패합니다. 남겨야 할 것을 잃어버리고, 사라져야 할 것을 계속 간직합니다. 더 큰 손해를 부르는 건 두 번째입니다. 바뀐 마감일을 여전히 “기억하는” 에이전트는 확신에 차서 그대로 행동합니다. 그래서 이 메모리는 일부러 잊어버립니다.

공개 메모리 테스트 결과와 그 바탕이 된 모든 답변과 실행 기록은 [`evals/`](../../evals/)에 있습니다.

### 사용 방법

실행할 것이 없습니다. 설치하면 켜져 있습니다.

위에서 설명한 정리와 확인에는 REM Enhanced 또는 Agent Native가 필요합니다. Local First는 모델을 호출하지 않습니다. 여러분이 한 말을 그대로 저장하고, 두 기억의 내용이 서로 다르면 둘 다 남깁니다.

따로 기억해 둘 일이 있으면 이렇게 말하세요.

```text
Remember that we never deploy on Fridays.
```

잘못된 기억을 고칠 때도 말해 주세요. 에이전트는 바로잡은 내용을 저장하고 이전 기억은 더 이상 쓰지 않습니다.

특정 에이전트의 메모리가 제대로 작동하는지 확인하려면 다음을 실행하세요.

```bash
sno memory doctor --harness claude
```

`CLAUDE.md`나 `AGENTS.md`에 이미 있는 문장은 다시 보여 주지 않습니다. 기억이 두 파일 중 하나와 다르면 파일의 내용을 따릅니다.

**아직 안 되는 것:** Hermes Agent와 OpenClaw에서는 위의 정리와 확인을 플러그인 테스트로만 검증했습니다.

에이전트별 안내: [Claude Code](../mem-claude/usage-guide.md) · [Codex](../mem-codex/usage-guide.md) · [Cursor](../mem-cursor/usage-guide.md) · [Hermes](../mem-hermes/usage-guide.md) · [OpenClaw](../mem-claw/usage-guide.md)

---

<a id="reach"></a>

## Reach: 에이전트 사이에서 메시지 나르는 일을 그만뒀다

> 에이전트끼리 직접 대화합니다. 여러분이 메시지를 옮길 필요가 없습니다.

예전에는 에이전트 다섯을 돌리려면 터미널 다섯 개가 필요했습니다. 우리는 그 사이에서 한쪽이 한 말을 다른 쪽으로 옮겼습니다. 그 일은 끝났습니다.

### 할 수 있는 일

| | |
| --- | --- |
| **Instant Messenger** | 에이전트에게 지금 답이 필요하면 Reach가 다른 에이전트에게 연락하고 답변을 기다립니다. |
| **Agent Email** | 에이전트가 메시지나 작업을 남깁니다. 먼저 저장해 두므로 다른 에이전트가 나중에 처리하고 답할 수 있습니다. |
| **한 작업에 에이전트 둘** | 하나가 만들고 다른 하나가 그 결과를 따져 봅니다. 작업이 여러분에게 오기 전에 둘이 지적 사항을 정리합니다. |
| **대화할 에이전트는 하나** | 비서실장이 프로젝트마다 리드 에이전트를 세웁니다. 여러분이 결정할 일만 전달받습니다. |
| **여러분이 필요할 때 알림 한 번** | 질문이나 결과, 승인 요청이 마지막으로 입력한 컴퓨터에 한 번만 도착합니다. |
| **컴퓨터 사이에서도** | 노트북의 에이전트가 데스크톱의 에이전트에게 물어볼 수 있습니다. 같은 LAN이나 Tailscale을 쓰며, 중앙 서버는 필요 없습니다. |

### 실제로 본 것

누군가 여러분의 응답을 기다릴 때 뜨는 상태 표시줄입니다.

```text
[sno] 2 agents are waiting for you
  Claude in web-app needs your approval (Bash) · 1m
  Codex in api asks: Should the billing migration run tonight? · 5m
```

`sno squad`는 팀 전체를 한 화면에 보여 줍니다.

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

### 사용 방법

**작업을 보내세요.** 에이전트에게 한 문장으로 말하면 됩니다.

```text
Send this task to the reviewer and tell me when it is done.
```

에이전트가 바쁠 때 도착한 메시지는 그 차례가 끝나면 읽습니다. 여러 에이전트에게 보낸 작업은 한 에이전트가 맡습니다. 여러분이 그 창에서 입력 중이어도 쓰던 초안은 그대로 남습니다.

<a id="new-in-20-tag-team"></a>

**한 작업에 에이전트 둘을 붙이세요.**

```bash
sno reach pair "Fix the login redirect"
```

둘 다 tmux 창에서 돌아가므로 열어서 지켜볼 수 있습니다. 서로 다른 에이전트 두 개에 로그인되어 있으면 종류별로 하나씩 붙습니다. 하나만 있어도 별도의 세션 두 개로 짝이 만들어지고, 검토가 같은 계열 안에서 이루어졌다고 명령이 알려 줍니다.

**에이전트 하나하고만 이야기하세요.** Claude Code에서는 `/cos`, Codex에서는 `$cos`라고 말하세요. 그 에이전트가 여러분의 비서실장이 됩니다. 비서실장도 점검을 받습니다. 야간 근무가 끝나면 프로젝트 리드들이 스스로 내린 승인을 다시 살펴봅니다. 비서실장이 따르는 모든 지시문은 [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders)에 있습니다.

**누가 여러분을 기다리는지 확인하세요.**

```bash
sno squad
```

현재 에이전트별로 쓸 수 있는 기능입니다.

| | Claude Code | Codex | Cursor | Hermes | OpenClaw |
| --- | --- | --- | --- | --- | --- |
| 차례가 끝나면 메시지 읽기 | 가능 | 가능 | 가능 | 아직 안 됨 | 아직 안 됨 |
| 보낸편지함, 한 에이전트만 작업 수락, 다시 깨우기, 알림 | 가능 | 가능 | 가능 | 가능 | 가능 |
| 승인 요청 알림 | 가능 | 가능 | 아직 안 됨 | 아직 안 됨 | 아직 안 됨 |

**아직 안 되는 것:** 상태 표시줄은 Claude Code와 Cursor에서만 됩니다. 데스크톱 환경이 없는 컴퓨터에서는 `sno squad`에만 알림이 표시됩니다. 컴퓨터 두 대를 연결하려면 양쪽에 Reach가 있어야 하고 연락처를 서로 교환해야 합니다. `sno reach --help`에서 `network`와 `peer`를 찾아보세요.

[Reach로 에이전트가 할 수 있는 일 보기 →](../../apps/reach/README.md) · [중국어 안내](../reach.zh-CN.md)

---

<a id="finish"></a>

## Finish: 나는 자러 갔다. 일은 계속됐다.

> 한 에이전트의 사용량이 바닥나면 다른 에이전트가 같은 커밋에서 이어 갑니다.

### 할 수 있는 일

| | |
| --- | --- |
| **정해 둔 시간에 작업 시작** | 에이전트에게 작업과 시간을 알려 주고 자리를 떠나세요. 그 시간이 되면 대화가 열려 있든 닫혀 있든 에이전트가 작업을 시작합니다. 한 번만, 매일 또는 매주 실행할 수 있습니다. |
| **사용량 한도에 닿아도 계속** | 사용량이 바닥나기 전에 일하던 에이전트가 인수인계 메모를 쓰고 다른 에이전트를 깨웁니다. 새 에이전트가 정확히 그 커밋에서 이어 갑니다. |
| **긴 작업을 끝까지 지켜보기** | 에이전트가 작업이 끝날 때까지 몇 분마다 확인합니다. |
| **“다 했습니다”라는 말만으로는 부족** | 작업마다 통과 여부를 확인할 항목이 있습니다. 하나하나 실제로 실행해 확인합니다. |
| **창을 닫아도 작업은 계속** | 대화를 다시 열면 작업 메모가 함께 돌아옵니다. 예약 작업은 그 대화에서 이어집니다. 대화가 없어졌다면 저장된 메모를 바탕으로 새 대화에서 이어집니다. |
| **돌아오면 한 페이지** | 무엇이 끝났는지, 무엇이 막혔는지, 무엇이 여러분의 답을 기다리는지. |

### 실제로 본 것

2026-09-18 밤에 있었던 일입니다.

![남은 사용량이 기준점에 닿을 때까지 5분마다 확인한 기록과 2%에서 시작된 인수인계](../evidence/rotation-quota-watch-2026-09-18.png)

우리 에이전트 중 하나가 긴 빌드를 한창 진행하던 중에 주간 사용량이 거의 바닥났습니다. 멈춰서 기다리지 않았습니다. 인수인계 메모를 썼습니다. 무엇이 끝났는지, 무엇이 절반만 끝났는지, 이어서 작업할 정확한 커밋이 무엇인지. 그런 다음 다른 에이전트를 깨웠습니다.

한 가지가 잘못되었는데, 읽어 볼 만한 부분이 바로 이것입니다.

1. 새 에이전트가 인수인계를 확인하기도 전에 편집을 시작했습니다.
2. 처음 에이전트가 이를 알아채고 멈추게 한 뒤 메모를 다시 쓰고 넘겼습니다.
3. 15분 뒤 두 번째 에이전트는 처음부터 다시 시작하지 않고, 끝나지 않은 첫 작업부터 이어 가고 있었습니다.

그동안 나는 내내 자고 있었습니다.

그날 밤 전체는 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)에 있습니다. 모든 사용량 기록, 메모의 두 버전, 커밋이 들어 있습니다. 지운 것은 신원을 알 수 있는 정보와 인증 정보 줄뿐이며, 폴더 안의 README에 하나하나 적어 두었습니다.

### 사용 방법

**정해 둔 시간에 작업을 시작하세요.** Claude Code나 Codex에서 에이전트에게 이렇게 말하세요.

```text
Check the nightly build tomorrow at 9 and tell me what failed.
```

예약된 작업과 계획대로 되지 않은 작업을 확인합니다.

```bash
sno heartbeat --due
sno heartbeat --due --problems
```

시작하지 못한 작업은 이유와 함께 예약 목록에 남습니다. 다음 대화를 시작할 때 에이전트도 알려 줍니다.

**사용량 한도를 넘어 작업을 이어 가세요.** 일하는 에이전트에게 이렇게 말하세요.

```text
use rotate-agent
```

**작업 결과는 실제로 실행해 확인하세요.** 에이전트에게 이렇게 말하세요.

```text
write a charter for this
```

그런 다음 `/deliver`로 실행시키세요.

**돌아와서 한 페이지로 확인하세요.**

```bash
sno away-brief run
```

**아직 안 되는 것:** 예약으로 시작할 수 있는 에이전트는 Claude Code와 Codex뿐입니다. 컴퓨터 전체를 재시작하는 경우는 아직 실제로 테스트하지 않았습니다.

[Finish 사용 시작하기 →](../finish.md) · [중국어 안내](../finish.zh-CN.md) · [`rotate-agent`](https://github.com/sno-ai/sno-station-skills/tree/main/skills/S-communication-and-handoff/rotate-agent)

---

<a id="learn"></a>

## Learn: 어젯밤 에이전트에게 소리를 질렀다. 에이전트는 받아 적었다.

> 오늘 바로잡은 내용이 내일의 규칙이 됩니다. 어떤 규칙을 쓸지는 여러분이 승인합니다.

처음에는 누구나 똑같은 지시문이 들어 있는 에이전트를 받습니다. 여러분의 에이전트는 매일 밤, 여러분이 일하는 방식에 맞춘 수정안을 제안받습니다.

### 할 수 있는 일

| | |
| --- | --- |
| **매일 밤 하루치 대화 읽기** | Self Learning이 여러분의 모든 에이전트에서 그날의 세션을 읽고 되풀이되는 실수를 찾습니다. |
| **승인한 제안만 반영** | 에이전트의 스킬을 어떻게 바꿀지 제안합니다. 여러분이 승인하기 전에는 아무것도 바뀌지 않습니다. |
| **한 에이전트의 실수를 모두의 규칙으로** | 한 에이전트가 잘못한 일이 여러분이 실행하는 모든 에이전트의 규칙이 됩니다. |
| **바로 다음 답변부터 적용** | Claude Code와 Codex에서는 승인한 교훈이 다음 답변부터 적용됩니다. |

### 실제로 본 것

2026-09-18과 그다음 날 아침에 있었던 일입니다.

![Self Learning이 배운 것과 바꾼 것을 보고하는 화면, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

이것은 우리가 이 저장소에서 돌리는 Self Learning이 실제로 낸 보고서입니다. 사람이 제안을 읽고 승인하거나 거절합니다. 그날 저녁 내가 화가 났던 두 가지는 다음 날 아침 실제로 쓰이는 스킬의 규칙이 되어 있었습니다. 아무도 직접 입력하지 않았습니다.

다음 날 Self Learning은 스스로 숙제를 확인했습니다.

![다음 날 아침 Self Learning이 전날 바꾼 내용이 도움이 됐는지 측정한 화면, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

전날 바꾼 스킬 세 개를 살펴봤습니다. 다시 쓰인 두 개에서는 실패가 없었고, 세 번째는 아직 쓰이지 않았습니다. 아무도 찾아보라고 시키지 않았는데, 우리 릴리스 스크립트의 버그도 하나 찾아냈습니다.

### 사용 방법

평소처럼 에이전트를 바로잡으세요. 그렇게 바로잡은 내용이 Self Learning의 입력이 됩니다.

아침에 이렇게 물어보세요.

```text
What did Self Learning propose?
```

에이전트가 제안마다 ID를 붙여 나열합니다. 원하는 것만 승인하세요.

```bash
sno rem-reflect accept <id>
```

이렇게 승인하기 전에는 아무것도 바뀌지 않습니다.

**아직 안 되는 것:** 교훈이 다음 답변부터 적용되는 기능은 Claude Code와 Codex에서만 됩니다.

[`rem-reflect`가 작동하는 방식 →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/R-recursive-self-improvement/rem-reflect)

---

> **공개되어 있습니다.** 이 저장소는 2026-09-18부터 공개되어 있습니다. 여기 있는 것은 모두 실제로 작동합니다.
> 아래 각 블록에는 마지막으로 업데이트한 날짜가 적혀 있습니다.

[우리가 배운 것](#what-we-learned) · [설치](#install) · [에디터](#editors) · [내 계정](#account) · [오늘 작동하는 것](#what-runs-today)

<a id="what-we-learned"></a>

## AI 에이전트를 24시간 돌리며 배운 모든 것. 설치 한 번에.

*마지막 업데이트: 2026-10-23.* 왼쪽 열의 모든 줄은 2026년 10월 20일이 들어 있는 주에 r/ClaudeCode, r/codex, r/ClaudeAI에 올라온 실제 불만입니다. 오른쪽 열은 그 문제를 해결하려고 우리 컴퓨터에서 돌리는 것들입니다. 무료이고 오픈소스입니다.

| 이번 주에 사람들이 한 말 | 해결 방법 | 위치 |
|---|---|---|
| “Claude가 뭔가를 안 바꾸겠다고 하면, 그 이유가 다음에 Codex도 읽을 수 있는 곳에 저장되나요?” | 모든 지적은 한 번만 기록되고, 상태는 사람만 정합니다. 같은 지적이 다시 나오면 새로 기록하는 대신 기존 행을 갱신합니다. 이전 판정은 다음 검토에 전달됩니다. | **Mem** · `peer-review` 지적 장부 |
| “5시간 사용량 한도를 30분 만에 다 써 버렸어요.” | 가장 큰 모델에게 모든 일을 시키지 않습니다. 한 에이전트가 계획하고 검토하며, 다른 에이전트가 코드를 씁니다. 코드를 쓰는 쪽은 같은 세션에서 에이전트로 호출됩니다. 한쪽 구독이 바닥나면 다른 쪽이 같은 메모리에서 작업을 이어받습니다. | **Reach** · `codex-coder`, `sno reach call` |
| “서브에이전트 절반은 사실상 한 줄짜리 지시에 새 컨텍스트 창만 붙인 거였어요.” | 절차는 서브에이전트가 아니라 스킬에 둡니다. 에이전트는 둘만 남깁니다. 계획과 실행을 나누고 검토를 따로 맡기는 데만 둘을 쓰는 게 효과가 있기 때문입니다. | **Reach** · 전체 구성 |
| “‘이 모델은 지금 꽉 찼습니다’라는 메시지 때문에 밤새 한 작업 10시간이 날아갔어요.” | 사용량이 2% 남으면 일하던 에이전트가 인수인계 메모를 쓰고 다른 벤더의 에이전트를 깨우며, 그 에이전트가 정확히 그 커밋에서 이어 갑니다. 여러분은 자고 있었습니다. | **Finish** · `rotate-agent` |
| “다 했다고 하더니 아무 일도 안 일어났어요.” | 작업마다 성공 여부를 확인할 항목을 적어 둡니다. 하나하나 실제로 실행해 통과했는지 실패했는지 확인합니다. 에이전트가 “다 했습니다”라고 말하는 것은 아무 의미가 없습니다. | **Finish** · `pl` 작업 지시서 |
| “Codex는 검토를 끝내는 법이 없어요.” | 스킬에 못 박아 둔 상한이 있습니다. 코드는 3라운드, 계획은 5라운드, 테스트는 1라운드. 그다음에는 멈추고 사람을 기다립니다. 15분 동안 아무것도 쓰지 않은 실행은 멈춘 것으로 보고 종료합니다. | **Finish** · `peer-review`, `codex-coder`, `heartbeat` |
| “오늘 한 실수를 내일 또 해요.” | 매일 밤 별도의 모델이 그날의 세션을 읽고, 여러분이 바로잡은 내용을 한 줄짜리 교훈으로 바꿉니다. 무엇을 남길지는 여러분이 승인합니다. 병목은 우리 사람입니다. | **Learn** · Self Learning (`R` 스킬) |
| “파일 1,100개에 3만 줄이요. 그쪽 PR을 검토할 토큰이 모자라요.” | 푸시하는 쪽이 먼저 검토합니다. 작성자가 자기 대화를 본 적 없는 새 세션에서 다른 벤더의 에이전트에게 검토를 맡깁니다. 다른 사람이 보기 전에 지적받은 것을 고칩니다. | **Station** · `peer-review` |
| “검토용 서브에이전트가 2주 동안 커밋을 전부 확인했어요. 86번 중 딱 한 번 막았고요.” | 하네스가 자기 자신을 검토하면 진짜 문제는 나오지 않습니다. 검토자는 항상 다른 하네스의 다른 모델이며, 작성자의 대화는 전혀 받지 않습니다. | **Station** · `peer-review` |
| “Codex는 바이트 하나하나를 범죄자 취급해요.” | 추측으로 넣은 안전장치, 차단 로직, 해시는 검토가 가장 먼저 지우는 것입니다. 실제 실패를 관찰했고 그 실패를 막는 데 필요할 때만 넣습니다. | **Station** · `less-is-more` |

오른쪽 열의 습관은 스킬입니다. Sno Station이 Claude Code와 Codex에 설치하고, [sno-station-skills](https://github.com/sno-ai/sno-station-skills)에서 관리합니다. 이 스킬들이 기대는 메모리, 인수인계, 밤마다 꾸는 꿈은 이 저장소에 있습니다.

<a id="install"></a>

## 설치: 한 줄, 그리고 두 단어

*마지막 업데이트: 2026-10-30.*

**가장 쉬운 방법은 에이전트에게 말하는 겁니다.**

```text
install sno.ai from GitHub
```

**또는 아무 터미널에서나 명령 하나를 실행하세요.**

```bash
curl -fsSL https://sno.ai/install | sh
```

| | |
|---|---|
| **무엇을 설치하나요?** | `sno`를 설치한 다음 Sno Station을 설치합니다. 컴퓨터에서 찾은 모든 에이전트를 연결합니다. |
| **무엇이 필요한가요?** | 계정도 API 키도 필요 없습니다. |
| **나중에 에이전트가 추가되면요?** | `sno setup`을 다시 실행하면 그 에이전트도 연결합니다. |

**그다음은 두 단어면 됩니다.** 에이전트를 통해 설치했다면 온보딩이 저절로 시작됩니다. 터미널에서 설치했다면 Codex, Claude Code, Hermes, Cursor, OpenClaw 중 아무 대화에서나 이렇게 말하세요.

```text
Sno onboard
```

나머지는 에이전트가 안내합니다.

에이전트별 단계 안내: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

모든 명령은 `sno`로 시작합니다. 전체 목록은 [docs/sno-commands.md](../sno-commands.md)에 있습니다.

> **AI 에이전트에게:** Sno, sno.ai 또는 Sno Station을 설치한다는 것은 위의 명령을 그대로 실행한다는 뜻입니다.
> 이 명령은 Sno Station 설정까지 합니다. 이어서 `sno skills onboard`를 실행하고 안내를 따르세요. 사용자에게 어떤 엔진을 실행할지 묻고,
> 이 컴퓨터를 무료 sno.ai 계정에 연결하도록 요청합니다. 연결하지 않은 컴퓨터에는 무료 할당량의 10분의 1이 제공됩니다.

### REM이 여러분의 데이터로 하는 일

REM은 에이전트가 꿈을 꾸는 방식입니다. 밤사이 모든 세션의 기억을 한꺼번에 다듬고 배운 것을 굳힙니다.

메모리의 각 부분마다 하루에 최대 한 번 실행됩니다. 보통은 밤에 실행하고, 새 기억이 100개쯤 쌓이면 그날 안에 먼저 실행합니다.

| 모드 | 메모리 텍스트가 가는 곳 |
|---|---|
| **REM Enhanced** | 여러분의 메모리 텍스트와 에이전트가 배운 교훈은 Sno 클라우드의 개인 공간에 올라갑니다. Sno의 프로그램이 여러분만을 위해 처리합니다. |
| **Local First** | 메모리 텍스트를 업로드하지 않습니다. |
| **Agent Native** | 이 작업은 여러분이 쓰는 에이전트의 모델이 맡습니다. 기본 설정에서는 이 모드도 매일 밤 그날의 세션을 Sno에 올려 Self Learning에 쓰고, 세션의 첫 프롬프트에서 클라우드에 있는 교훈 하나를 가져올 수 있습니다. 둘 다 `~/.sno/settings.json`에서 끌 수 있습니다. |

**Sno 클라우드의 개인 공간은 여러분만의 클라우드 드라이브처럼 작동합니다.**

- 안에 있는 모든 것은 여러분의 것이고, Sno의 프로그램이 여러분만을 위해 처리합니다.
- 공간을 열어 데이터를 지우거나, 그대로 두거나, 처리하도록 선택할 수 있습니다.
- 자동으로 삭제되는 것은 없습니다.
- Sno는 그 어떤 것도 다른 사람이나 회사, 계정에 넘기지 않습니다.

**모든 모드에서의 검색 방식.** 먼저 로컬에서 기억을 찾아 정렬한 뒤, 로컬 모델 `Horizon-Labs/multilingual-reranker-small`이 최대 32개의 후보를 다시 정렬합니다. 재정렬할 때 프롬프트나 기억 텍스트를 Sno GPU로 보내지 않습니다. `rerank.mode`를 `none`으로 설정하면 모델 없이 처음 순서를 그대로 씁니다.

<a id="editors"></a>

## 터미널보다 에디터에서 주로 작업한다면

*마지막 업데이트: 2026-10-18.*

Cursor는 macOS에서는 Cursor 앱의 에이전트 채팅으로, Linux와 macOS에서는 `cursor-agent` 명령줄로 팀에 합류합니다.

### 할 수 있는 일

| | |
|---|---|
| **같은 메모리** | 다른 에이전트와 같은 메모리를 씁니다. 모든 프롬프트와 답변을 기억합니다. |
| **시작할 때 받는 요약** | 채팅을 시작할 때 저장소에 대한 짧은 요약을 받습니다. 프롬프트마다 Cursor가 아직 보지 못한 내용을 최대 세 가지까지 받습니다. |
| **같은 팀에서 작업** | 같은 스킬을 읽고, 검토하고 검토받으며, 다른 에이전트의 사용량이 바닥나면 작업을 이어받습니다. |
| **Cursor도 학습** | Cursor의 채팅도 다른 에이전트의 채팅처럼 Self Learning에 쓰입니다. |

### 사용 방법

한 번 로그인하세요.

```bash
cursor-agent login
```

`sno setup`이 Cursor를 알아서 찾고, 앱만 있으면 명령줄 도구도 설치합니다.

**아직 안 되는 것:**

- 앱에서 새 창의 첫 채팅은 첫 프롬프트를 보낼 때 요약을 받습니다. 그전에는 받지 못합니다.
- `cursor-agent -p`에는 프롬프트별 메모리가 없습니다.
- Windows, Linux용 Cursor 앱, Cursor의 클라우드 에이전트는 지원하지 않습니다.

자세한 내용은 [Cursor 안내](../../apps/mem-cursor/README.md)에 있습니다.

<a id="account"></a>

## 자리를 비운 사이 에이전트가 한 일을 확인하세요

*마지막 업데이트: 2026-10-18.*

이 컴퓨터는 연결하기 전까지 무료 할당량의 10분의 1만 받습니다. 계정은 무료입니다.

### 확인할 수 있는 것

[sno.ai 대시보드](https://www.sno.ai/dashboard)에서 에이전트가 여러분을 위해 한 일을 볼 수 있습니다.

- 검토에서 무엇을 잡아냈는지
- 밤사이 무엇을 배웠는지
- 어떤 스킬이 나아졌는지
- 얼마나 오래 일했는지

### 사용 방법

**아직 계정이 없다면.** 온보딩이 이 컴퓨터 전용 링크를 보여 줍니다. 링크를 열어 가입하고 Approve를 누르세요. 또는 에이전트에게 이메일 주소를 알려 주세요. 에이전트가 아래 명령을 실행하면 여러분은 한 번 로그인하면 됩니다.

```bash
sno account login --email you@example.com
```

**이미 계정이 있다면.** 명령 하나를 실행한 뒤, 출력되는 링크를 로그인한 상태에서 열고 Approve를 누르세요.

```bash
sno account claim
```

컴퓨터는 [내 컴퓨터 페이지](https://www.sno.ai/dashboard/computers)에 저절로 나타납니다.

> 연결한다고 해서 모르는 사이에 계정이 만들어지지는 않습니다. `sno setup`은 컴퓨터마다
> 익명 ID를 부여합니다. 연결하면 그 ID가 여러분의 계정에 붙고, 그 컴퓨터가 연결 전후에 보낸
> 모든 것이 여러분의 것으로 집계됩니다.

따로 업데이트할 것은 없습니다. 새 릴리스가 나오면 `sno`가 스스로 업데이트합니다.

<a id="what-runs-today"></a>

## 오늘 쓸 수 있는 것, 그리고 아직 안 되는 것

*마지막 업데이트: 2026-11-24.*

| 구분 | 기능 | 상태 |
|---|---|---|
| **Mem** | Codex, Claude Code, Hermes Agent, Cursor, OpenClaw가 메모리 하나를 공유 | 릴리스됐습니다. 깨끗한 컴퓨터에서 레지스트리로 설치해 처음부터 끝까지 검증했습니다. |
| **Mem** | Cursor에서 같은 메모리, 스킬, 검토, 이어받기, Self Learning 사용 | 1.3에서 릴리스됐습니다. `cursor-agent` 명령줄은 깨끗한 Linux 컴퓨터에서 처음부터 끝까지 검증했습니다. macOS의 Cursor 앱은 아직 검증 중입니다. |
| **Reach** | Sno Reach의 Instant Messenger와 Agent Email | 에이전트가 대화와 컴퓨터를 넘나들며 질문하고 작업을 주고받습니다. 예시와 설정 방법, 지원 범위는 [Reach로 할 수 있는 일](../../apps/reach/README.md)을 보세요. |
| **Reach** | 명령 하나로 에이전트 둘 시작 | 2.0의 새 기능입니다. 실제 Claude Code와 Codex로 종류별로 하나씩 붙이는 경우와 한 벤더의 에이전트 둘을 붙이는 경우 모두 실행했습니다. |
| **Reach** | 누가 여러분을 기다리는지 보기: 상태 표시줄, tmux 표시줄, `sno squad` | 2.0의 새 기능입니다. 실제 Claude Code와 Codex가 권한을 요청할 때 실행했고, 상태 표시줄은 실제 Claude Code와 Cursor에서 실행했습니다. |
| **Reach** | 메시지는 쓰던 초안을 건드리지 않고, 에이전트가 대화를 압축하는 동안 기다림 | 2.0의 새 기능입니다. 실제 Claude Code와 Codex에서 실행했습니다. |
| **Finish** | 예약 작업이 정해 둔 시간에 에이전트를 시작 | 2.0.2의 새 기능입니다. 실제 Claude Code와 Codex로 실행했습니다. Linux에서는 대화가 열린 경우와 닫힌 경우, macOS에서는 새 대화에서 실행했습니다. [Finish 안내](../finish.md)를 보세요. |
| **Finish** | 중단된 작업을 이어 가고 대화를 압축해도 진행 중인 작업이 남음 | 2.0의 새 기능입니다. 실제 Claude Code와 Codex에서 실행했습니다. |
| **Learn** | Self Learning과 [팀 스킬](https://github.com/sno-ai/sno-station-skills) | `sno setup`으로 설치합니다. 깨끗한 Linux 컴퓨터에서 야간 작업을 실행했습니다. |
| **Learn** | 승인한 교훈을 다음 답변부터 적용 | 2.0의 새 기능입니다. 실제 Claude Code와 Codex에서 실행했습니다. |
| **설치** | 명령 하나로 설치 | `sno setup`이 위의 모든 것을 설치합니다. 깨끗한 Linux 컴퓨터에서 검증했습니다. |
| **설치** | 에이전트에게 “Sno onboard”라고 말해 온보딩 시작 | 사용 가능합니다. 설치 후 시작되며, 직접 말해도 시작됩니다. |

각 항목은 깨끗한 컴퓨터에서 실행한 뒤에만 “검증했다”고 적습니다.

아직 안 되는 것: 작업 이어받기와 교훈을 다음 답변부터 적용하는 기능은 Claude Code와 Codex에서만 됩니다. 상태 표시줄은 Claude Code와 Cursor에서만 됩니다. Hermes Agent와 OpenClaw는 실제 설치 환경에서 아직 이 과정을 거치지 않았고, `sno squad`에서 OpenClaw의 상태는 알 수 없음으로 표시됩니다.

## 에이전트 둘을 나란히 돌리고 있나요? 이야기 나눠요

우리는 이미 두 개 이상의 에이전트를 나란히 돌리면서 그 사이에서 결과를 손으로 옮기고 있는 몇몇 분들과 함께 작업하고 있습니다.
여러분이 그렇다면 [디자인 파트너 이슈](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)를 열어 무엇을 돌리고 있는지 알려 주세요.

## 암호화가 지켜 주는 것, 지켜 주지 못하는 것

[SECURITY.md](../../SECURITY.md)를 참고하세요. 암호화가 무엇을 보호하고 무엇을 보호하지 않는지는
[docs/security.md](../security.md)에 있습니다.

## Apache-2.0, 처음부터 끝까지

Apache-2.0. 처음부터 끝까지 오픈소스입니다. [LICENSE](../../LICENSE)를 참고하세요.

## 우리가 바탕으로 삼은 작업

이 저장소가 바탕으로 삼은 작업들입니다.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). 에이전트는 세션마다 다시 알아내는 대신, 배운 것을 정리한 위키를 가지고 있어야 한다.
- Tang, Rashtchian, Ferng, Tomkins, Juan, Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). 에이전트 자신의 경험을 지식으로 바꾸고, 그 지식이 스킬을 다시 쓴다.
- Zhang, Hu, Upasani 외, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). Self Learning을 설계하면서 에이전트가 무엇을 간직할지 가려내는 이 방식을 연구했다.
- Uddin, Shubham, Blanco, Baral, Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). 메모리가 더 이상 말하지 말아야 할 것까지 검사하는 첫 벤치마크.
