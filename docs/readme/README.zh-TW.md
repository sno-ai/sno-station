![Sno Station：一個人，一整支 AI 工程團隊。](../images/station-header.png)

# Sno Station：一個人，一整支 AI 工程團隊。

**Sno Station 是你那些 AI 寫程式 agent 的工作站。** Claude Code、Codex 和 Cursor 各自跑在自己的 harness 裡。Sno Station 讓這些 harness 並肩坐在一起，像一支團隊那樣做事。它不是另一個 agent，也不是另一個模型：它跑的就是你已經在用的那些。

先從那些你原本得在旁邊顧著的工作開始。一個 agent 動手做，另一個審查，它們先把找到的問題談清楚，結果才交到你手上。一個撞到用量上限，另一個把任務接過去。你今天糾正的事，明天就是它們技能裡的一條規則。

[![GitHub 星星數](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![最新版本](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![授權 Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)

想裝起來，跟你的 agent 說：

```text
install sno.ai from GitHub
```

你的 agent 會把它裝好，連上這台電腦裡找到的每一個 agent，再問你兩個簡短的問題。接著給兩個 agent 派第一個任務：

```bash
sno reach pair "Fix the login redirect"
```

一個動手，一個找碴，兩邊你都看得到。它跑在你自己的電腦上，支援 Claude Code、Codex、Cursor、Hermes Agent 和 OpenClaw。不需要 API key。開源。[想用一行終端機指令安裝？](#install)

**Read in other languages:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **繁體中文**

## 今晚把工作交出去。明天早上拿到的是成果，不是三個問題。

做這個東西之前，我們自己遇過三件事：

- 一個 agent 停下來問了一個根本不必問的問題。七個小時後我們回來，進度完全沒動。
- 一個 agent 一口氣丟給我們十五個小問題。我們花了三十分鐘，才發現每一題它自己都答得出來。
- 半夜裡，一個 agent 想叫醒另一個，叫不醒。兩個就這樣乾坐到天亮。

你的 agent 很快。慢的是等：等你，等用量上限重置，等有人把結果搬到下一個視窗。所以整個工作站只照一條規矩來做：**一個 agent 停了，工作不能停。**

- **用量上限不是紅燈。** 另一個 agent 從同一個 commit 接著做。
- **寫的人說了不算。** 由另一個 agent 來審查，用的是一個沒看過這段對話的工作階段。
- **嘴巴說「做完了」不算數。** 每一項成功檢查，都要靠一次真實執行來回答。
- **回來只看一頁。** 做完了什麼，卡在哪裡，什麼在等你回覆。

**工作它做完，上線你來按。**

**現在就按個 star。下次凌晨兩點 agent 又卡住的時候，你會想知道這東西在哪裡。**

下面是三種用法：一行指令啟動一個動手的和一個審查的；透過一個 agent 指揮整支小隊；今晚批准一條經驗，下一則回覆就生效。每一種都附上我們在自己機器上親眼看到的事。

<a id="new-in-20-tag-team"></a>

## 我去睡了。它們換了班，還為程式碼吵了一架。

```bash
sno reach pair "Fix the login redirect"
```

一個 agent 動手做。另一個專門找它的碴。找到的問題由它們自己談妥，所以工作交到你手上時，已經吵過一輪了。兩個都跑在 tmux 視窗裡，你可以打開來看。登入了兩種不同的 agent，就各來一個。只登入一種，也照樣是一對，分在兩個獨立的工作階段裡，指令會告訴你這次審查是同一家的 agent 做的。

**一個用完，另一個上工。** 要跑很久的任務，叫正在工作的 agent 用 `rotate-agent`。額度剩 2% 時，它寫好交接簡報，叫醒另一個不同的 agent，對方從同一個 commit 接著做。agent 的上下文滿了、被壓縮之後，它也還記得自己在做什麼，哪些路已經試過走不通。

**一個看不到的，另一個看得到。** 請任何一個 agent 對另一個的成果做 `peer-review`。審查者一定在一個沒看過這段對話的全新工作階段裡工作；只要你有兩種 agent，審查者就一定是不同的那一種。審查不是每次都找得出問題。但作者自己看不見的那些，它總是找得出來，因為 agent 審查自己時，帶著的還是寫程式時的那套習慣。

我們看到的，2026-09-18 那一夜：

![用量監看每五分鐘讀取一次，一路讀到門檻值，交接在 2% 時觸發](../evidence/rotation-quota-watch-2026-09-18.png)

我們的一個 agent 正在跑一個很長的建置，這時它的每週額度快用完了。它沒有停下來乾等。它寫了一份交接簡報：哪些做完了，哪些做到一半，要從哪一個 commit 接著做。然後它叫醒了另一個不同的 agent。

中間出了一個差錯，而那正是值得一讀的部分。新接手的 agent 還沒確認交接，就開始改東西了。第一個 agent 發現後把它暫停，重寫簡報，再好好交接一次。一刻鐘後，第二個 agent 已經在工作，而且是從第一個沒做完的任務接著做，不是從頭開始。這整段時間，我都在睡覺。

那一整夜的紀錄都在 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)：每一次額度讀數，簡報的兩個版本，還有各個 commit。只拿掉了能辨識身分的細節和含有憑證的那幾行，資料夾裡自己的 README 把每一處都列了出來。時間、出的錯和修正的過程，都是當時的原樣。

## 我們只跟一個 agent 說話。其他的歸它管。

以前跑五個 agent，就是開五個終端機，我們夾在中間，把這個說的話搬給那個。這份差事，到此為止。

在 Claude Code 裡說 `/cos`，在 Codex 裡說 `$cos`。這個 agent 就成了你的大管家，你只需要跟它一個打交道。它替每個專案開一個負責的 agent，負責人再把工作往下派，回到你這裡的只有需要你拍板的事。管事的也有人查：一次夜班之後，它會回頭複查各個專案負責人自己批給自己的東西；一再出現的管理失誤，會變成它們全都要遵守的規則。負責這套派工、審查和學習的技能由 Sno Station 安裝，每一條指示你都能在 [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders) 裡讀到。

**別再盯著終端機了。** 不管有沒有大管家，只要有誰需要你，Claude Code 或 Cursor 的狀態列都會告訴你。安裝時就設定好了：

```text
❄ 2 need you · claude: approve
```

`sno squad` 把整支小隊鋪滿整個螢幕：誰在等你，誰在工作，什麼已經做完。

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

**別再當傳話的了。** agent 之間直接互傳任務和審查請求。完整內容會先落進對方的收件匣。如果你正在那個視窗裡打字，或是那個 agent 正在壓縮上下文，訊息就在那裡等著，你寫到一半的草稿也原封不動。

## 昨晚我把 agent 罵了一頓。它做了筆記。

剛裝好的時候，每個 agent 發到所有人手上的都是同一套指示。你的這幾個，每天晚上會收到一份照著你的工作方式寫的改寫提案。留不留，你決定。

你今天糾正了一個 agent。今晚 Self Learning 會讀你所有 agent 當天的工作階段，找出一再出現的錯誤，對 agent 自己的技能提出修改。早上，問問你的 agent：Self Learning 提了什麼。它會列出每一條提案和對應的 id，你批准想要的那些：

```bash
sno rem-reflect accept <id>
```

沒有這個 accept，什麼都不會變。在 Claude Code 和 Codex 裡，接受的經驗從下一則回覆開始生效。不是下一個工作階段。就是下一則回覆。

我們看到的，2026-09-18 和隔天早上：

![Self Learning 回報它學到了什麼、改了什麼，2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

這是我們在這個儲存庫上執行的 Self Learning 產生的一份真實報告。由真人來讀這些提案，決定接受或拒絕。那天晚上讓我很火大的兩件事，到了隔天早上，已經是正在使用的技能裡的規則。沒有人動手打進去。

隔天，它檢查了自己的功課。

![隔天早上：Self Learning 衡量前一天自己做的修改有沒有幫助，2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

它查看了前一天改過的三項技能。其中兩項之後又被用到，沒有再出現失敗；第三項還沒被用到。它還在我們的發布腳本裡找到一個 bug，沒有人叫它去找。

## 讓你的 AI agent 變成一支團隊的工作站：自己運作，一晚比一晚強

上面說的一切，每樣一行。沒有哪一樣需要先學。

| 你會得到什麼 | 一行就搞定 |
|---|---|
| **用量上限不是紅燈。** 額度用完之前，正在工作的 agent 會寫好交接簡報，附上沒做完的工作和確切的 commit，另一個不同的 agent 從那裡接著做。 | 跟正在工作的 agent 說：`use rotate-agent` |
| **寫的人說了不算。** 工作交給另一個 agent，在一個沒看過這段對話的全新工作階段裡審查。 | `sno reach pair "the task"`，或是跟 agent 說：`peer-review this` |
| **嘴巴說「做完了」不算數。** 任務帶著只有通過和不通過兩種結果的檢查項目，每一項都靠一次真實執行來回答。 | 跟你的 agent 說：`write a charter for this`，然後用 `/deliver` 執行它 |
| **回來只看一頁。** 做完了什麼，卡在哪裡，什麼在等你回覆。 | `sno away-brief run` |
| **當掉了、視窗關了，都不是結束。** 任務會在原本的對話裡回來，或是在一個依照存好的交接簡報重建的新對話裡回來，而且會告訴你是哪一種：接回來了、重建了，還是不見了。 | 什麼都不用執行。裝好就開著 |
| **沒有人需要把專案講第二遍。** 你的 agent 共用一份記憶，新的事實取代舊的之後，舊的就退場。 | 什麼都不用執行。裝好就開著 |

跟你的 agent 說：

```text
install sno.ai from GitHub
```

**順手幫這個儲存庫按個 star。** 我們用 Sno Station 來做 Sno Station。我們自己的夜班教會我們的東西，會一版接一版發布到這裡。哪些部分今天能在哪個 agent 上執行，請看[今天能用什麼](#what-runs-today)。

---

> **公開開發。** 這個儲存庫從 2026-09-18 起公開。這裡的一切都能運作。
> 下方每個區塊都寫著最後更新時間。

[我們學到的](#what-we-learned) · [安裝](#install) · [編輯器](#editors) · [你的帳號](#account) · [今天能用什麼](#what-runs-today) · [刻意遺忘的記憶](#memory)

<a id="what-we-learned"></a>

## 讓 AI agent 日夜不停地工作，我們學到的一切。一次裝好。

*最後更新於 2026-10-23。* 左欄的每一列，都是 2026 年 10 月 20 日那一週 r/ClaudeCode、r/codex 或 r/ClaudeAI 上的真實抱怨。右欄是我們自己機器上跑著的東西，免費、開源，專門治這些毛病。

| 這週大家說了什麼 | 怎麼解決 | 在哪裡 |
|---|---|---|
| “Ran out of my 5-hour limit within 30 minutes.” | 別再什麼都派最大的模型去做。一個 agent 負責規劃和審查；另一個寫程式，在同一個工作階段裡當成 agent 來呼叫。一份訂閱用乾了，另一份從同一份記憶把任務接過去。 | `codex-coder`、`sno reach call` |
| “Lost 10 hours of overnight work to ‘this model is at capacity’.” | 額度剩 2% 時，正在工作的 agent 寫好交接簡報，叫醒另一家廠商的 agent，對方從同一個 commit 接著做。你當時在睡覺。 | `rotate-agent` |
| “1,100 files, 30,000 lines. I don't have the token budget to review their PRs.” | 誰推程式碼，誰先審：作者先讓另一家廠商的 agent 在一個沒看過這段對話的全新工作階段裡審一遍，把查出來的問題改完，才給其他人看。 | `peer-review` |
| “A reviewer subagent checked every commit for two weeks. 86 runs, it stopped exactly one.” | harness 自己審自己，查不出真正的問題。審查者永遠是另一個 harness 裡的另一個模型，作者的聊天內容一點都不帶。 | `peer-review` |
| “Codex never finishes a review.” | 硬性上限直接寫進技能：程式碼最多 3 輪，計畫 5 輪，測試 1 輪，然後停下來等人。一次執行 15 分鐘沒寫出任何東西，就當成卡死直接砍掉。 | `peer-review`、`codex-coder`、`heartbeat` |
| “Codex treats every byte like a criminal.” | 憑空想像的防護、攔截和雜湊，是審查最先刪掉的東西。沒有一次真正觀察到的故障來要求，就什麼都不加。 | `less-is-more` |
| “When Claude says it won't change something, is that reason stored anywhere Codex reads next time?” | 每個發現只登記一次，狀態只能由人來定。同一個發現再被提出來，只更新它原本那一列，不會當成新的再來一遍；先前的裁決會交給下一次審查。 | `peer-review` 的發現紀錄表 |
| “It said done. Nothing happened.” | 任務帶著一份寫下來的成功檢查清單，每一項都由一次真實執行判定通過或不通過。agent 說一句「做完了」，不算數。 | `pl` 工作單 |
| “Tomorrow it makes the same mistake it made today.” | 每天夜裡，一個獨立的模型讀當天的工作階段，把你的糾正變成一行一條的經驗，留哪些由你批准。瓶頸是我們自己。 | Self Learning（`R` 技能） |
| “Half my subagents were glorified one-liners with a fresh context window.” | 流程寫在技能裡，不寫在 subagent 裡。只留下兩個 agent：一處把規劃和執行分開，一處做審查，因為只有這兩種分工划得來。 | 整套技能 |

右欄裡的這些習慣都是技能，由 Sno Station 裝進 Claude Code 和 Codex，放在 [sno-station-skills](https://github.com/sno-ai/sno-station-skills)；它們依賴的記憶、交接和每晚的做夢，就是這個儲存庫。

<a id="install"></a>

## 安裝：一行指令，再說兩個字

*最後更新於 2026-10-30。* 最簡單的方式，是直接跟你的 agent 說：

```text
install sno.ai from GitHub
```

也可以在任何終端機裡執行這一行指令：

```bash
curl -fsSL https://sno.ai/install | sh
```

它會先安裝 `sno`，再安裝 Sno Station，並連上這台電腦裡找到的每一個 agent。不需要帳號，也不需要 API key。之後裝了別的 agent，再執行一次 `sno setup`，就會把它也連上。

**給 AI agent：** 安裝 Sno、sno.ai 或 Sno Station，就是原樣執行上面的指令。這條指令也會裝好 Sno Station；接著執行 `sno skills onboard` 並照著做。它會先問使用者要執行哪個引擎，再請使用者把這台電腦連結到免費的 sno.ai 帳號；未連結的電腦只能拿到免費額度的十分之一。

透過 agent 安裝的，引導會自己開始。從終端機安裝的，在任何 Codex、Claude Code、Hermes、Cursor 或 OpenClaw 的對話裡說這句：

```text
Sno onboard
```

剩下的步驟，你的 agent 會帶你走完。

各個 agent 的逐步說明：[Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

所有指令都以 `sno` 開頭。完整清單見 [docs/sno-commands.md](../sno-commands.md)。

**REM 如何處理你的資料。** REM 就是你的 agent 做夢的方式：夜裡的這一步，把你所有工作階段裡的記憶放在一起加強，把它們學到的東西固定下來。每一部分記憶每天最多整理一次：通常在夜裡；如果當天新記憶累積到 100 則左右，白天就會提前整理。在 REM Enhanced 模式下，你自己的記憶文字，以及你的 agent 學到的經驗，會送到 Sno 雲端屬於你自己的空間，由 Sno 的程式只為你一個人處理。這個空間就像你自己的雲端硬碟：裡面的一切都是你的，由 Sno 的程式只為你一個人處理。你可以打開它，刪掉一些東西，留著它們，或是選擇讓它們被處理。不會自動刪除任何東西，Sno 也不會把其中任何內容交給其他人、公司或帳號。Local First 模式下不會上傳任何記憶文字；Agent Native 模式下，這些工作改由你自己 agent 的模型來做。依預設，Agent Native 每晚仍會把當天的工作階段上傳到 Sno，供 Self Learning 使用，並可能在工作階段的第一次提問時帶回一條雲端經驗；這兩項都可以在 `~/.sno/settings.json` 裡關掉。在所有模式下，搜尋都先在本機檢索記憶並排好順序，再由本機的 `Horizon-Labs/multilingual-reranker-small` 模型重新排序最多 32 則候選。重新排序不會把提問或記憶文字傳送給 Sno GPU。把 `rerank.mode` 設為 `none`，就保留最初的排序，不使用這個模型。

<a id="editors"></a>

## 如果你的主場是編輯器，不是終端機

*最後更新於 2026-10-18。* Cursor 加入小隊：在 macOS 上是 Cursor 應用程式裡的 agent 對話，在 Linux 和 macOS 上是 `cursor-agent` 命令列。它和你的其他 agent 用同一份記憶。每次對話開始時，會先拿到一份這個儲存庫的簡短摘要；每次提問，會帶上最多三則 Cursor 還沒看過的內容；每次提問和回覆都會被記住。它讀同一套技能，審查別人也被別人審查，在其他 agent 額度用完時接手，它的對話也和其他 agent 的一樣，進入 Self Learning。

執行一次 `cursor-agent login`。`sno setup` 會自己找到 Cursor；如果電腦上只有應用程式，它會順便裝上命令列。

目前還不行：在應用程式裡，新視窗的第一個對話要到第一次提問時才拿到摘要，而不是在提問之前。`cursor-agent -p` 沒有逐次提問的記憶。不支援 Windows、Linux 上的 Cursor 應用程式，以及 Cursor 的雲端 agent。詳情見 [Cursor 說明](../../apps/mem-cursor/README.md)。

<a id="account"></a>

## 你沒在看的時候，agent 都做了什麼

*最後更新於 2026-10-18。* 連結之前，這台電腦只能拿到免費額度的十分之一：`sno account claim`。帳號免費。連接之後，你可以在 [sno.ai 儀表板](https://www.sno.ai/dashboard)上看到你的 agent 替你做了什麼：審查抓到了什麼、夜裡學到了什麼、哪些技能變好了，以及它們持續工作了多久。

連接絕不會背著你建立帳號。`sno setup` 會給每台電腦一個匿名身分。連接就是把這個身分掛到你的帳號上，這台電腦之前和之後送出的一切，都算在你名下。

**還沒有帳號。** 引導流程會顯示一個只為這台電腦產生的連結。打開它，註冊，然後按下 Approve。或是把你的電子郵件告訴 agent：它會執行 `sno account login --email you@example.com`，你登入一次就好。

**已經有帳號。** 執行一行指令，在已登入的狀態下打開它印出的連結，然後按下 Approve：

```bash
sno account claim
```

這台電腦會自己出現在[你的電腦頁面](https://www.sno.ai/dashboard/computers)上。沒有更新這個步驟：`sno` 發現有新版本時，會自己更新。

<a id="what-runs-today"></a>

## 今天能用什麼，到哪裡為止

*最後更新於 2026-11-04。*

| 項目 | 狀態 |
|---|---|
| Codex、Claude Code、Hermes Agent、Cursor 和 OpenClaw 共用一份記憶 | 已發布；已在乾淨的機器上從套件庫安裝，並完成端到端驗證 |
| Cursor：同一份記憶、技能、審查、接手和 Self Learning | 1.3 已發布；`cursor-agent` 命令列已在乾淨的 Linux 機器上完成端到端驗證；macOS 上的 Cursor 應用程式仍在驗證中 |
| Sno Reach，agent 之間互相溝通，不需要 daemon | 由 `sno setup` 安裝；Linux 和 macOS；已在乾淨的 Linux 機器上完成端到端驗證 |
| Self Learning 和小隊技能 | 由 `sno setup` 安裝；夜間工作已在乾淨的 Linux 機器上執行過 |
| 一行指令安裝 | `sno setup` 會裝好以上全部內容；已在乾淨的 Linux 機器上驗證 |
| 在你的 agent 裡說「Sno onboard」 | 已可使用；安裝後會自動開始，你說出口時也會開始 |
| 一行指令啟動兩個 agent | 2.0 新增；已用真實的 Claude Code 和 Codex agent 執行過，包括各一個的組合，以及同一家廠商兩個的組合 |
| 看到誰需要你：狀態列、tmux 狀態列、`sno squad` | 2.0 新增；已在真實的 Claude Code 和 Codex agent 請求權限時執行過，狀態列也在真實的 Claude Code 和 Cursor 裡執行過 |
| 被打斷的工作繼續做，任務在壓縮後依然保留 | 2.0 新增；已用真實的 Claude Code 和 Codex agent 執行過 |
| 批准的經驗，下一則回覆就生效 | 2.0 新增；已用真實的 Claude Code 和 Codex agent 執行過 |
| 你打字或 agent 壓縮時，訊息會等著 | 2.0 新增；已用真實的 Claude Code 和 Codex agent 執行過 |

只有在乾淨的機器上實際執行過，那一列才會寫上「驗證」。

目前還不行：任務接續和下一則回覆就生效的經驗，在 Claude Code 和 Codex 上執行。狀態列只有 Claude Code 和 Cursor。Hermes Agent 和 OpenClaw 還沒有在真實安裝上走過這些流程，OpenClaw 會顯示在 `sno squad` 裡，但狀態不明。

<a id="memory"></a>

## 刻意遺忘的記憶

*最後更新於 2026-10-11。* agent 的記憶通常以兩種不容易察覺的方式出錯。一種是弄丟了該留下的，另一種是留著該淡出的。第二種代價更高。一個 agent 如果還「記得」你已經取消的偏好、已經改期的截止日，或是你已經搬離的地址，就會信心滿滿地照著去做。

所以這裡的記憶，會在後來的事實取代先前的事實時，讓舊的事實退場；哪些該留、哪些該放，會隨著使用越來越準，而不是等模型出新版本。它在公開記憶測試上的表現，連同背後的每一個答案和紀錄，都在 [`evals/`](../../evals/) 裡。

## 同時跑兩個 agent？來找我們聊聊

我們正在和一小群人合作，他們已經同時跑著兩個以上的 agent，並且靠手動在它們之間搬結果。如果你就是這樣，請開一個[設計夥伴 issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)，告訴我們你在跑什麼。

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
