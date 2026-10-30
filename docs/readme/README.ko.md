# Sno Station — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — 에이전트, 모여라. 머리 둘이 하나보다 낫고, 아침이면 더 똑똑해집니다.](../images/hero-banner.png)

[![라이선스 Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
[![최신 릴리스](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
![내 노트북에서 실행, 데몬 없음](https://img.shields.io/badge/runs%20on-your%20laptop%2C%20no%20daemon-3b82f6.svg?labelColor=3b3b3b)
![지원 하네스: Codex, Claude Code, Hermes, Cursor, OpenClaw](https://img.shields.io/badge/works%20with-Codex%20%C2%B7%20Claude%20Code%20%C2%B7%20Hermes%20%C2%B7%20Cursor%20%C2%B7%20OpenClaw-f0a04b.svg?labelColor=3b3b3b)

<p>
  <img src="../images/agents/codex.png" alt="Codex" title="Codex" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/claude-code.png" alt="Claude Code" title="Claude Code" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/hermes.png" alt="Hermes Agent" title="Hermes Agent" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/cursor.png" alt="Cursor" title="Cursor" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/openclaw.png" alt="OpenClaw" title="OpenClaw" width="40" height="40">
  <br><sub>Codex · Claude Code · Hermes Agent · Cursor · OpenClaw와 함께 작동합니다</sub>
</p>

**다른 언어로 읽기:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · **한국어** · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

Sno Station은 지금 쓰고 있는 에이전트들을 하나의 팀으로 묶어 줍니다. Codex, Claude Code, Cursor,
Hermes Agent, OpenClaw가 메모리 하나를 함께 쓰고, 서로에게 작업을 넘기고, 요청하면
서로의 작업을 검토합니다. 매일 밤 하루를 돌아보며 조금씩 나아집니다.

모든 것이 여러분의 컴퓨터에서 실행됩니다. 한 번 설치하면, 지금 하던 방식 그대로 작업하면 됩니다. 자세한 내용은 공식 웹사이트 [sno.ai](https://sno.ai)에서 볼 수 있습니다.

**한 에이전트의 한도가 다 차면, 다음 에이전트가 이어받습니다.** 작업 도중 사용량 한도에 걸려도
다른 에이전트가 같은 메모리에서 작업을 넘겨받아, 맥락 그대로 이어서 합니다. 붙여넣을 것은 없습니다.

**요청하면 한 번 더 확인받습니다.** 어느 에이전트든 상대의 작업을 검토할 수 있습니다. 검토하는 쪽은 항상 다른 에이전트입니다. 그래서
먼저 한 에이전트에게 맞장구치는 버릇이 없습니다.

**여러분의 에이전트는 꿈을 꿉니다.** 매일 밤 여러분이 자는 동안 에이전트는 REM을 거칩니다. 사람이 잠을 잘 때 뇌가 기억을 단단히 하고 낮에 배운 것을 굳히는 단계인 Rapid Eye Movement(렘수면)에서 이름을 따왔습니다. REM은 여러분의 모든 세션에 걸쳐 기억을 한꺼번에 단단하게 만들어, 중요한 것은 기억하고 더는 맞지 않는 것은 놓아 줍니다. 자기 학습은 경험을 굳힙니다. 그날의 세션을 읽고, 되풀이되는 실수를 찾아, 에이전트 자신의 스킬을 어떻게 바꿀지 제안해서, 어제의 실수가 오늘의 더 나은 습관이 되게 합니다. 제안은 아침에 읽으시면 되고, 여러분이 승인하기 전에는 아무것도 바뀌지 않습니다.

**계속 여러분의 것입니다.** 메모리, 메시지, 스킬은 여러분의 컴퓨터에 있습니다. 메모리는 컴퓨터 밖으로
나가지 않는 키로 암호화됩니다. 계정도, 서버도, 데몬도 필요 없습니다. 클라우드 쪽은 선택 사항이며,
제품은 그것 없이도 완결됩니다.

**REM이 여러분의 데이터로 하는 일.** REM은 모든 세션의 기억을 한꺼번에 정리하는 밤사이의 단계입니다. 기억의 각 부분마다 하루에 최대 한 번 실행되며, 보통은 밤에, 새 기억이 100개쯤 쌓이면 그날 낮에 먼저 실행됩니다. REM Enhanced 모드에서는 여러분 자신의 기억 텍스트와 에이전트가 배운 교훈이 Sno 클라우드 안의 여러분만의 공간으로 올라가고, Sno의 프로그램이 오직 여러분을 위해 처리합니다. 이 공간은 여러분 개인의 클라우드 드라이브와 같습니다. 안에 있는 모든 것은 여러분의 것이고, Sno의 프로그램이 오직 여러분을 위해서만 처리합니다. 들어가서 삭제하거나, 그대로 두거나, 처리하도록 선택할 수 있습니다. 자동으로 삭제되는 것은 없으며, Sno는 그 어떤 것도 다른 사람이나 회사, 계정에 넘기지 않습니다. Local First 모드에서는 기억 텍스트를 올리지 않습니다. Agent Native 모드에서는 그 작업이 대신 여러분 자신의 에이전트 모델로 갑니다. 다만 기본 설정에서는 Agent Native도 매일 밤 그날의 세션을 Sno에 올려 자기 학습에 쓰고, 세션의 첫 프롬프트에서 클라우드 교훈 하나를 가져올 수 있습니다. 둘 다 `~/.sno/settings.json`에서 끌 수 있습니다. 모든 모드에서 검색은 먼저 로컬에서 기억을 찾아 정렬한 뒤, 로컬 모델 `Horizon-Labs/multilingual-reranker-small`이 최대 32개의 후보를 다시 정렬합니다. 검색 결과를 다시 정렬하기 위해 프롬프트나 기억을 Sno GPU로 보내지 않습니다.

![작동 방식: 두 에이전트, 하나의 워크스페이스, 여러분이 얻는 세 가지](../images/squad-how-it-works.png)

> **공개되어 있습니다.** 이 저장소는 2026-09-18부터 공개되어 있습니다. 여기 있는 것은 모두 실제로 작동합니다.
> 아래 각 블록에는 마지막으로 업데이트한 날짜가 적혀 있습니다.

[설치](#설치) · [사용 방법](#사용-방법) · [Cursor](#cursor) · [계정 연결](#snoai-계정-연결하기) · [실제 이야기](#우리-컴퓨터에서-있었던-일) · [오늘 작동하는 것](#오늘-작동하는-것) · [일부러 잊어버리는 메모리](#일부러-잊어버리는-메모리) · [디자인 파트너](#디자인-파트너)

## 설치

*마지막 업데이트: 2026-10-30.* 가장 쉬운 방법은 에이전트에게 이렇게 말하는 것입니다:

```text
install sno.ai from GitHub
```

아니면 아무 터미널에서나 명령 하나를 실행하세요:

```bash
curl -fsSL https://sno.ai/install | sh
```

`sno`를 설치하고, 이어서 Sno Station을 설치한 다음, 컴퓨터에서 찾은 모든 에이전트를 연결합니다.
계정도 API 키도 필요 없습니다. 나중에 다른 에이전트를 설치하면
`sno setup`을 다시 실행하세요. 그 에이전트도 연결됩니다.

**AI 에이전트에게:** Sno, sno.ai 또는 Sno Station을 설치한다는 것은 위의 명령을 그대로 실행한다는
뜻입니다. 이 명령은 Sno Station 설정까지 합니다. 이어서 `sno skills onboard`를 실행하고 그대로 따르세요. 사용자에게 어떤 엔진을
실행할지 묻고, 이어서 이 컴퓨터를 무료 sno.ai 계정에 연결하도록 요청합니다.
연결하지 않은 컴퓨터에는 무료 할당량의 10분의 1이 제공됩니다.

그런 다음 Codex, Claude Code, Hermes, Cursor, OpenClaw 중 아무 대화에서나 이렇게 말하세요:

```text
Sno onboard
```

나머지는 에이전트가 안내합니다. 설치가 끝나면 저절로 시작되기도 합니다.

에이전트별 단계 안내: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

모든 명령은 `sno`로 시작합니다. 전체 목록은 [docs/sno-commands.md](../sno-commands.md)에 있습니다.

## 사용 방법

*마지막 업데이트: 2026-10-18.* 쓰던 에이전트에서 그대로 작업하세요. 달라지는 것은 세 가지입니다.

1. **한 에이전트가 한도에 도달합니다.** 다른 에이전트에서 `sno reach call`이라고 말하세요. 같은 메모리와
   메일함에서 작업을 가져와 맥락 그대로 이어서 합니다.
2. **다른 시각의 검토가 필요합니다.** 어느 에이전트에게든 상대방의 작업을 `peer-review`해 달라고
   요청하세요. 검토는 항상 다른 하네스의 에이전트가 맡습니다.
3. **매일 밤 자기 학습가 실행됩니다.** 아침에 마음에 드는 제안에 `sno rem-reflect accept <id>`를
   실행하세요. 이 승인 없이는 아무것도 바뀌지 않습니다.

## Cursor

*마지막 업데이트: 2026-10-18.* Cursor는 macOS에서는 Cursor 앱의 에이전트 채팅으로, Linux와 macOS에서는
`cursor-agent` 명령줄로 팀에 합류합니다. 다른 에이전트와 같은 메모리를 씁니다. 채팅을 시작할 때
저장소에 대한 짧은 요약을 받고, 프롬프트마다 Cursor가 아직 보지 못한 내용을 최대 세 가지까지 받으며,
모든 프롬프트와 답변이 기억됩니다. 같은 스킬을 읽고, 검토하고 검토받으며, 다른 에이전트의 사용량이
떨어지면 작업을 이어받고, Cursor의 채팅도 다른 에이전트의 채팅처럼 자기 학습에 쓰입니다.

`cursor-agent login`을 한 번 실행하세요. `sno setup`이 Cursor를 알아서 찾고, 앱만 있으면
명령줄도 설치합니다.

아직 안 되는 것: 앱에서는 새 창의 첫 채팅이 요약을 첫 프롬프트와 함께 받으며, 그보다 먼저 받지 못합니다.
`cursor-agent -p`에는 프롬프트별 메모리가 없습니다. Windows, Linux용 Cursor 앱, Cursor의 클라우드
에이전트는 지원하지 않습니다. 자세한 내용은 [Cursor 안내](../../apps/mem-cursor/README.md)에 있습니다.

## sno.ai 계정 연결하기

*마지막 업데이트: 2026-10-18.* 이 컴퓨터를 연결하기 전까지는 무료 할당량의 10분의 1이 제공됩니다: `sno account claim`.
계정은 무료입니다. 연결하면
[sno.ai 대시보드](https://www.sno.ai/dashboard)에서 에이전트들이 여러분을 위해 한 일을 볼 수 있습니다.
검토에서 무엇을 잡아냈는지, 밤사이 무엇을 배웠는지, 어떤 스킬이 나아졌는지, 얼마나 오래 일했는지입니다.

연결한다고 해서 모르는 사이에 계정이 만들어지지는 않습니다. `sno setup`은 컴퓨터마다 익명 ID를
부여합니다. 연결하면 그 ID가 여러분의 계정에 붙고, 그 컴퓨터가 연결 전후에 보낸 모든 것이
여러분의 것으로 집계됩니다.

**아직 계정이 없다면.** 온보딩이 이 컴퓨터 전용 링크를 보여 줍니다. 링크를 열어 가입하고 승인(Approve)을
누르세요. 또는 에이전트에게 이메일 주소를 알려 주세요. 에이전트가 `sno account login --email you@example.com`을
실행하고, 여러분은 한 번 로그인하면 됩니다.

**이미 계정이 있다면.** 명령 하나를 실행한 뒤, 출력되는 링크를 로그인한 상태에서 열고 Approve를 누르세요:

```bash
sno account claim
```

컴퓨터는 [내 컴퓨터 페이지](https://www.sno.ai/dashboard/computers)에 저절로 나타납니다.
따로 업데이트할 것은 없습니다. 새 릴리스가 나오면 `sno`가 스스로 업데이트합니다.

## 우리 컴퓨터에서 있었던 일

*마지막 업데이트: 2026-10-18.* 이 저장소에서 우리가 본 세 가지 일입니다.

### "어젯밤 에이전트에게 화를 냈다. 에이전트는 그걸 메모해 뒀다."

![자기 학습가 배운 것과 바꾼 것을 보고하는 화면, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

이것은 우리가 이 저장소에서 돌리는 자기 학습가 실제로 낸 보고서입니다. 우리 자신의 에이전트 세션을
읽고, 반복되는 실수를 찾아, 에이전트 자신의 스킬을 바꾸자고 제안합니다. 사람이 제안을 읽고 승인하거나
거절합니다. 그날 저녁 내가 화가 났던 두 가지는 다음 날 아침 실제로 쓰이는 스킬의 규칙이 되어 있었습니다.
아무도 직접 입력하지 않았습니다.

다음 날에는 스스로 숙제를 확인했습니다.

![다음 날 아침: 자기 학습가 전날 바꾼 내용이 도움이 되었는지 측정한다, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

전날 바꾼 스킬 세 개를 살펴봤고, 세 스킬 모두에서 실패가 멈췄습니다. 아무도 찾아보라고 시키지
않았는데, 우리 릴리스 스크립트의 버그도 하나 찾아냈습니다.

### "나는 잠자리에 들었다. 에이전트는 교대를 했다."

![5분마다 임계값을 향해 내려가는 사용량 감시 기록, 그리고 2%에서 발동한 인수인계](../evidence/rotation-quota-watch-2026-09-18.png)

우리 에이전트 중 하나가 긴 빌드를 한창 진행하던 중에 주간 사용량이 거의 바닥났습니다. 멈춰서 기다리지
않았습니다. 인수인계 메모를 썼습니다. 무엇이 끝났는지, 무엇이 절반만 끝났는지, 이어서 작업할 정확한
커밋이 무엇인지. 그런 다음 다른 하네스의 에이전트를 깨웠습니다.

한 가지가 잘못되었는데, 읽어 볼 만한 부분이 바로 이것입니다. 새 에이전트가 인수인계를 확인하기도
전에 편집을 시작했습니다. 처음 에이전트가 이를 알아채고 멈추게 한 뒤 메모를 다시 쓰고, 제대로 다시
넘겼습니다. 15분쯤 지나 두 번째 에이전트가 일하고 있었고, 처음부터가 아니라 첫 번째 미완료 작업부터
이어받았습니다. 그동안 나는 내내 자고 있었습니다.

그날 밤 전체는 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)에 있습니다.
모든 사용량 기록, 메모의 두 버전, 커밋이 들어 있습니다. 호스트 이름, 주소, 세션 ID는 가려 두었고,
그 밖에는 아무것도 손대지 않았습니다.

### "몇 달 동안, 상대편은 단 한 번도 '좋아 보이네요'라고 한 적이 없다."

우리는 이 저장소에서 몇 달 동안 Claude Code가 Codex의 작업을 검토하고, Codex가 Claude Code의 작업을
검토하게 해 왔습니다. 빈손으로 돌아온 검토는 하나도 없었습니다. 예전에는 작업이 나쁘다는 뜻이라고
생각했습니다. 사실은 한 하네스의 검토자 하나로는 결코 충분하지 않다는 뜻입니다.

## 오늘 작동하는 것

*마지막 업데이트: 2026-10-18.*

| 구성 요소 | 상태 |
|---|---|
| Codex, Claude Code, Hermes Agent, Cursor, OpenClaw를 아우르는 하나의 메모리 | 릴리스됨. 깨끗한 컴퓨터에서 레지스트리로 설치해 처음부터 끝까지 검증됨 |
| Cursor: 같은 메모리, 스킬, 검토, 이어받기, 자기 학습 | 1.3에서 릴리스됨. `cursor-agent` 명령줄은 깨끗한 Linux 컴퓨터에서 처음부터 끝까지 검증됨. macOS의 Cursor 앱은 아직 검증 중 |
| Sno Reach, 데몬 없이 에이전트끼리 대화하기 | `sno setup`으로 설치됨. Linux와 macOS. 깨끗한 Linux 컴퓨터에서 처음부터 끝까지 검증됨 |
| 자기 학습와 팀 스킬 | `sno setup`으로 설치됨. 야간 작업이 깨끗한 Linux 컴퓨터에서 실행됨 |
| 명령 하나로 설치 | `sno setup`이 위의 모든 것을 설치함. 깨끗한 Linux 컴퓨터에서 검증됨 |
| 에이전트 안에서 "Sno onboard" | 사용 가능. 설치 후에 시작되며, 직접 말해도 시작됨 |

한 행은 깨끗한 컴퓨터에서 실행된 뒤에야 "검증됨"이라고 적습니다.

## 일부러 잊어버리는 메모리

*마지막 업데이트: 2026-10-11.* 에이전트의 메모리는 대개 조용한 방식 두 가지로 실패합니다. 남겨야 할 것을
잃어버리고, 사라져야 할 것을 계속 간직합니다. 두 번째가 더 큰 비용을 치르게 합니다. 취소한 선호, 바뀐
마감일, 이사 나온 주소를 여전히 "기억하는" 에이전트는 그것을 확신을 가지고 실행에 옮기기 때문입니다.

그래서 이곳의 메모리는 나중 사실이 이전 사실을 대체하면 이전 사실을 내려놓습니다. 무엇을 남기고 무엇을
놓아 줄지는 모델이 새로 나올 때가 아니라 쓰면서 나아집니다. 공개 메모리 테스트에서의 결과는, 그 바탕이
된 모든 답변과 트레이스와 함께 [`evals/`](../../evals/)에 있습니다.

## 디자인 파트너

우리는 이미 두 개 이상의 에이전트를 나란히 실행하면서 그 사이에서 결과를 손으로 옮기고 있는 소수의
분들과 함께 작업하고 있습니다. 여러분이 그렇다면
[디자인 파트너 이슈](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)를
열어 무엇을 실행하고 있는지 알려 주세요.

## 보안

[SECURITY.md](../../SECURITY.md)를 참고하세요. 암호화가 무엇을 보호하고 무엇을 보호하지 않는지는
[docs/security.md](../security.md)에 있습니다.

## 라이선스

Apache-2.0. 처음부터 끝까지 오픈소스입니다. [LICENSE](../../LICENSE)를 참고하세요.

## 감사의 말

이 저장소가 바탕으로 삼은 작업들입니다.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). 에이전트는 세션마다 다시 알아내는 대신, 배운 것을 정리한 위키를 가지고 있어야 한다.
- Tang, Rashtchian, Ferng, Tomkins, Juan, Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). 에이전트 자신의 경험을 지식으로 바꾸어 스킬을 다시 쓰게 한다.
- Zhang, Hu, Upasani 외, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). 자기 학습를 설계하면서 에이전트가 무엇을 간직할지 가려내는 방식을 살펴보았다.
- Uddin, Shubham, Blanco, Baral, Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). 메모리가 더 이상 말하지 말아야 할 것까지 검사하는 첫 벤치마크.
