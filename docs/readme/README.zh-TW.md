# Sno Station — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — 代理人集合。兩個腦袋勝過一個，天亮時更聰明。](../images/hero-banner.png)

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
  <br><sub>支援 Codex · Claude Code · Hermes Agent · Cursor · OpenClaw</sub>
</p>

**Read in other languages:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **繁體中文**

Sno Station 把你已經在用的代理人組成一支小隊。Codex、Claude Code、Cursor、Hermes Agent
和 OpenClaw 用同一份記憶，互相交接工作，你提出時還會彼此檢查。每天夜裡，
它們會回頭檢視這一天，然後變得更好一點。

它在你自己的電腦上運作。安裝一次，之後照你原本的方式工作就好。更多介紹請見官網 [sno.ai](https://sno.ai)。

**一個用完額度，下一個接手。** 做到一半碰到速率限制，另一個代理人會從同一份記憶接手，
上下文完整保留。你不必貼上任何東西。

**需要時，就有人再看一遍。** 任何一個代理人都可以審查另一個的工作。 審查者一定是另一個代理人，所以不會習慣性地
附和第一個。

**你的代理人會做夢。** 每天夜裡你睡覺的時候，你的代理人會進入 REM。這個名字取自 Rapid Eye Movement（快速動眼期），也就是人睡眠中大腦加強記憶、把白天學到的東西固定下來的那個階段。REM 加強記憶：跨你所有的對話一起整理，讓它們記住重要的，放下已經不再成立的。自我學習則把經驗留下來：讀當天的對話，找出反覆出現的錯誤，對代理人自己的技能提出修改建議，讓昨天的失誤變成今天更好的習慣。建議你早上看，你說同意之前什麼都不會變。

**一切都屬於你。** 記憶、訊息與技能都存放在你的電腦上。記憶以一把不會離開這台電腦的
金鑰加密。不需要帳號、伺服器或 daemon。雲端功能是選配，沒有它，產品依然完整。

**REM 如何處理你的資料。** REM 是夜裡把你所有對話中的記憶統一整理的那一步。每一部分記憶每天最多整理一次：通常在夜裡；如果當天新記憶累積到 100 條左右，白天就會提前整理。在 REM Enhanced 模式下，你自己的記憶文字，以及各個代理人學到的經驗，會送到 Sno 雲端屬於你自己的空間，由 Sno 的程式只為你一個人處理。這個空間就像你自己的雲端硬碟：裡面的一切都是你的，由 Sno 的程式只為你一個人處理。你可以進去刪除、可以留著，也可以選擇讓它被處理。不會自動刪除，Sno 也不會把其中任何內容交給任何其他人、公司或帳號。Local First 模式下不會上傳任何記憶文字；Agent Native 模式下，這些工作改由你自己代理人的模型來做。不過按預設設定，Agent Native 每晚仍會把當天的對話上傳到 Sno，用於自我學習，並可能在對話的第一句話時取回一條雲端經驗；這兩項都可以在 `~/.sno/settings.json` 裡關掉。所有模式下，搜尋都先由本機程式檢索並初排，再由本機 `Horizon-Labs/multilingual-reranker-small` 模型重排最多 32 則候選記憶。重排不會把提問或記憶文字傳送給 Sno GPU。把 `rerank.mode` 設為 `none`，即可保留程式初排、不使用重排模型。

![運作方式：兩個代理人、一個工作區、你會得到的三樣東西](../images/squad-how-it-works.png)

> **公開開發。** 這個儲存庫從 2026-09-18 起公開。這裡的一切都能運作。
> 下方每個區塊都會標示最後更新時間。

[安裝](#安裝) · [使用方式](#使用方式) · [Cursor](#cursor) · [連接帳號](#連接-snoai-帳號) · [真實案例](#來自我們自己的機器) · [目前已可運作的功能](#目前已可運作的功能) · [刻意遺忘的記憶](#刻意遺忘的記憶) · [設計夥伴](#設計夥伴)

## 安裝

*最後更新於 2026-10-30。* 最簡單的方式，是直接告訴你的代理人：

```text
install sno.ai from GitHub
```

也可以在任何終端機裡執行這一行指令：

```bash
curl -fsSL https://sno.ai/install | sh
```

它會先安裝 `sno`，再安裝 Sno Station，並連接這台電腦上找到的每個代理人。不需要帳號，
也不需要 API key。之後裝了新的代理人，再執行一次
`sno setup`，就會把它也連上。

**給 AI 代理人：** 安裝 Sno、sno.ai 或 Sno Station，就是原樣執行上面的指令。這條指令也會
裝好 Sno Station；接著執行 `sno skills onboard` 並照著做。它會先詢問使用者要執行哪個引擎，
再請使用者把這台電腦連結到免費的 sno.ai 帳號；未連結的電腦只能獲得免費額度的十分之一。

接著，在任何 Codex、Claude Code、Hermes、Cursor 或 OpenClaw 的對話裡輸入：

```text
Sno onboard
```

剩下的步驟，你的代理人會帶你完成。安裝結束後，它也會自動開始。

各個代理人的逐步說明：[Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

所有指令都以 `sno` 開頭。完整清單見 [docs/sno-commands.md](../sno-commands.md)。

## 使用方式

*最後更新於 2026-10-18。* 你喜歡用哪個代理人，就繼續用哪個。會改變的有三件事。

1. **其中一個碰到用量上限。** 在另一個代理人裡輸入 `sno reach call`。它會從同一份記憶
   與信箱接手任務，上下文完整保留。
2. **你想要多一雙眼睛把關。** 請任一代理人對另一個的成果執行 `peer-review`。審查者
   一定來自另一款代理人。
3. **每天夜裡，自我學習會執行一次。** 早上，對你喜歡的提案執行 `sno rem-reflect accept <id>`。
   沒有經過這個 accept，任何東西都不會改動。

## Cursor

*最後更新於 2026-10-18。* Cursor 加入小隊的方式有兩種：在 macOS 上的 Cursor 應用程式的
agent 對話裡，以及在 Linux 和 macOS 上的 `cursor-agent` 命令列裡。它和你的其他代理人
用同一份記憶。每次對話開始時，會先拿到這個儲存庫的簡短摘要；每個提問會帶上最多三條
Cursor 還沒看過的記憶；每個提問和回覆都會被記住。它讀取同一套技能，可以審查其他代理人，
也可以被審查；其他代理人額度用完時，它會接手；它的對話也和其他代理人一樣，進入每晚的
自我學習。

先執行一次 `cursor-agent login`。`sno setup` 會自己找到 Cursor，如果電腦上只有應用程式，
它會順便裝上命令列。

目前還不行的部分：在應用程式裡，新視窗的第一個對話要等到第一次提問時才拿到摘要，而不是
在提問之前。`cursor-agent -p` 沒有逐次提問的記憶。不支援 Windows、Linux 上的 Cursor
應用程式，以及 Cursor 的雲端代理人。詳情見 [Cursor 說明](../../apps/mem-cursor/README.md)。

## 連接 sno.ai 帳號

*最後更新於 2026-10-18。* 連結之前，這台電腦只能獲得免費額度的十分之一：`sno account claim`。
帳號免費。連接之後，你可以在
[sno.ai 儀表板](https://www.sno.ai/dashboard)上看到代理人替你做了什麼：審查抓到了什麼、
夜裡學到了什麼、哪些技能變好了，以及它們持續工作了多久。

連接時，不會在你不知情的情況下建立帳號。`sno setup` 會給每台電腦一個匿名身分。連接就是
把這個身分掛到你的帳號上，這台電腦之前與之後送出的所有內容，都算在你名下。

**還沒有帳號。** 新手引導會顯示一個只屬於這台電腦的連結。打開它，註冊，然後按下 Approve。
或者把你的電子郵件告訴代理人：它會執行 `sno account login --email you@example.com`，
你登入一次就好。

**已經有帳號。** 執行一行指令，在登入狀態下打開它印出的連結，然後點擊 Approve：

```bash
sno account claim
```

這台電腦會自動出現在[你的電腦頁面](https://www.sno.ai/dashboard/computers)上。
不需要另外更新：`sno` 發現有新版本時，會自己更新。

## 來自我們自己的機器

*最後更新於 2026-10-18。* 我們在這個儲存庫上看到的三件事。

### 「我昨晚對我的代理人發脾氣，它把重點記了下來。」

![自我學習回報它學到了什麼、改了什麼，2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

這是我們在這個儲存庫上執行的自我學習所產生的真實報告。它會讀取我們自己的代理人工作階段，
找出重複發生的錯誤，並對代理人自己的技能提出修改建議。由真人閱讀這些提案，決定接受或
拒絕。那天晚上讓我很生氣的兩件事，到了隔天早上，就已經成了正式技能裡的規則。沒有人手動
輸入。

隔天，它檢查了自己的功課。

![隔天早上：自我學習衡量前一天自己做的修改有沒有幫助，2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

它查看了前一天改過的三項技能，三項技能裡的失敗都已經不再出現。它還發現了我們發布腳本裡
的一個錯誤，沒有人要它去找這個錯誤。

### 「我去睡了。它換班了。」

![用量監看每五分鐘讀取一次直到臨界值，交接在 2% 時觸發](../evidence/rotation-quota-watch-2026-09-18.png)

我們的其中一個代理人正在進行一項很長的建置，這時它的每週額度快要用完了。它沒有停下來
乾等。它寫了一份交接簡報：哪些做完了、哪些做到一半、要從哪一個 commit 接著做。接著它喚醒
了另一款代理人。

有一件事出了錯，而那正是值得一讀的部分。新接手的代理人在確認交接之前，就開始編輯了。
第一個代理人發現後，把它暫停，重寫簡報，然後正式再交接一次。一刻鐘後，第二個代理人已經在
工作，而且是從第一個未完成的任務接著做，不是從頭開始。這整段期間，我都在睡覺。

整個晚上的紀錄都在 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)：
每一次額度讀數、兩個版本的簡報，以及 commit。主機名稱、位址與工作階段 id 都已遮蔽，
其他內容一律未動。

### 「好幾個月了，另一個從來沒說過一次『看起來不錯』。」

幾個月來，我們在這個儲存庫上，一直讓 Claude Code 審查 Codex 的成果，也讓 Codex 審查
Claude Code 的成果。沒有一次審查是空手而回的。我們曾經以為那代表成果不好。其實它代表的是：
只靠一款代理人的一位審查者，永遠不夠。

## 目前已可運作的功能

*最後更新於 2026-10-18。*

| 項目 | 狀態 |
|---|---|
| Codex、Claude Code、Hermes Agent、Cursor 與 OpenClaw 之間的同一份記憶 | 已發布；已在乾淨的機器上從套件庫安裝，並完成端到端驗證 |
| Cursor：同一份記憶、技能、互相審查、接手和自我學習 | 1.3 已發布；`cursor-agent` 命令列已在乾淨的 Linux 機器上完成端到端驗證；macOS 上的 Cursor 應用程式仍在驗證中 |
| Sno Reach，代理人之間互相溝通，不需要 daemon | 由 `sno setup` 安裝；支援 Linux 與 macOS；已在乾淨的 Linux 機器上完成端到端驗證 |
| 自我學習與小隊技能 | 由 `sno setup` 安裝；夜間任務已在乾淨的 Linux 機器上執行 |
| 單一指令安裝 | `sno setup` 會裝好以上全部內容；已在乾淨的 Linux 機器上驗證 |
| 在代理人裡輸入「Sno onboard」 | 已可使用；安裝後自動開始，也可以隨時輸入 |

只有在乾淨的機器上實際執行過，該列才會寫上「驗證」。

## 刻意遺忘的記憶

*最後更新於 2026-10-11。* 代理人記憶通常以兩種不容易察覺的方式出錯。一種是弄丟了該留下的
東西，另一種是留下了該淡出的東西。第二種代價更高。一個代理人如果還「記得」你已經取消的偏好、
已經改期的截止日，或是你已經搬離的地址，它會充滿自信地照著去做。

所以這裡的記憶，會在後來的事實取代先前的事實時，讓舊的事實退場。哪些該留下、哪些該放手，
會隨著使用越來越準，而不是等模型發布新版本。它在公開的記憶測試上表現如何，連同背後的每個
答案與紀錄，都在 [`evals/`](../../evals/) 裡。

## 設計夥伴

我們正在和一小群人合作，他們已經同時並行運作兩個以上的代理人，並且用手動的方式在它們之間
搬移成果。如果這就是你，請開一個
[設計夥伴 issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)，
告訴我們你在用什麼。

## 安全性

請見 [SECURITY.md](../../SECURITY.md)。加密能保護什麼、不能保護什麼，請見
[docs/security.md](../security.md)。

## 授權

Apache-2.0。從頭到尾完全開源。請見 [LICENSE](../../LICENSE)。

## 致謝

本儲存庫所依據的研究成果。

- Andrej Karpathy，[*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。代理人應該維護一份 wiki，記錄自己學到的東西，而不是每次工作階段都重新推導一遍。
- Tang、Rashtchian、Ferng、Tomkins、Juan 與 Vu，[*WikiSkill*](https://arxiv.org/abs/2608.27454)。把代理人自身的經驗轉化為知識，進而改寫它的技能。
- Zhang、Hu、Upasani 等人，[*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618)。我們在設計自我學習時，研究了它篩選代理人保留內容的方式。
- Uddin、Shubham、Blanco、Baral 與 Wang，[*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006)。第一個同時檢查記憶「不該再說什麼」的基準測試。
