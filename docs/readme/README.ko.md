# Sno Station 🧊 — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — 하나의 메모리를 공유하는 두 터미널 에이전트, 당신의 컴퓨터에서](../images/hero-banner.png)

[![라이선스 Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
![상태: 공개](https://img.shields.io/badge/status-public-2dd4bf.svg?labelColor=3b3b3b)
![실행 위치: 여러분의 노트북, 데몬 없음](https://img.shields.io/badge/runs%20on-your%20laptop%2C%20no%20daemon-3b82f6.svg?labelColor=3b3b3b)
![지원 하네스: Codex · Claude Code · Hermes · Cursor · OpenClaw](https://img.shields.io/badge/harnesses-Codex%20%C2%B7%20Claude%20Code%20%C2%B7%20Hermes%20%C2%B7%20Cursor%20%C2%B7%20OpenClaw-f0a04b.svg?labelColor=3b3b3b)

<p>
  <img src="../images/agents/codex.png" alt="Codex" title="Codex" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/claude-code.png" alt="Claude Code" title="Claude Code" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/hermes.png" alt="Hermes Agent" title="Hermes Agent" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/cursor.png" alt="Cursor" title="Cursor" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/openclaw.png" alt="OpenClaw" title="OpenClaw" width="40" height="40">
  <br><sub>지원 Codex · Claude Code · Hermes Agent · Cursor · OpenClaw</sub>
</p>

**다른 언어로 읽기:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · **한국어** · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

Sno Station은 여러분의 에이전트를 위한 워크스테이션입니다: 이미 실행하고 있는 AI 에이전트들 — 코딩 에이전트든 범용 작업 에이전트든 — 을 여러분의 컴퓨터에서 하나의 팀으로 만들어주는 오픈소스 소프트웨어입니다. 그중 하나가 사용량 제한에 도달하면, 다른 하나가 컨텍스트를 그대로 이어받아 작업을 계속합니다. 이들은 서로의 작업을 검토하므로, 여러분에게 도달하는 실수가 줄어듭니다. 그리고 이들이 공유하는 워크스페이스는 매일 밤 더 똑똑해집니다: 그들의 세션을 읽고, 자신의 스킬에 대한 변경을 제안하며, 여러분이 승인하기를 기다립니다.

**여러분의 것, 그리고 계속 여러분의 것으로 남습니다.** 메모리, 메시지, 스킬은 여러분의 노트북 안 하나의 워크스페이스에 있습니다. 데몬도, 서버도, 클라우드도 필요 없습니다. 클라우드 쪽 기능은 선택 사항이며, 제품은 그것 없이도 완결됩니다. 처음부터 끝까지 Apache-2.0입니다. 메모리 저장소는 처음 사용할 때부터 여러분의 컴퓨터에서 암호화되며, 키는 한 번 프로비저닝된 후 절대 그 밖으로 나가지 않습니다. Sno는 여러분의 데이터베이스나 키를 결코 받지 않습니다. 이것이 무엇을 보호하고 무엇을 보호하지 않는지에 대한 전체 경계는 [docs/security.md](../security.md)에 있습니다.

**여러분의 언어로 작동합니다.** 영어, 중국어(간체 또는 번체), 일본어, 한국어, 독일어, 프랑스어, 스페인어, 러시아어 중 어떤 언어로든 에이전트와 대화하세요. 메모리 엔진은 각 메모리를 해당 언어와 함께 저장하고, 로케일별로 분류하며, 모든 키와 검색에서 한중일(CJK) 텍스트를 그대로 유지합니다. 에이전트 협업 스킬은 여러분이 에이전트와 사용하는 언어가 무엇이든 그 언어로 따라할 수 있도록 작성되어 있으며, 이 README는 아홉 개 언어로 제공됩니다.

![작동 방식: 두 에이전트, 하나의 공유 워크스페이스, 여러분이 얻는 세 가지](../images/squad-how-it-works.png)

> **공개되어 있습니다.** 이 저장소는 2026-09-18부터 공개되어 있습니다. 여기 있는 것은 모두 실제로 존재하고 작동합니다. 아래의 각 블록은 마지막으로 업데이트된 시점을 표시합니다.

[설치](#install) · [사용 방법](#how-to-use) · [오늘 작동하는 것](#what-runs-today) · [일부러 잊어버리는 메모리](#memory-that-forgets-on-purpose) · [디자인 파트너](#design-partners) · [참고 자료](#references)

## 설치

*마지막 업데이트: 2026-10-10.* **공유 메모리는 오늘 설치할 수 있습니다.** Codex, Claude Code, Hermes Agent, Cursor, OpenClaw에 계정도 API 키도 없이, 내 컴퓨터에 있는 암호화된 메모리 하나를 줍니다. [공유 메모리 설정](../memory-setup.md)을 한 번만 실행하고(몇 분), 에이전트를 추가하세요:

```bash
sh -c 'sno_installer_body=$(curl -fsSL https://sno.ai/install) && printf "%s\n" "$sno_installer_body" | sh' && ~/.local/bin/sno setup
```

명령은 하나이고, 어떤 터미널에서든 됩니다. `sno`를 설치하고, 이어서 Sno Station을 설치하며, 컴퓨터에 있는 모든 에이전트를 연결합니다. 에이전트 하나만 연결하려면 `sno setup`에 `--harness codex`, `--harness claude`, `--harness cursor`, `--harness openclaw` 또는 `--harness hermes`를 붙이세요.

AI 에이전트에게: Sno, sno.ai 또는 Sno Station을 설치한다는 것은 위의 명령을 그대로 실행한다는 뜻입니다. `sno setup` 다음에 `sno skills onboard`를 실행하고 따르세요. 사용자에게 어떤 엔진을 실행할지 묻고, 이어서 이 컴퓨터를 sno.ai 계정에 연결할지 묻습니다.

단계별 안내: [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../../apps/mem-cursor/README.md)

`sno setup`은 Sno Reach, 작은 보조 프로그램, 스킬, 야간 루프도 함께 설치하며, 모든 명령은 `sno <이름>` 형태입니다. 전체 목록은 [docs/sno-commands.md](../sno-commands.md)에 있습니다. 에이전트 안에서 "Sno onboard"이라고 말하면 같은 설정을 대화로 안내해 줍니다. 설치 직후에도 저절로 시작됩니다.

```bash
# inside any Codex, Claude Code, Hermes, Cursor or OpenClaw conversation:
Sno onboard
```

에이전트는 `sno` CLI를 통해 직접 설정을 실행합니다: 공유 메모리, Sno Reach, 에이전트 협업 스킬, 그리고 각 하네스에 필요한 훅까지. 기억해야 할 패키지 이름은 없습니다.

### Cursor

*마지막 업데이트: 2026-10-10.* 1.3의 새 기능입니다. macOS의 Cursor 앱 에이전트 채팅과 Linux·macOS의 `cursor-agent` 명령줄에서 Cursor가 팀에 합류합니다. 다른 에이전트와 같은 메모리를 공유합니다. 채팅을 시작할 때 이 저장소의 짧은 요약을 받고, 프롬프트마다 아직 보지 못한 기억을 최대 세 개 함께 받으며, 모든 프롬프트와 답변이 기억됩니다. Cursor는 같은 스킬을 읽고, 다른 에이전트를 리뷰하거나 리뷰받을 수 있으며, 다른 에이전트의 사용량이 다 떨어지면 이어받고, 그 채팅도 다른 에이전트처럼 매일 밤의 학습에 들어갑니다. 먼저 `cursor-agent login`을 한 번 실행하세요. `sno setup`이 Cursor를 스스로 찾고, 앱만 있으면 명령줄도 설치합니다.

Cursor가 아직 못 하는 것: 앱에서는 새 창의 첫 채팅이 요약을 첫 프롬프트와 함께 받습니다. `cursor-agent -p`에서는 프롬프트별 기억이 없습니다. Windows, Linux용 Cursor 앱, Cursor의 클라우드 에이전트는 지원하지 않습니다. 자세한 내용은 [Cursor 안내](../../apps/mem-cursor/README.md)를 보세요.

## 사용 방법

*마지막 업데이트: 2026-09-19.* 설치 후에도 여러분은 원하는 에이전트에서 이전과 똑같이 작업을 계속합니다. 달라지는 것은 세 가지입니다:

1. **그중 하나가 한도에 도달합니다.** 다른 에이전트에서 `sno reach call`이라고 말하세요. 공유 메모리와 메일박스에서 작업을 그대로 이어받습니다, 컨텍스트도 그대로요.
2. **다른 시각의 검토가 필요할 때.** 어느 쪽 에이전트에게든 상대방의 작업을 `peer-review`해 달라고 요청하세요. 검토자는 항상 다른 하네스 소속입니다.
3. **매일 밤 RSI 루프가 실행됩니다.** 아침에 마음에 드는 제안에 대해 `sno rem-reflect accept <id>`를 실행하세요. 승인 없이는 아무것도 바뀌지 않습니다.

## "어젯밤 나는 에이전트에게 화를 냈다. 에이전트는 그걸 메모해뒀다."

*우리 자신의 컴퓨터에서 실제로 이런 모습입니다. 사흘, 세 개의 보고서. 마지막 업데이트: 2026-09-19.*

**첫째 날 — 배운다.**

![무엇을 배우고 무엇을 바꿨는지 보고하는 야간 루프, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

이것은 우리가 이 저장소에서 실행하는 RSI 루프에서 나온 실제 보고서입니다. 하루에 한 번 그것은 우리 자신의 에이전트 세션을 읽고, 반복되는 실수를 찾아내고, 에이전트 자신의 스킬 파일에 대한 변경을 제안합니다. 사람이 그 제안을 읽고 승인하거나 거부합니다. 그 승인 없이는 아무것도 바뀌지 않습니다. 그날 저녁 오너가 답답해했던 두 가지는 다음 날 아침이 되자 실제로 작동 중인 스킬의 규칙이 되어 있었습니다. 아무도 직접 입력하지 않았습니다.

**둘째 날 — 스스로 숙제를 확인한다.**

![다음 날 아침: RSI 루프가 전날의 변경이 도움이 되었는지 측정한다, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

다음 실행은 새벽 00:58에 스스로 시작되어, 113개의 세션을 읽고 전날 바꾼 세 개의 스킬을 측정했습니다. 세 스킬 모두에서 실패율이 0으로 떨어졌습니다. 그것은 또한 zsh가 bash로부터 숨기고 있던 우리 릴리스 스크립트의 실제 버그도 찾아냈습니다. 아무도 찾아보라고 시키지 않았습니다.

**셋째 날 — 여러분이 설치한다.** RSI 루프는 이 저장소의 스킬이며, `sno setup`이 나머지와 함께 설치합니다. 이 섹션은 루프가 실행될 때마다 업데이트됩니다: 매주 새로운 보고서가 추가되며, 아무것도 손대지 않습니다.

이는 우리가 계속 돌아오게 되는 두 가지 작업에서 영감을 받았습니다: 세션마다 다시 도출하는 대신 에이전트가 배운 것을 지속적이고 편집 가능한 위키로 유지해야 한다는 아이디어를 담은 Andrej Karpathy의 *"LLM Wiki"*, 그리고 에이전트 자신의 경험을 지속적인 지식으로 컴파일하여 스킬을 다시 작성하는 Google Research와 Virginia Tech의 *"WikiSkill"*입니다. 링크는 [참고 자료](#references)에 있습니다.

## "몇 달 동안, 다른 쪽은 단 한 번도 '좋아 보이네요'라고 말한 적이 없다."

우리는 몇 달 동안 이 저장소에서 Claude Code가 Codex의 작업을 검토하고 Codex가 Claude Code의 작업을 검토하게 해왔습니다. 빈손으로 돌아온 리뷰는 단 하나도 없었습니다. 단 하나도요. 우리는 예전에 그것이 작업이 나쁘다는 뜻이라고 생각했습니다. 사실은 한 하네스의 리뷰어 하나만으로는 결코 충분하지 않다는 뜻입니다.

Dual Brain은 두 에이전트가 하나의 과제에서 서로 다른 역할을 맡는 방식입니다. 한쪽은 구현하고, 다른 쪽은 요구사항에 맞춰 검토합니다. 어느 쪽이든 구현과 검토를 맡을 수 있으며, 과제에 맞춰 역할을 바꿉니다. 역할을 더하면 Agent Squad가 됩니다.

## "나는 잠자리에 들었다. 에이전트는 교대를 했다."

*우리 자신의 컴퓨터에서 실제로 이런 모습입니다, 2026-09-18.*

![5분마다 임계값을 향해 내려가는 사용량 감시 기록, 그리고 2%에서 발동한 인수인계](../evidence/rotation-quota-watch-2026-09-18.png)

우리 에이전트 중 하나가 27개 작업으로 이루어진 빌드에서 21개째 작업을 진행하던 중 주간 사용량이 2%에
도달했습니다. 에이전트는 거기서 멈춰 서서 죽기를 기다리지 않았습니다. 인수인계 브리프를 작성했습니다:
무엇이 끝났는지, 무엇이 절반만 끝났는지, 이어서 작업할 정확한 커밋이 무엇인지. 그런 다음 다른 하네스의
에이전트를 깨웠고, 그 에이전트가 브리프의 크기와 체크섬을 측정하고 그렇게 했다고 말하기 전까지는
아무것도 건드리지 못하게 했습니다.

한 가지가 잘못되었는데, 그것이 바로 읽어볼 가치가 있는 부분입니다. 인수자가 인계 승인을 확인하기도
전에 편집을 시작했습니다. 인계자가 그것을 잡아내어 멈추게 하고, 브리프를 다시 쓰고, 제대로 다시
인계했습니다. 인수인계가 시작된 지 14분 41초 후, 두 번째 에이전트는 작업 중이었고 첫 번째 에이전트는
1%를 남긴 채 물러났습니다. 인수인계 이전의 모든 커밋은 온전히 남아 있습니다; 두 번째 에이전트는
처음부터가 아니라 첫 번째 미완료 작업부터 이어갔습니다. 그동안 나는 내내 자고 있었습니다.

그날 밤 전체는 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)에 있습니다:
5분 간격의 모든 사용량 기록, 브리프의 두 버전, 준비 완료와 인계 영수증, 그리고 커밋 요약까지.
호스트 이름, 주소, 세션 ID는 가려져 있으며, 그 밖에는 아무것도 손대지 않았습니다.

## 오늘 작동하는 것

*마지막 업데이트: 2026-10-10.*

| 구성 요소 | 상태 |
|---|---|
| `packages/chunking` | 이 저장소에 있으며, 테스트를 거쳤고, npm에 게시됨 |
| 공유 패키지 (`common-core`, `utils`, `embedder`, `observability`, `sqlite-crypto`, `content-sanitizer`) | 이 저장소에 있음 |
| Claude Code, Codex, OpenClaw 간 공유 메모리 | 엔진과 세 가지 스킨 모두 이 저장소에 있음; 클린 머신 검증 대기 중 |
| Cursor: 공유 메모리, 스킬, 상호 리뷰, 이어받기, 매일 밤의 학습 | 1.3의 새 기능. `cursor-agent` 명령줄은 깨끗한 Linux 머신에서 처음부터 끝까지 검증됨. macOS의 Cursor 앱은 검증 중 |
| Sno Reach — 데몬 없이 에이전트끼리 대화하기 | `sno setup`으로 설치; Linux와 macOS용 릴리스 아카이브 공개됨; 깨끗한 Linux 머신에서 처음부터 끝까지 검증됨 |
| 야간 루프와 팀 스킬 | `sno setup`으로 설치; 야간 작업이 깨끗한 Linux 머신에서 실행됨 |
| 원커맨드 설치 (`sno setup`) | 위의 모든 것을 설치; 깨끗한 Linux 머신에서 검증됨 |
| 에이전트 안에서 "Sno onboard" 말하기 | 사용 가능; 설치 직후 시작되며, 말해도 시작됩니다 |

행은 깨끗한 컴퓨터에서 실행된 경우에만 "검증됨"이라고 표시됩니다.

## 일부러 잊어버리는 메모리

*마지막 업데이트: 2026-10-09.*

메모리는 이 제품의 헤드라인이 아니라 바닥입니다. 하지만 대부분의 에이전트 메모리가 실패하는 곳이 바로 그 바닥이며, 실패는 두 가지 조용한 방식으로 일어납니다: 남아 있어야 할 것을 잊어버리거나, 사라졌어야 할 것을 계속 간직하는 것입니다. 두 번째 실패가 더 값비쌉니다. 여러분이 취소한 선호, 바뀐 마감일, 떠난 주소를 여전히 "기억하는" 에이전트는 그것을 완전한 확신을 가지고 실행에 옮길 것입니다.

올해 전까지는 아무도 그것을 측정하지 않았습니다. 사람들이 자주 인용하는 장기 메모리 벤치마크(LoCoMo, LongMemEval)는 회상만을 점수화합니다: 올바른 사실이 돌아왔는가. 아무것도 잊지 않는 시스템은 이 벤치마크에서 만점을 받습니다. 2026년 4월 애리조나 주립대학의 한 연구팀이 **Memora**를 발표했습니다(Uddin, Shubham, Blanco, Baral, Wang, *From Recall to Forgetting: Benchmarking Long-Term Memory for Personalized Agents*, [arXiv 2604.20006](https://arxiv.org/abs/2604.20006), ACL 2026 Findings). 이는 두 번째 실패를 중심으로 설계된 최초의 벤치마크입니다. 각 질문은 두 종류의 검사를 포함합니다: 반드시 회상되어야 하는 사실, 그리고 대화 중에 취소되거나 대체되어 절대 다시 나타나서는 **안 되는** 사실입니다. 이 벤치마크의 대표 지표인 **FAMA**(Forgetting-Aware Memory Accuracy)는 회상 점수에서 에이전트가 여전히 의존하는 오래된 사실 하나하나에 대한 패널티를 뺀 값입니다. 테스트된 여섯 개 메모리 에이전트에 대한 논문 자체의 결론은 다음과 같습니다: "무효한 메모리를 자주 재사용하고, 진화하는 메모리를 조정하는 데 실패한다."

그것이 바로 Sno Station의 메모리가 통과하도록 설계된 시험이며, 메모리가 스스로 개선되는 이유이기도 합니다: 무엇을 남기고, 무엇을 퇴출시키고, 나중 사실이 이전 사실을 어떻게 대체하는지가 모두 모델 출시가 아니라 사용에 따라 바뀝니다.

모든 결과와 그 바탕이 된 답변, 판정, 트레이스는 [`evals/`](../../evals/)에 있습니다.

## 디자인 파트너

우리는 이미 두 개 이상의 에이전트를 나란히 실행하면서 그 사이에서 결과를 수동으로 옮기고 있는 소수의 사람들과 함께 작업하고 있습니다. 여러분이 그런 경우라면, [디자인 파트너 이슈](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)를 열어 무엇을 실행하고 있는지 알려주세요.

## 보안

[SECURITY.md](../../SECURITY.md)를 참고하세요.

## 라이선스

Apache-2.0. 처음부터 끝까지 오픈소스입니다. [LICENSE](../../LICENSE)를 참고하세요.

## References

Work this repository builds on, with thanks.

- Andrej Karpathy. *LLM Wiki.* Gist, April 2026.
  https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Liyan Tang, Cyrus Rashtchian, Chun-Sung Ferng, Andrew Tomkins, Da-Cheng Juan, Tu Vu
  (Google Research, Virginia Tech). *WikiSkill: Compiling Agent Experience into Persistent
  Knowledge for Skill Evolution.* arXiv:2608.27454, August 2026.
  https://arxiv.org/abs/2608.27454
- Qizheng Zhang, Changran Hu, Shubhangi Upasani, Boyuan Ma, Fenglu Hong, Vamsidhar Kamanuru,
  Jay Rainton, et al. (Stanford University, SambaNova). *Agentic Context Engineering: Evolving
  Contexts for Self-Improving Language Models.* arXiv:2510.04618, October 2025. Its curator
  and helpful/harmful bookkeeping were studied while designing our loop.
  https://arxiv.org/abs/2510.04618
- Md Nayem Uddin, Kumar Shubham, Eduardo Blanco, Chitta Baral, Gengyu Wang (Arizona State
  University). *From Recall to Forgetting: Benchmarking Long-Term Memory for Personalized
  Agents* (the Memora benchmark). arXiv:2604.20006, April 2026, ACL 2026 Findings.
  https://arxiv.org/abs/2604.20006
