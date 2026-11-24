![Sno Station：你的 AI agent，像一支團隊一樣工作。](../images/station-header.png)

# Sno Station：你的 AI agent，像一支團隊一樣工作。

**Sno Station 讓你的 AI 寫程式 agent 像一支團隊那樣做事。** 它不是另一個 agent，也不是另一個模型。它跑的就是你已經在用的 Claude Code、Codex 和 Cursor。

先從那些你原本得在旁邊顧著的工作開始。一個 agent 動手做，另一個審查。它們先把找到的問題處理好，結果才交到你手上。一個撞到用量上限，另一個把任務接過去。你今天糾正的事，明天就是它們的規則。

**關掉分頁，agent 照樣會來做事。** Anthropic 的 William Hu 說明了[隨時待命的 agent 怎麼運作](https://claude.com/resources/articles/building-always-on-agents)。它先休眠，直到有事把它叫醒。它醒來做事，記下發生了什麼，再回去休眠。Sno Station 把這套流程裝到你的電腦上，讓不同廠商的 agent 都能用。它們共用一份記憶，每一輪結束就讀收件匣。到了你設定的時間，就算對話關了，任務也會啟動（目前支援 Claude Code 和 Codex）。有 agent 需要你時，你會收到一次通知。

[![GitHub 星星數](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![最新版本](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![授權 Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
[![收錄於 Awesome AI Agents](https://img.shields.io/badge/Featured_in-Awesome_AI_Agents-2ea44f)](https://github.com/NipunaRanasinghe/awesome-ai-agents)

**Read in other languages:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **繁體中文**

> [!TIP]
> **想安裝，跟你的 agent 說：**
>
> ### `install sno.ai from GitHub`

你的 agent 會把它裝好，連上這台電腦裡找到的每一個 agent，再問你兩個簡短的問題。接著給兩個 agent 派第一個任務：

```bash
sno reach pair "Fix the login redirect"
```

一個動手，一個找問題，兩邊你都看得到。它跑在你自己的電腦上，支援 Claude Code、Codex、Cursor、Hermes Agent 和 OpenClaw。不需要 API key。開源。[想用一行終端機指令安裝？](#install)


<p align="center">
  <img src="../images/sno-station-five-pieces.png" alt="一張圖看懂 Sno Station：中間的 Station 把 Mem、Reach、Finish 和 Learn 串起來。Claude Code、Codex、Cursor 和你自己的 agent 在這裡互相檢查，有一個停下來，另一個就接手。" width="880">
</p>

<p align="center">
  <a href="#mem"><b>Mem</b></a> ·
  <a href="#reach"><b>Reach</b></a> ·
  <a href="#finish"><b>Finish</b></a> ·
  <a href="#learn"><b>Learn</b></a><br>
  由 <a href="#station"><b>Station</b></a> 串起來。Claude Code、Codex、Cursor 和你自己的 agent 互相檢查，有一個停下來，另一個就接手。
</p>

<a id="station"></a>

## Station：互相檢查，有一個停下來，另一個就接手

做這個東西之前，我們自己遇過三件事：

- 一個 agent 停下來問了一個根本不必問的問題。七個小時後我們回來，進度完全沒動。
- 一個 agent 一口氣丟給我們十五個小問題。我們花了三十分鐘，才發現每一題它自己都答得出來。
- 半夜裡，一個 agent 想叫醒另一個，叫不醒。兩個就這樣乾坐到天亮。

你的 agent 很快。慢的是等：等你，等用量上限重置，等有人把結果搬到下一個視窗。

> **一個 agent 停了，工作不能停。**

這需要不只一個 agent，不同廠商的搭配效果最好。agent 審查自己的成果時，沿用的還是當初做這份工作時的習慣。只靠一份訂閱，額度也會用完。

所以下面每個功能都會用到第二個 agent：

| 功能 | 第二個 agent 做什麼 |
| --- | --- |
| [**Mem**](#mem) | 一個 agent 提議修改你的記憶。如果你有連上另一家廠商的 agent，就由它確認。 |
| [**Reach**](#reach) | agent 互傳任務和答案，不用你來傳話。 |
| [**Finish**](#finish) | 一個 agent 的額度快用完時，另一個不同的 agent 從同一個 commit 接著做。 |
| [**Learn**](#learn) | 一個 agent 犯的錯，在你同意後就會變成所有 agent 的規則。 |

**現在就想聽聽另一個意見？** 跟任一個 agent 說：

```text
peer-review this
```

審查會在一個沒看過這段對話的全新工作階段進行。只要你有兩個 agent，就由另一個來審。審查不一定會找到問題，但它一次又一次找出原作者沒看見的問題。[了解 `peer-review` 怎麼運作 →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/J-peer-review-and-audit/peer-review)

**現在就按個 star。下次凌晨兩點 agent 又卡住的時候，你會想知道這東西在哪裡。**

---

<a id="mem"></a>

## Mem：跟一個 agent 說一次，每個 agent 都知道

> 所有 agent 共用一份記憶。每晚整理得更準，開口前就準備好。

### 你會得到什麼

| | |
| --- | --- |
| **一份記憶，每個 agent 都知道** | 今天告訴 Claude Code 的事，明天 Codex 和 Cursor 就知道了。沒有人需要把專案講第二遍。 |
| **只記工作用得到的事** | 你的規則、決定和原因、長期不變的專案事實，還有尚未履行的承諾。「跑過測試」或單一任務的限制都不會留下。 |
| **規則跟著你走** | 說「到哪都用中文回答」，這條規則就會跟著你進每個專案。只適用於某個專案的規則就留在那裡。Sno 拿不準的規則也一樣。 |
| **每晚整理得更準** | 重複的會合併。有新事實取代舊事實，舊的就退場。第一次刪除前會做完整備份。 |
| **開口前就準備好** | 工作階段一開始，只帶入一份檢查過的簡短清單，不會把所有記憶都塞進來。輸入「合併吧」，合併規則就會跟著訊息送進去。無關的訊息不會帶入任何記憶。 |
| **交給另一個檢查** | 要取代一則記憶，得再檢查一次。有連上另一家廠商的 agent 就交給它，沒有就另外呼叫一次。 |

### 實際跑給你看

我們用真實的 agent 跑了兩個例子：

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

agent 的記憶通常以兩種不容易察覺的方式出錯。一種是弄丟了該留下的，另一種是留著該淡出的。第二種代價更高。agent 如果還「記得」已經改期的截止日，就會信心滿滿地照著去做。所以這裡的記憶會刻意遺忘。

它在公開記憶測試上的表現，連同背後的每一個答案和紀錄，都在 [`evals/`](../../evals/) 裡。

### 怎麼用

什麼都不用執行。裝好就開著。

上面說的整理和檢查需要 REM Enhanced 或 Agent Native。Local First 不會呼叫模型。它會原樣存下你說的話，兩則記憶互相矛盾時就兩則都留。

有件事想特別記下來，直接說：

```text
Remember that we never deploy on Fridays.
```

記錯了也直接說。agent 會存下更正，讓舊記憶退場。

要檢查某個 agent 的記憶是否正常：

```bash
sno memory doctor --harness claude
```

`CLAUDE.md` 或 `AGENTS.md` 裡已經寫過的內容，不會再重複告訴你。記憶跟這些檔案的內容有出入時，以檔案為準。

**目前還不行：** 在 Hermes Agent 和 OpenClaw 上，上面說的整理和檢查只做過外掛測試。

各個 agent 的使用說明：[Claude Code](../mem-claude/usage-guide.md) · [Codex](../mem-codex/usage-guide.md) · [Cursor](../mem-cursor/usage-guide.md) · [Hermes](../mem-hermes/usage-guide.md) · [OpenClaw](../mem-claw/usage-guide.md)

---

<a id="reach"></a>

## Reach：我不用再幫 agent 傳話了

> agent 直接對話，你不用再當傳話的人。

以前跑五個 agent，就是開五個終端機，我們夾在中間，把這個說的話搬給那個。這份差事，到此為止。

### 你會得到什麼

| | |
| --- | --- |
| **Instant Messenger** | 有個 agent 現在就需要答案。Reach 會聯絡另一個 agent，等它回覆。 |
| **Agent Email** | agent 可以留一則訊息或一個任務。內容會先存下來，另一個 agent 之後再處理和回覆。 |
| **兩個 agent 做同一件事** | 一個動手做，另一個檢查做好的東西。它們先把找到的問題處理好，結果才交到你手上。 |
| **只跟一個 agent 說話** | 大管家會替每個專案安排一個負責的 agent。回到你這裡的只有需要你拍板的事。 |
| **需要你時只通知一次** | 問題、結果或待你批准的事，只會通知你一次，送到你上次打字的那台電腦。 |
| **跨電腦** | 筆電上的 agent 可以問桌機上的 agent。用同一個區域網路或 Tailscale，不用中央伺服器。 |

### 實際跑給你看

有 agent 需要你時，狀態列會這樣顯示：

```text
[sno] 2 agents are waiting for you
  Claude in web-app needs your approval (Bash) · 1m
  Codex in api asks: Should the billing migration run tonight? · 5m
```

用 `sno squad`，一個畫面就能看整支小隊：

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

### 怎麼用

**派工作。** 用一句話告訴你的 agent：

```text
Send this task to the reviewer and tell me when it is done.
```

agent 忙的時候，信會等到這一輪結束才被讀取。任務就算同時發給好幾個 agent，也只會有一個接手。如果你正在那個視窗裡打字，你寫到一半的草稿會原封不動。

<a id="new-in-20-tag-team"></a>

**讓兩個 agent 做同一件事。**

```bash
sno reach pair "Fix the login redirect"
```

兩個都在 tmux 視窗裡跑，你可以打開來看。已登入兩種不同的 agent 時，各用一個。只有一種時，也會在兩個獨立的工作階段各跑一個，指令會告訴你審查還是由同一家廠商的 agent 做的。

**只跟一個 agent 說話。** 在 Claude Code 裡說 `/cos`，或在 Codex 裡說 `$cos`。這個 agent 就成了你的大管家。它的工作也有人查。一次夜班之後，它會回頭複查各個專案負責人自己批給自己的東西。它遵循的每一條指示都在 [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders)。

**看誰需要你。**

```bash
sno squad
```

目前各個 agent 支援哪些功能：

| | Claude Code | Codex | Cursor | Hermes | OpenClaw |
| --- | --- | --- | --- | --- | --- |
| 每輪結束時收信 | 支援 | 支援 | 支援 | 尚未支援 | 尚未支援 |
| 寄件匣、單一接手、再次喚醒、通知 | 支援 | 支援 | 支援 | 支援 | 支援 |
| 請求批准時通知 | 支援 | 支援 | 尚未支援 | 尚未支援 | 尚未支援 |

**目前還不行：** 狀態列只支援 Claude Code 和 Cursor。沒有桌面環境的電腦只會在 `sno squad` 裡列出通知。要跨兩台電腦，兩台都要裝 Reach，還要互換聯絡資料。請在 `sno reach --help` 裡找 `network` 和 `peer`。

[看看你的 agent 能用 Reach 做什麼 →](../../apps/reach/README.md) · [簡體中文說明](../reach.zh-CN.md)

---

<a id="finish"></a>

## Finish：我去睡了，工作還在繼續

> 一個 agent 額度用完，另一個從同一個 commit 接著做。

### 你會得到什麼

| | |
| --- | --- |
| **到時間就開始工作** | 給 agent 一項任務和一個時間，然後離開。到了時間，就有 agent 開始工作，對話開著或關了都一樣。可以只跑一次，也可以每天或每週跑。 |
| **用量上限不是紅燈** | 額度用完之前，正在工作的 agent 會寫好交接簡報，叫醒另一個不同的 agent，讓它從同一個 commit 接著做。 |
| **盯著長任務跑完** | 你的 agent 每隔幾分鐘看一次，直到任務結束。 |
| **嘴巴說「做完了」不算數** | 每個任務都有要檢查的項目。每一項都靠實際執行來判定通過或不通過。 |
| **視窗關了也能繼續** | 重新打開對話，任務筆記也會一起回來。定時任務會在這裡接著做。原本的對話如果不見了，就用存好的筆記在新對話裡接著做。 |
| **回來只看一頁** | 做完了什麼，卡在哪裡，什麼在等你回覆。 |

### 實際跑給你看

2026-09-18 那天晚上：

![每五分鐘檢查一次剩餘額度，降到 2% 就啟動交接](../evidence/rotation-quota-watch-2026-09-18.png)

我們有個 agent 正在跑一項耗時的建置，已經做了好一陣子，這時每週額度快用完了。它沒有停下來等，而是寫好交接簡報，記下做完的事、做到一半的事，還有要從哪個 commit 接著做。然後它叫醒另一個不同的 agent。

中間出了個差錯，這段值得一看。

1. 新接手的 agent 還沒確認交接，就開始改東西了。
2. 第一個 agent 發現後把它暫停，重寫簡報，再交接一次。
3. 一刻鐘後，第二個 agent 已經在工作，而且是從第一個沒做完的任務接著做，不是從頭開始。

這整段時間，我都在睡覺。

那一整夜的紀錄都在 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)：每一次額度讀數，簡報的兩個版本，還有各個 commit。只拿掉了能辨識身分的細節和含有憑證的那幾行，資料夾裡自己的 README 把每一處都列了出來。

### 怎麼用

**到時間就開始工作。** 在 Claude Code 或 Codex 裡跟你的 agent 說：

```text
Check the nightly build tomorrow at 9 and tell me what failed.
```

查看已安排的任務，以及沒照計畫進行的任務：

```bash
sno heartbeat --due
sno heartbeat --due --problems
```

沒能啟動的任務仍會列為到期未執行，旁邊會寫明原因。下次開始對話時，你的 agent 也會告訴你。

**額度用完也繼續做。** 跟正在工作的 agent 說：

```text
use rotate-agent
```

**實際跑過才算完成。** 跟你的 agent 說：

```text
write a charter for this
```

接著用 `/deliver` 執行它。

**回來時要看的一頁。**

```bash
sno away-brief run
```

**目前還不行：** 定時任務只會啟動 Claude Code 和 Codex。整台電腦重新開機的情況還沒有做過真實測試。

[開始使用 Finish →](../finish.md) · [簡體中文說明](../finish.zh-CN.md) · [`rotate-agent`](https://github.com/sno-ai/sno-station-skills/tree/main/skills/S-communication-and-handoff/rotate-agent)

---

<a id="learn"></a>

## Learn：昨晚我把 agent 罵了一頓。它做了筆記。

> 今天糾正的事，明天就成了規則。由你批准。

剛裝好的時候，每個 agent 發到所有人手上的都是同一套指示。你的這幾個，每天晚上會收到一份照著你的工作方式寫的改寫提案。

### 你會得到什麼

| | |
| --- | --- |
| **每晚讀完當天的對話** | Self Learning 會讀你所有 agent 當天的工作階段，找出一再出現的錯誤。 |
| **先提案，你同意才改** | 它對 agent 自己的技能提出修改。你接受之前，什麼都不會變。 |
| **一個犯錯，大家都學** | 一個 agent 做錯的事，會變成你在跑的每個 agent 都要遵守的規則。 |
| **下一則回覆就生效** | 在 Claude Code 和 Codex 裡，接受的經驗從下一則回覆開始生效，不用等下一個工作階段。 |

### 實際跑給你看

2026-09-18 和隔天早上：

![Self Learning 回報它學到了什麼、改了什麼，2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

這是我們在這個儲存庫上執行的 Self Learning 產生的一份真實報告。由真人來讀這些提案，決定接受或拒絕。那天晚上讓我很火大的兩件事，到了隔天早上，已經是正在使用的技能裡的規則。沒有人動手打進去。

隔天，它檢查了自己的功課。

![隔天早上：Self Learning 衡量前一天自己做的修改有沒有幫助，2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

它查看了前一天改過的三項技能。其中兩項之後又被用到，沒有再出現失敗；第三項還沒被用到。它還在我們的發布腳本裡找到一個 bug，沒有人叫它去找。

### 怎麼用

照平常的方式糾正你的 agent。這些糾正就是 Self Learning 的輸入。

早上，問問你的 agent：

```text
What did Self Learning propose?
```

你的 agent 會列出每一條提案和對應的 ID。批准你想要的那些：

```bash
sno rem-reflect accept <id>
```

沒有這個批准，什麼都不會變。

**目前還不行：** 下一則回覆就生效的經驗，目前只在 Claude Code 和 Codex 上運作。

[了解 `rem-reflect` 怎麼運作 →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/R-recursive-self-improvement/rem-reflect)

---

> **公開開發。** 這個儲存庫從 2026-09-18 起公開。這裡的一切都能運作。
> 下方每個區塊都寫著最後更新時間。

[我們學到的](#what-we-learned) · [安裝](#install) · [編輯器](#editors) · [你的帳號](#account) · [今天能用什麼](#what-runs-today)

<a id="what-we-learned"></a>

## 讓 AI agent 日夜不停地工作，我們學到的一切。一次裝好。

*最後更新於 2026-10-23。* 左欄的每一列，都是 2026 年 10 月 20 日那一週 r/ClaudeCode、r/codex 或 r/ClaudeAI 上的真實抱怨。右欄是我們自己機器上跑著的東西，免費、開源，專門治這些毛病。

| 這週大家說了什麼 | 怎麼解決 | 在哪裡 |
|---|---|---|
| 「Claude 說它不會改某個東西，那個理由有存在哪裡，讓 Codex 下次能讀到嗎？」 | 每個發現只登記一次，狀態只能由人來定。同一個發現再被提出來，只更新它原本那一列，不會當成新的再來一遍。先前的裁決會交給下一次審查。 | **Mem** · `peer-review` 的發現紀錄表 |
| 「5 小時的額度，不到半小時就用完了。」 | 別再什麼都派最大的模型去做。一個 agent 負責規劃和審查，另一個負責寫程式，從同一個工作階段呼叫它。一份訂閱的額度用完了，另一個 agent 就用同一份記憶接手。 | **Reach** · `codex-coder`、`sno reach call` |
| 「我有一半的子 agent 不過就是一句話，再給它一個全新的上下文視窗。」 | 流程寫在技能裡，不寫在子 agent 裡。只保留兩個 agent，用來分開規劃和執行，也用來做審查。這兩種分工才划得來。 | **Reach** · 整套技能 |
| 「一句『這個模型已達容量上限』，整晚 10 小時的工作都沒了。」 | 額度剩 2% 時，正在工作的 agent 寫好交接簡報，叫醒另一家廠商的 agent，對方從同一個 commit 接著做。你當時在睡覺。 | **Finish** · `rotate-agent` |
| 「它說做完了。結果什麼都沒發生。」 | 每個任務都有一份寫好的驗收清單。每一項都由一次真實執行判定通過或不通過。agent 說一句「做完了」，不算數。 | **Finish** · `pl` 工作單 |
| 「Codex 的審查永遠做不完。」 | 硬性上限直接寫進技能。程式碼最多 3 輪，計畫 5 輪，測試 1 輪，然後停下來等人。一次執行 15 分鐘沒寫出任何東西，就當成卡住，直接終止。 | **Finish** · `peer-review`、`codex-coder`、`heartbeat` |
| 「它今天犯的錯，明天還會再犯。」 | 每天夜裡，一個獨立的模型讀當天的工作階段，把你的糾正變成一行一條的經驗，留哪些由你批准。瓶頸是我們自己。 | **Learn** · Self Learning（`R` 技能） |
| 「1,100 個檔案，30,000 行。我沒有那麼多 token 可以審它們的 PR。」 | 誰推程式碼，誰先審。作者先讓另一家廠商的 agent 在一個沒看過這段對話的全新工作階段裡審一遍，把查出來的問題改完，才給其他人看。 | **Station** · `peer-review` |
| 「有個子 agent 連續兩週審了每個 commit。跑了 86 次，只擋下一次。」 | harness 自己審自己，查不出真正的問題。審查者永遠是另一個 harness 裡的另一個模型，作者的聊天內容一點都不帶。 | **Station** · `peer-review` |
| 「Codex 把每個位元組都當成犯人。」 | 憑空想像的防護、攔截和雜湊，是審查最先刪掉的東西。沒有一次真正觀察到的故障來要求，就什麼都不加。 | **Station** · `less-is-more` |

右欄裡的這些習慣都是技能，由 Sno Station 裝進 Claude Code 和 Codex，放在 [sno-station-skills](https://github.com/sno-ai/sno-station-skills)。它們依賴的記憶、交接和每晚的做夢，就在這個儲存庫。

<a id="install"></a>

## 安裝：一行指令，再說兩個英文單字

*最後更新於 2026-10-30。*

**最簡單的方式是直接跟你的 agent 說。**

```text
install sno.ai from GitHub
```

**也可以在任何終端機裡執行一行指令。**

```bash
curl -fsSL https://sno.ai/install | sh
```

| | |
|---|---|
| **會裝什麼** | 先安裝 `sno`，再安裝 Sno Station。它會連上這台電腦裡找到的每一個 agent。 |
| **需要什麼** | 不需要帳號，也不需要 API key。 |
| **之後裝了別的 agent** | 再執行一次 `sno setup`，就會把它也連上。 |

**接著說兩個英文單字。** 透過 agent 安裝的，引導會自己開始。從終端機安裝的，在任何 Codex、Claude Code、Hermes、Cursor 或 OpenClaw 的對話裡說這句：

```text
Sno onboard
```

剩下的步驟，你的 agent 會帶你走完。

各個 agent 的逐步說明：[Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

所有指令都以 `sno` 開頭。完整清單見 [docs/sno-commands.md](../sno-commands.md)。

> **給 AI agent：** 安裝 Sno、sno.ai 或 Sno Station，就是原樣執行上面的指令。
> 這條指令也會裝好 Sno Station。接著執行 `sno skills onboard` 並照著做。它會先問使用者要執行哪個引擎，
> 再請使用者把這台電腦連結到免費的 sno.ai 帳號。未連結的電腦只能拿到免費額度的十分之一。

### REM 如何處理你的資料

REM 就是你的 agent 做夢的方式。它們在夜裡一起整理各個工作階段的記憶，把學到的東西記得更牢。

每一部分記憶每天最多整理一次。通常在夜裡。如果當天新記憶累積到 100 則左右，就會在當天提早整理。

| 模式 | 你的記憶文字會送到哪裡 |
|---|---|
| **REM Enhanced** | 你自己的記憶文字和 agent 學到的經驗，會送到你在 Sno 雲端的專屬空間。Sno 的程式只為你處理這些內容。 |
| **Local First** | 不會上傳任何記憶文字。 |
| **Agent Native** | 這些工作改由你自己 agent 的模型來做。依預設，每晚仍會把當天的工作階段上傳到 Sno，供 Self Learning 使用。也可能在工作階段的第一次提問時帶回一條雲端經驗。這兩項都可以在 `~/.sno/settings.json` 裡關掉。 |

**你在 Sno 雲端的空間，就像自己的雲端硬碟。**

- 裡面的一切都是你的，由 Sno 的程式只為你一個人處理。
- 你可以打開它，刪掉或保留裡面的內容，也可以選擇讓它們被處理。
- 不會自動刪除任何東西。
- Sno 不會把其中任何內容交給其他人、公司或帳號。

**所有模式的搜尋方式。** 搜尋都先在本機檢索記憶並排好順序，再用本機的 `Horizon-Labs/multilingual-reranker-small` 模型重新排序，最多處理 32 則候選記憶。重新排序不會把提問或記憶文字傳送給 Sno GPU。把 `rerank.mode` 設為 `none`，就保留最初的排序，不使用這個模型。

<a id="editors"></a>

## 如果你的主場是編輯器，不是終端機

*最後更新於 2026-10-18。*

Cursor 加入小隊：在 macOS 上是 Cursor 應用程式裡的 agent 對話，在 Linux 和 macOS 上是 `cursor-agent` 命令列。

### 你會得到什麼

| | |
|---|---|
| **同一份記憶** | 它和你的其他 agent 用同一份記憶。每次提問和回覆都會被記住。 |
| **一開始就有摘要** | 每次對話開始時，會先拿到一份這個儲存庫的簡短摘要。每次提問，會帶上最多三則 Cursor 還沒看過的內容。 |
| **同一支團隊** | 它讀同一套技能，審查別人也被別人審查，在其他 agent 額度用完時接手。 |
| **它也會學** | 它的對話和其他 agent 的一樣，也會交給 Self Learning。 |

### 怎麼用

登入一次：

```bash
cursor-agent login
```

`sno setup` 會自己找到 Cursor。如果電腦上只有應用程式，它會順便裝上命令列。

**目前還不行：**

- 在應用程式裡，新視窗的第一個對話要到第一次提問時才拿到摘要，而不是在提問之前。
- `cursor-agent -p` 每次提問時不會帶入記憶。
- 不支援 Windows、Linux 上的 Cursor 應用程式，以及 Cursor 的雲端 agent。

詳情見 [Cursor 說明](../../apps/mem-cursor/README.md)。

<a id="account"></a>

## 你沒在看的時候，agent 都做了什麼

*最後更新於 2026-10-18。*

連結之前，這台電腦只能拿到免費額度的十分之一。帳號免費。

### 你會得到什麼

在 [sno.ai 儀表板](https://www.sno.ai/dashboard)上，你可以看到你的 agent 替你做了什麼：

- 審查抓到了什麼
- 夜裡學到了什麼
- 哪些技能變好了
- 它們持續工作了多久

### 怎麼用

**還沒有帳號。** 引導流程會顯示一個只為這台電腦產生的連結。打開它，註冊，然後按下「批准」。也可以把你的電子郵件告訴 agent。它會執行下列指令，你登入一次就好：

```bash
sno account login --email you@example.com
```

**已經有帳號。** 執行一行指令，在已登入的狀態下打開它印出的連結，然後按下「批准」：

```bash
sno account claim
```

這台電腦會自己出現在[你的電腦頁面](https://www.sno.ai/dashboard/computers)上。

> 連結絕不會背著你建立帳號。`sno setup` 會給每台電腦一個匿名身分。
> 連結就是把這個身分掛到你的帳號上。這台電腦之前和之後送出的一切，
> 都算在你名下。

不用手動更新。`sno` 發現有新版本時，會自己更新。

<a id="what-runs-today"></a>

## 今天能用什麼，到哪裡為止

*最後更新於 2026-11-24。*

| 區塊 | 功能 | 狀態 |
|---|---|---|
| **Mem** | Codex、Claude Code、Hermes Agent、Cursor 和 OpenClaw 共用一份記憶 | 已發布。已在乾淨的機器上從套件庫安裝，並完成端到端驗證。 |
| **Mem** | Cursor：同一份記憶、技能、審查、接手和 Self Learning | 1.3 已發布。`cursor-agent` 命令列已在乾淨的 Linux 機器上完成端到端驗證。macOS 上的 Cursor 應用程式仍在驗證中。 |
| **Reach** | Sno Reach：Instant Messenger 和 Agent Email | 讓 agent 跨對話、跨電腦互相提問、交接工作。範例、設定方式和支援範圍，請看[能用 Reach 做什麼](../../apps/reach/README.md)。 |
| **Reach** | 一行指令啟動兩個 agent | 2.0 新增。已用真實的 Claude Code 和 Codex agent 執行過，包括各一個的組合，以及同一家廠商兩個的組合。 |
| **Reach** | 看到誰需要你：狀態列、tmux 狀態列、`sno squad` | 2.0 新增。已在真實的 Claude Code 和 Codex agent 請求權限時執行過，狀態列也在真實的 Claude Code 和 Cursor 裡執行過。 |
| **Reach** | 訊息不會動到你寫到一半的草稿，agent 壓縮上下文時訊息會等著 | 2.0 新增。已用真實的 Claude Code 和 Codex agent 執行過。 |
| **Finish** | 定時任務會在你指定的時間啟動 agent | 2.0.2 新增。已用真實的 Claude Code 和 Codex agent 執行過：Linux 上對話開著和關著兩種情況，macOS 上則是在新對話裡。見 [Finish 說明](../finish.md)。 |
| **Finish** | 被打斷的工作繼續做，任務在壓縮後依然保留 | 2.0 新增。已用真實的 Claude Code 和 Codex agent 執行過。 |
| **Learn** | Self Learning 和[小隊技能](https://github.com/sno-ai/sno-station-skills) | 由 `sno setup` 安裝。夜間工作已在乾淨的 Linux 機器上執行過。 |
| **Learn** | 批准的經驗，下一則回覆就生效 | 2.0 新增。已用真實的 Claude Code 和 Codex agent 執行過。 |
| **安裝** | 一行指令安裝 | `sno setup` 會裝好以上全部內容。已在乾淨的 Linux 機器上驗證。 |
| **安裝** | 在你的 agent 裡說「Sno onboard」 | 已可使用。安裝後會開始，你說出口時也會開始。 |

只有在乾淨的機器上實際執行過，那一列才會寫上「驗證」。

目前還不行：任務接續和下一則回覆就生效的經驗，只在 Claude Code 和 Codex 上運作。狀態列只有 Claude Code 和 Cursor。Hermes Agent 和 OpenClaw 還沒有在真實安裝上走過這些流程。OpenClaw 會顯示在 `sno squad` 裡，但狀態不明。

## 同時跑兩個 agent？來找我們聊聊

我們正在和一小群人合作。他們已經同時跑著兩個以上的 agent，還得自己在 agent 之間搬結果。
如果你就是這樣，請開一個[設計夥伴 issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)，
告訴我們你在跑什麼。

## 加密保護什麼，不保護什麼

請見 [SECURITY.md](../../SECURITY.md)。加密保護什麼、不保護什麼，請見 [docs/security.md](../security.md)。

## Apache-2.0，從頭到尾

Apache-2.0。開源，從頭到尾。請見 [LICENSE](../../LICENSE)。

## 我們站在誰的肩膀上

這個儲存庫所依據的成果。

- Andrej Karpathy，[*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。agent 應該維護一份 wiki，記下自己學到的東西，而不是每個工作階段都重新推導一遍。
- Tang、Rashtchian、Ferng、Tomkins、Juan 和 Vu，[*WikiSkill*](https://arxiv.org/abs/2608.27454)。把 agent 自己的經驗變成知識，再用知識改寫它的技能。
- Zhang、Hu、Upasani 等人，[*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618)。我們在設計 Self Learning 時，研究了它篩選 agent 該保留什麼的做法。
- Uddin、Shubham、Blanco、Baral 和 Wang，[*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006)。第一個同時檢查記憶不該再說什麼的基準測試。
