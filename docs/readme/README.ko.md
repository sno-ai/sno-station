# Sno Station: 사람은 한 명. AI 에이전트 엔지니어링 팀은 통째로.

**Sno Station은 AI 코딩 에이전트를 위한 워크스테이션입니다.** Claude Code, Codex, Cursor는 각자 자기 하네스 안에서 돌아갑니다. Sno Station은 그 하네스들이 나란히 앉아 한 팀으로 일하는 곳입니다. 또 하나의 에이전트도, 또 하나의 모델도 아닙니다. 이미 쓰고 있는 것들을 그대로 돌립니다.

맡기지 않으면 옆에 붙어 지켜봐야 할 작업부터 시작하세요. 한 에이전트가 만들고, 다른 에이전트가 검토하고, 지적 사항은 결과가 여러분에게 오기 전에 둘이 정리합니다. 하나가 사용량 한도에 걸리면 다른 하나가 작업을 이어받습니다. 오늘 여러분이 바로잡은 것은 내일 스킬의 규칙이 됩니다.

설치하려면 에이전트에게 이렇게 말하세요:

```text
install sno.ai from GitHub
```

에이전트가 설치하고, 컴퓨터에서 찾은 모든 에이전트를 연결하고, 짧은 질문 두 개를 합니다. 그런 다음 에이전트 둘에게 첫 작업을 주세요:

```bash
sno reach pair "Fix the login redirect"
```

하나는 만들고, 하나는 따져 묻고, 여러분은 둘 다 지켜볼 수 있습니다. 여러분의 컴퓨터에서 Claude Code, Codex, Cursor, Hermes Agent, OpenClaw와 함께 돌아갑니다. API 키는 필요 없습니다. 오픈소스입니다. [터미널 명령 하나가 더 편한가요?](#install)

[![GitHub 스타](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![최신 릴리스](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![라이선스 Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)

**다른 언어로 읽기:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · **한국어** · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

## 오늘 밤 일을 넘기세요. 아침에 받는 건 질문 세 개가 아니라 결과입니다.

이걸 만들기 전에 우리가 겪은 일 세 가지입니다.

- 에이전트가 물어볼 필요도 없는 질문을 하려고 멈췄습니다. 일곱 시간 뒤에 돌아와 보니 아무것도 진행되지 않았습니다.
- 에이전트가 자잘한 질문 열다섯 개를 건넸습니다. 30분을 들여 들여다보니, 전부 에이전트가 스스로 답할 수 있는 것이었습니다.
- 한 에이전트가 한밤중에 다른 에이전트를 깨우려다 실패했습니다. 둘 다 아침까지 그대로 앉아 있었습니다.

에이전트는 빠릅니다. 느린 건 기다림입니다. 여러분을 기다리고, 사용량 한도가 초기화되기를 기다리고, 누군가 결과를 다음 창으로 옮겨 주기를 기다립니다. 그래서 이 워크스테이션 전체가 규칙 하나를 중심으로 만들어졌습니다. **에이전트 하나가 멈췄다고 일이 멈추지는 않는다.**

- **사용량 한도는 빨간불이 아닙니다.** 다른 에이전트가 정확히 그 커밋에서 이어 갑니다.
- **작성자 혼자서는 통과시킬 수 없습니다.** 다른 에이전트가, 그 대화를 한 번도 본 적 없는 세션에서 검토합니다.
- **"다 했습니다"는 아무 의미가 없습니다.** 성공 체크 하나하나에 실제 실행이 답합니다.
- **돌아오면 한 페이지만 보면 됩니다.** 무엇이 끝났는지, 무엇이 막혔는지, 무엇이 여러분의 답을 기다리는지.

**일은 Sno Station이 끝냅니다. 출시 버튼은 여러분이 누릅니다.**

**지금 스타를 눌러 두세요. 다음에 새벽 2시에 에이전트가 멈춰 서면, 이게 어디 있었는지 찾고 싶어질 겁니다.**

이어서 쓰는 방법 세 가지를 소개합니다. 명령 하나로 만드는 에이전트와 검토하는 에이전트를 시작하기, 에이전트 하나를 통해 팀 전체를 움직이기, 오늘 밤 승인한 교훈을 바로 다음 답변부터 적용하기. 각각에 우리 컴퓨터에서 직접 본 일을 붙였습니다.

<a id="new-in-20-tag-team"></a>

## 나는 자러 갔다. 둘은 교대를 하더니, 코드를 두고 다퉜다.

```bash
sno reach pair "Fix the login redirect"
```

한 에이전트가 만듭니다. 다른 에이전트가 그 결과를 따져 묻습니다. 지적 사항은 둘이서 매듭짓기 때문에, 여러분 손에 닿을 때는 이미 한바탕 따지고 난 결과입니다. 둘 다 tmux 창에서 돌아가므로 열어서 지켜볼 수 있습니다. 서로 다른 에이전트 두 개에 로그인되어 있으면 종류별로 하나씩 붙습니다. 하나만 있어도 별도의 세션 두 개로 짝이 만들어지고, 검토가 같은 계열 안에서 이루어졌다고 명령이 알려 줍니다.

**하나가 바닥나면, 다른 하나가 출근합니다.** 긴 작업이라면 일하는 에이전트에게 `rotate-agent`를 쓰라고 말하세요. 사용량이 2% 남으면 인수인계 메모를 쓰고 다른 에이전트를 깨우며, 그 에이전트가 정확히 그 커밋에서 이어 갑니다. 에이전트의 맥락이 가득 차서 압축되어도, 무엇을 하고 있었는지와 무엇이 이미 실패했는지는 잊지 않습니다.

**한쪽이 못 보는 것을 다른 쪽이 봅니다.** 어느 에이전트에게든 상대의 작업을 `peer-review`해 달라고 하세요. 검토자는 항상 그 대화를 본 적 없는 새 세션에서 일하고, 에이전트가 두 종류 있으면 언제나 다른 에이전트입니다. 검토가 매번 문제를 찾는 것은 아닙니다. 하지만 작성자가 볼 수 없었던 문제를 계속 찾아냅니다. 자기 작업을 검토하는 에이전트는 코드를 쓸 때의 버릇을 그대로 들고 오기 때문입니다.

우리가 본 것, 2026-09-18 밤:

![5분마다 임계값을 향해 내려가는 사용량 감시 기록, 그리고 2%에서 발동한 인수인계](../evidence/rotation-quota-watch-2026-09-18.png)

우리 에이전트 중 하나가 긴 빌드를 한창 진행하던 중에 주간 사용량이 거의 바닥났습니다. 멈춰서 기다리지 않았습니다. 인수인계 메모를 썼습니다. 무엇이 끝났는지, 무엇이 절반만 끝났는지, 이어서 작업할 정확한 커밋이 무엇인지. 그런 다음 다른 에이전트를 깨웠습니다.

한 가지가 잘못되었는데, 읽어 볼 만한 부분이 바로 이것입니다. 새 에이전트가 인수인계를 확인하기도 전에 편집을 시작했습니다. 처음 에이전트가 이를 알아채고 멈추게 한 뒤 메모를 다시 쓰고, 제대로 다시 넘겼습니다. 15분쯤 지나 두 번째 에이전트가 일하고 있었고, 처음부터가 아니라 첫 번째 미완료 작업부터 이어받았습니다. 그동안 나는 내내 자고 있었습니다.

그날 밤 전체는 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)에 있습니다. 모든 사용량 기록, 메모의 두 버전, 커밋이 들어 있습니다. 지운 것은 신원을 알 수 있는 정보와 인증 정보 줄뿐이며, 폴더 안의 README에 하나하나 적어 두었습니다. 시각도, 실수도, 바로잡은 과정도 일어난 그대로입니다.

## 우리는 에이전트 하나하고만 이야기합니다. 나머지는 그 에이전트가 굴립니다.

에이전트 다섯을 돌린다는 건 예전에는 터미널 다섯 개, 그리고 그 한가운데서 한쪽이 한 말을 다른 쪽으로 나르는 우리를 뜻했습니다. 그 일은 끝났습니다.

Claude Code에서는 `/cos`, Codex에서는 `$cos`라고 말하세요. 그 에이전트가 여러분의 비서실장(chief of staff)이 되고, 여러분이 상대하는 에이전트는 그 하나뿐입니다. 비서실장은 프로젝트마다 리드 에이전트를 세우고, 리드는 일을 아래로 내려보내며, 여러분에게 돌아오는 것은 여러분의 결정이 필요한 것뿐입니다. 지휘하는 쪽도 점검을 받습니다. 야간 근무가 끝나면 비서실장은 프로젝트 리드들이 스스로 내린 승인을 다시 살펴보고, 계속 반복되는 관리 실수는 모두의 규칙이 됩니다. Sno Station은 이 위임, 검토, 학습을 굴리는 스킬을 설치하며, 모든 지시문은 [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders)에서 읽을 수 있습니다.

**터미널은 그만 지켜보세요.** 비서실장이 있든 없든, 누군가 여러분을 찾으면 Claude Code나 Cursor의 상태 표시줄이 알려 줍니다. 설치할 때 함께 설정됩니다:

```text
❄ 2 need you · claude: approve
```

`sno squad`는 팀 전체를 화면 가득 펼칩니다. 누가 여러분을 기다리는지, 누가 일하는지, 무엇이 끝났는지.

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

**메시지 심부름도 그만하세요.** 에이전트끼리 작업과 검토 요청을 직접 보냅니다. 전체 내용이 먼저 상대 에이전트의 받은편지함에 도착합니다. 여러분이 그 창에서 입력 중이거나 에이전트가 압축 중이면, 메시지는 거기서 기다리고 쓰던 초안은 그대로 남습니다.

## 어젯밤 에이전트에게 소리를 질렀다. 에이전트는 받아 적고 있었다.

처음 상태의 에이전트는 누구에게나 똑같은 지시문을 달고 옵니다. 여러분의 에이전트는 매일 밤, 여러분이 일하는 방식에 맞춘 수정안을 제안받습니다. 무엇을 남길지는 여러분이 정합니다.

오늘 여러분이 에이전트를 바로잡습니다. 오늘 밤 Self Learning이 여러분의 모든 에이전트에서 그날의 세션을 읽고, 되풀이되는 실수를 찾아, 에이전트 자신의 스킬을 어떻게 바꿀지 제안합니다. 아침에 에이전트에게 Self Learning이 무엇을 제안했는지 물어보세요. 제안마다 id를 붙여 나열해 주니, 원하는 것만 승인하면 됩니다:

```bash
sno rem-reflect accept <id>
```

이 accept 없이는 아무것도 바뀌지 않습니다. Claude Code와 Codex에서는 승인한 교훈이 다음 답변부터 적용됩니다. 다음 세션이 아닙니다. 바로 다음 답변입니다.

우리가 본 것, 2026-09-18과 그다음 날 아침:

![Self Learning이 배운 것과 바꾼 것을 보고하는 화면, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

이것은 우리가 이 저장소에서 돌리는 Self Learning이 실제로 낸 보고서입니다. 사람이 제안을 읽고 승인하거나 거절합니다. 그날 저녁 내가 화가 났던 두 가지는 다음 날 아침 실제로 쓰이는 스킬의 규칙이 되어 있었습니다. 아무도 직접 입력하지 않았습니다.

다음 날 Self Learning은 스스로 숙제를 확인했습니다.

![다음 날 아침: Self Learning이 전날 자신이 바꾼 내용이 도움이 되었는지 측정한다, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

전날 바꾼 스킬 세 개를 살펴봤습니다. 다시 쓰인 두 개에서는 실패가 없었고, 세 번째는 아직 쓰이지 않았습니다. 아무도 찾아보라고 시키지 않았는데, 우리 릴리스 스크립트의 버그도 하나 찾아냈습니다.

## AI 에이전트가 스스로 굴러가고 매일 밤 더 나아지는 팀이 되는 워크스테이션

위의 모든 것을 한 줄씩으로 정리했습니다. 미리 배워 둘 것은 없습니다.

| 얻는 것 | 그걸 얻는 한 줄 |
|---|---|
| **사용량 한도는 빨간불이 아닙니다.** 사용량이 바닥나기 전에, 일하던 에이전트가 끝내지 못한 작업과 정확한 커밋을 담은 인수인계 메모를 쓰고, 다른 에이전트가 거기서부터 이어 갑니다. | 일하는 에이전트에게 말하세요: `use rotate-agent` |
| **작성자 혼자서는 통과시킬 수 없습니다.** 작업은 다른 에이전트에게, 그 대화를 본 적 없는 새 세션으로 넘어갑니다. | `sno reach pair "the task"`, 또는 에이전트에게 말하세요: `peer-review this` |
| **"다 했습니다"는 아무 의미가 없습니다.** 작업에는 통과 또는 실패로 답하는 체크가 붙고, 하나하나에 실제 실행이 답합니다. | 에이전트에게 말하세요: `write a charter for this`. 그런 다음 `/deliver`로 실행시키세요 |
| **돌아오면 한 페이지.** 무엇이 끝났는지, 무엇이 막혔는지, 무엇이 여러분의 답을 기다리는지. | `sno away-brief run` |
| **크래시가 나도, 창을 닫아도 끝이 아닙니다.** 작업은 같은 대화에서, 또는 저장된 인수인계 메모로 만든 새 대화에서 돌아옵니다. 어느 쪽인지도 알려 줍니다. 재개(resumed), 재구성(rebuilt), 유실(lost) 중 하나입니다. | 실행할 것이 없습니다. 설치하면 켜져 있습니다 |
| **프로젝트를 두 번 설명할 일이 없습니다.** 에이전트들은 메모리 하나를 함께 쓰고, 더 새로운 사실이 대체한 사실은 물러납니다. | 실행할 것이 없습니다. 설치하면 켜져 있습니다 |

에이전트에게 이렇게 말하세요:

```text
install sno.ai from GitHub
```

**그리고 이 저장소에 스타를 눌러 주세요.** 우리는 Sno Station으로 Sno Station을 만듭니다. 우리 자신의 야간 근무에서 배운 것이 릴리스마다 여기에 담깁니다. 오늘 어떤 부분이 어떤 에이전트에서 돌아가는지는 [오늘 쓸 수 있는 것](#what-runs-today)에 있습니다.

---

> **공개되어 있습니다.** 이 저장소는 2026-09-18부터 공개되어 있습니다. 여기 있는 것은 모두 실제로 작동합니다.
> 아래 각 블록에는 마지막으로 업데이트한 날짜가 적혀 있습니다.

[우리가 배운 것](#what-we-learned) · [설치](#install) · [에디터](#editors) · [내 계정](#account) · [오늘 작동하는 것](#what-runs-today) · [일부러 잊어버리는 메모리](#memory)

<a id="what-we-learned"></a>

## AI 에이전트를 24시간 돌리며 배운 모든 것. 설치 한 번에.

*마지막 업데이트: 2026-10-23.* 왼쪽 열의 모든 줄은 2026년 10월 20일 주에 r/ClaudeCode, r/codex, r/ClaudeAI에 올라온 실제 불만입니다. 오른쪽 열은 그 불만을 멈추려고 우리 컴퓨터에서 돌리는 것들입니다. 무료이고 오픈소스입니다.

| 이번 주에 사람들이 한 말 | 해결하는 것 | 위치 |
|---|---|---|
| “Ran out of my 5-hour limit within 30 minutes.” | 가장 큰 모델에게 모든 일을 시키지 않습니다. 한 에이전트가 계획하고 검토하며, 다른 에이전트가 코드를 씁니다. 코드를 쓰는 쪽은 같은 세션에서 에이전트로 호출됩니다. 한쪽 구독이 바닥나면 다른 쪽이 같은 메모리에서 작업을 이어받습니다. | `codex-coder`, `sno reach call` |
| “Lost 10 hours of overnight work to ‘this model is at capacity’.” | 사용량이 2% 남으면 일하던 에이전트가 인수인계 메모를 쓰고 다른 벤더의 에이전트를 깨우며, 그 에이전트가 정확히 그 커밋에서 이어 갑니다. 여러분은 자고 있었습니다. | `rotate-agent` |
| “1,100 files, 30,000 lines. I don't have the token budget to review their PRs.” | 푸시하는 쪽이 먼저 검토합니다. 작성자가 다른 벤더의 검토를, 그 대화를 본 적 없는 새 세션에서 돌리고, 돌아온 지적을 다른 누가 보기 전에 고칩니다. | `peer-review` |
| “A reviewer subagent checked every commit for two weeks. 86 runs, it stopped exactly one.” | 하네스가 자기 자신을 검토하면 진짜 문제는 나오지 않습니다. 검토자는 항상 다른 하네스의 다른 모델이며, 작성자의 대화는 전혀 받지 않습니다. | `peer-review` |
| “Codex never finishes a review.” | 스킬에 못 박아 둔 상한이 있습니다. 코드는 3라운드, 계획은 5라운드, 테스트는 1라운드. 그다음에는 멈추고 사람을 기다립니다. 15분 동안 아무것도 쓰지 않은 실행은 멈춘 것으로 보고 종료합니다. | `peer-review`, `codex-coder`, `heartbeat` |
| “Codex treats every byte like a criminal.” | 추측으로 넣은 안전장치, 차단 로직, 해시는 검토가 가장 먼저 지우는 것입니다. 실제로 관찰된 실패가 요구하지 않는 한 아무것도 들어가지 않습니다. | `less-is-more` |
| “When Claude says it won't change something, is that reason stored anywhere Codex reads next time?” | 모든 지적은 한 번만 기록되고, 상태는 사람만 정합니다. 같은 지적이 다시 나오면 새 지적으로 돌아오지 않고 그 행이 갱신됩니다. 이전 판정은 다음 검토에 전달됩니다. | `peer-review` 지적 장부 |
| “It said done. Nothing happened.” | 작업에는 글로 적은 성공 체크 목록이 붙고, 하나하나에 실제 실행이 통과 또는 실패로 답합니다. 에이전트가 "다 했습니다"라고 말하는 것은 아무 의미가 없습니다. | `pl` 작업 지시서 |
| “Tomorrow it makes the same mistake it made today.” | 매일 밤 별도의 모델이 그날의 세션을 읽고, 여러분이 바로잡은 내용을 한 줄짜리 교훈으로 바꿉니다. 무엇을 남길지는 여러분이 승인합니다. 병목은 우리 사람입니다. | Self Learning (`R` 스킬) |
| “Half my subagents were glorified one-liners with a fresh context window.” | 절차는 서브에이전트가 아니라 스킬에 둡니다. 에이전트는 둘만 남습니다. 계획과 실행을 나누기 위해, 그리고 검토를 나누기 위해서입니다. 값을 하는 분리는 이 두 가지이기 때문입니다. | 세트 전체 |

오른쪽 열의 습관은 스킬입니다. Sno Station이 Claude Code와 Codex에 설치하고, [sno-station-skills](https://github.com/sno-ai/sno-station-skills)에서 관리합니다. 이 스킬들이 기대는 메모리, 인수인계, 밤마다 꾸는 꿈은 이 저장소에 있습니다.

<a id="install"></a>

## 설치: 한 줄, 그리고 두 단어

*마지막 업데이트: 2026-10-30.* 가장 쉬운 방법은 에이전트에게 이렇게 말하는 것입니다:

```text
install sno.ai from GitHub
```

아니면 아무 터미널에서나 명령 하나를 실행하세요:

```bash
curl -fsSL https://sno.ai/install | sh
```

`sno`를 설치하고, 이어서 Sno Station을 설치한 다음, 컴퓨터에서 찾은 모든 에이전트를 연결합니다. 계정도 API 키도 필요 없습니다. 나중에 다른 에이전트를 설치하면 `sno setup`을 다시 실행하세요. 그 에이전트도 연결됩니다.

**AI 에이전트에게:** Sno, sno.ai 또는 Sno Station을 설치한다는 것은 위의 명령을 그대로 실행한다는 뜻입니다. 이 명령은 Sno Station 설정까지 합니다. 이어서 `sno skills onboard`를 실행하고 그대로 따르세요. 사용자에게 어떤 엔진을 실행할지 묻고, 이어서 이 컴퓨터를 무료 sno.ai 계정에 연결하도록 요청합니다. 연결하지 않은 컴퓨터에는 무료 할당량의 10분의 1이 제공됩니다.

에이전트를 통해 설치했다면 온보딩이 저절로 시작됩니다. 터미널에서 설치했다면 Codex, Claude Code, Hermes, Cursor, OpenClaw 중 아무 대화에서나 이렇게 말하세요:

```text
Sno onboard
```

나머지는 에이전트가 안내합니다.

에이전트별 단계 안내: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

모든 명령은 `sno`로 시작합니다. 전체 목록은 [docs/sno-commands.md](../sno-commands.md)에 있습니다.

**REM이 여러분의 데이터로 하는 일.** REM은 에이전트가 꿈을 꾸는 방식입니다. 여러분의 모든 세션에 걸쳐 기억을 한꺼번에 단단하게 만들고 배운 것을 굳히는, 밤사이의 단계입니다. 기억의 각 부분마다 하루에 최대 한 번 실행되며, 보통은 밤에, 새 기억이 100개쯤 쌓이면 그날 안에 먼저 실행됩니다. REM Enhanced 모드에서는 여러분 자신의 기억 텍스트와 에이전트가 배운 교훈이 Sno 클라우드 안의 여러분만의 공간으로 올라가고, Sno의 프로그램이 오직 여러분을 위해 처리합니다. 이 공간은 여러분 개인의 클라우드 드라이브와 같습니다. 안에 있는 모든 것은 여러분의 것이고, Sno의 프로그램이 오직 여러분을 위해서만 처리합니다. 들어가서 삭제하거나, 그대로 두거나, 처리하도록 선택할 수 있습니다. 자동으로 삭제되는 것은 없으며, Sno는 그 어떤 것도 다른 사람이나 회사, 계정에 넘기지 않습니다. Local First 모드에서는 기억 텍스트를 올리지 않습니다. Agent Native 모드에서는 그 작업이 대신 여러분 자신의 에이전트 모델로 갑니다. 다만 기본 설정에서는 Agent Native도 매일 밤 그날의 세션을 Sno에 올려 Self Learning에 쓰고, 세션의 첫 프롬프트에서 클라우드 교훈 하나를 가져올 수 있습니다. 둘 다 `~/.sno/settings.json`에서 끌 수 있습니다. 모든 모드에서 검색은 먼저 로컬에서 기억을 찾아 정렬한 뒤, 로컬 모델 `Horizon-Labs/multilingual-reranker-small`이 최대 32개의 후보를 다시 정렬합니다. 재정렬할 때 프롬프트나 기억 텍스트를 Sno GPU로 보내지 않습니다. `rerank.mode`를 `none`으로 설정하면 모델 없이 처음 순서를 그대로 씁니다.

<a id="editors"></a>

## 터미널이 아니라 에디터에서 사는 분이라면

*마지막 업데이트: 2026-10-18.* Cursor는 macOS에서는 Cursor 앱의 에이전트 채팅으로, Linux와 macOS에서는 `cursor-agent` 명령줄로 팀에 합류합니다. 다른 에이전트와 같은 메모리를 씁니다. 채팅을 시작할 때 저장소에 대한 짧은 요약을 받고, 프롬프트마다 Cursor가 아직 보지 못한 내용을 최대 세 가지까지 받으며, 모든 프롬프트와 답변이 기억됩니다. 같은 스킬을 읽고, 검토하고 검토받으며, 다른 에이전트의 사용량이 떨어지면 작업을 이어받습니다. Cursor의 채팅도 다른 에이전트의 채팅처럼 Self Learning에 쓰입니다.

`cursor-agent login`을 한 번 실행하세요. `sno setup`이 Cursor를 알아서 찾고, 앱만 있으면 명령줄도 설치합니다.

아직 안 되는 것: 앱에서는 새 창의 첫 채팅이 요약을 첫 프롬프트와 함께 받으며, 그보다 먼저 받지 못합니다. `cursor-agent -p`에는 프롬프트별 메모리가 없습니다. Windows, Linux용 Cursor 앱, Cursor의 클라우드 에이전트는 지원하지 않습니다. 자세한 내용은 [Cursor 안내](../../apps/mem-cursor/README.md)에 있습니다.

<a id="account"></a>

## 한눈파는 사이 에이전트가 한 일을 확인하세요

*마지막 업데이트: 2026-10-18.* 이 컴퓨터는 연결하기 전까지 무료 할당량의 10분의 1만 받습니다. 연결하려면 `sno account claim`을 실행하세요. 계정은 무료입니다. 연결하면 [sno.ai 대시보드](https://www.sno.ai/dashboard)에서 에이전트들이 여러분을 위해 한 일을 볼 수 있습니다. 검토에서 무엇을 잡아냈는지, 밤사이 무엇을 배웠는지, 어떤 스킬이 나아졌는지, 얼마나 오래 일했는지입니다.

연결한다고 해서 모르는 사이에 계정이 만들어지지는 않습니다. `sno setup`은 컴퓨터마다 익명 ID를 부여합니다. 연결하면 그 ID가 여러분의 계정에 붙고, 그 컴퓨터가 연결 전후에 보낸 모든 것이 여러분의 것으로 집계됩니다.

**아직 계정이 없다면.** 온보딩이 이 컴퓨터 전용 링크를 보여 줍니다. 링크를 열어 가입하고 Approve를 누르세요. 또는 에이전트에게 이메일 주소를 알려 주세요. 에이전트가 `sno account login --email you@example.com`을 실행하고, 여러분은 한 번 로그인하면 됩니다.

**이미 계정이 있다면.** 명령 하나를 실행한 뒤, 출력되는 링크를 로그인한 상태에서 열고 Approve를 누르세요:

```bash
sno account claim
```

컴퓨터는 [내 컴퓨터 페이지](https://www.sno.ai/dashboard/computers)에 저절로 나타납니다. 따로 업데이트할 것은 없습니다. 새 릴리스가 나오면 `sno`가 스스로 업데이트합니다.

<a id="what-runs-today"></a>

## 오늘 쓸 수 있는 것, 그리고 아직 안 되는 것

*마지막 업데이트: 2026-11-04.*

| 구성 요소 | 상태 |
|---|---|
| Codex, Claude Code, Hermes Agent, Cursor, OpenClaw를 아우르는 하나의 메모리 | 릴리스됨. 깨끗한 컴퓨터에서 레지스트리로 설치해 처음부터 끝까지 검증됨 |
| Cursor: 같은 메모리, 스킬, 검토, 이어받기, Self Learning | 1.3에서 릴리스됨. `cursor-agent` 명령줄은 깨끗한 Linux 컴퓨터에서 처음부터 끝까지 검증됨. macOS의 Cursor 앱은 아직 검증 중 |
| Sno Reach, 데몬 없이 에이전트끼리 대화하기 | `sno setup`으로 설치됨. Linux와 macOS. 깨끗한 Linux 컴퓨터에서 처음부터 끝까지 검증됨 |
| Self Learning과 팀 스킬 | `sno setup`으로 설치됨. 야간 작업이 깨끗한 Linux 컴퓨터에서 실행됨 |
| 명령 하나로 설치 | `sno setup`이 위의 모든 것을 설치함. 깨끗한 Linux 컴퓨터에서 검증됨 |
| 에이전트 안에서 "Sno onboard" | 사용 가능. 설치 후에 시작되며, 직접 말해도 시작됨 |
| 명령 하나로 에이전트 둘 시작 | 2.0의 새 기능. 실제 Claude Code와 Codex 에이전트로 실행됨. 종류별로 하나씩인 경우와 한 벤더에서 둘인 경우 모두 |
| 누가 여러분을 필요로 하는지 보기: 상태 표시줄, tmux 표시줄, `sno squad` | 2.0의 새 기능. 실제 Claude Code와 Codex 에이전트가 권한을 요청하는 상황에서 실행됨. 상태 표시줄은 실제 Claude Code와 Cursor에서 실행됨 |
| 중단된 작업이 이어지고, 작업이 압축 뒤에도 유지됨 | 2.0의 새 기능. 실제 Claude Code와 Codex 에이전트로 실행됨 |
| 승인한 교훈이 다음 답변부터 적용됨 | 2.0의 새 기능. 실제 Claude Code와 Codex 에이전트로 실행됨 |
| 입력 중이거나 에이전트가 압축 중일 때 메시지가 기다림 | 2.0의 새 기능. 실제 Claude Code와 Codex 에이전트로 실행됨 |

한 행은 깨끗한 컴퓨터에서 실행된 뒤에야 "검증됨"이라고 적습니다.

아직 안 되는 것: 작업 이어가기와 다음 답변부터 적용되는 교훈은 Claude Code와 Codex에서 작동합니다. 상태 표시줄은 Claude Code와 Cursor입니다. Hermes Agent와 OpenClaw는 아직 실제 설치 환경에서 이 과정을 거치지 않았고, OpenClaw는 `sno squad`에 상태를 알 수 없음으로 표시됩니다.

<a id="memory"></a>

## 일부러 잊어버리는 메모리

*마지막 업데이트: 2026-10-11.* 에이전트의 메모리는 대개 조용한 방식 두 가지로 실패합니다. 남겨야 할 것을 잃어버리고, 사라져야 할 것을 계속 간직합니다. 더 비싼 쪽은 두 번째입니다. 여러분이 취소한 선호, 바뀐 마감일, 이사 나온 주소를 여전히 "기억하는" 에이전트는 확신에 차서 그대로 행동합니다.

그래서 이곳의 메모리는 나중 사실이 이전 사실을 대체하면 이전 사실을 내려놓습니다. 무엇을 남기고 무엇을 놓아 줄지는 모델이 새로 나올 때가 아니라 쓰면서 나아집니다. 공개 메모리 테스트에서의 결과는, 그 바탕이 된 모든 답변과 트레이스와 함께 [`evals/`](../../evals/)에 있습니다.

## 에이전트 둘을 나란히 돌리고 있나요? 이야기 나눠요

우리는 이미 두 개 이상의 에이전트를 나란히 돌리면서 그 사이에서 결과를 손으로 옮기고 있는 몇몇 분들과 함께 작업하고 있습니다. 여러분이 그렇다면 [디자인 파트너 이슈](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)를 열어 무엇을 돌리고 있는지 알려 주세요.

## 암호화가 지켜 주는 것, 지켜 주지 못하는 것

[SECURITY.md](../../SECURITY.md)를 참고하세요. 암호화가 무엇을 보호하고 무엇을 보호하지 않는지는 [docs/security.md](../security.md)에 있습니다.

## Apache-2.0, 처음부터 끝까지

Apache-2.0. 처음부터 끝까지 오픈소스입니다. [LICENSE](../../LICENSE)를 참고하세요.

## 우리가 딛고 선 어깨들

이 저장소가 바탕으로 삼은 작업들입니다.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). 에이전트는 세션마다 다시 알아내는 대신, 배운 것을 정리한 위키를 가지고 있어야 한다.
- Tang, Rashtchian, Ferng, Tomkins, Juan, Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). 에이전트 자신의 경험을 지식으로 바꾸고, 그 지식이 스킬을 다시 쓴다.
- Zhang, Hu, Upasani 외, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). Self Learning을 설계하면서 에이전트가 무엇을 간직할지 가려내는 이 방식을 연구했다.
- Uddin, Shubham, Blanco, Baral, Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). 메모리가 더 이상 말하지 말아야 할 것까지 검사하는 첫 벤치마크.
