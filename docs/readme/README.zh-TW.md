# Sno Station 🧊 — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — 兩個終端機代理人共用一個記憶，在您自己的機器上執行](../images/hero-banner.png)

[![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
![status assembled in public](https://img.shields.io/badge/status-assembled%20in%20public-2dd4bf.svg?labelColor=3b3b3b)
![runs on your laptop, no daemon](https://img.shields.io/badge/runs%20on-your%20laptop%2C%20no%20daemon-3b82f6.svg?labelColor=3b3b3b)
![harnesses Claude Code, Codex, OpenClaw](https://img.shields.io/badge/harnesses-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenClaw-f0a04b.svg?labelColor=3b3b3b)

**其他語言版本：** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **繁體中文**

Sno Station 是您代理人的工作站：這款開源軟體能把您已經在使用的 AI 代理人——不論是
寫程式的代理人，還是通用型的工作代理人——整合成在您自己機器上運作的同一支團隊。
當其中一個碰到速率限制時，另一個會接手，並保留完整的上下文。它們會互相審查對方的
成果，讓更少的錯誤流入您手上。而它們共用的那個工作區，每晚都會變得更聰明：它會讀
取代理人的工作階段紀錄，對代理人自己的技能提出修改建議，並等待您說「可以」。

**屬於您，而且永遠屬於您。** 記憶、訊息與技能都存放在您筆電上的同一個工作區裡。
不需要 daemon、不需要伺服器、不需要雲端；未來若推出雲端功能，也僅是選配，沒有它產品
本身依然完整。Apache-2.0，從頭到尾開源。您的記憶儲存從第一次使用起，就會在您的機器
上加密，加密金鑰只會佈署一次，且永遠不會離開您的機器；Sno 永遠不會取得您的資料庫或
金鑰。完整的邊界說明——它能防護什麼、不能防護什麼——請見 [docs/security.md](../security.md)。

**支援您慣用的語言。** 您可以用英語、中文（簡體或繁體）、日語、韓語、德語、法語、西班
牙語或俄語與您的代理人對話；記憶引擎會為每筆記憶記錄其語言、依語系分類，並在每個索
引鍵與搜尋中完整保留 CJK 文字。Duo 技能的撰寫方式，能配合您與代理人溝通時所使用的任
何語言來執行，而這份 README 也提供九種語言版本。

![How it works: two agents, one shared workspace, three things you get](../images/squad-how-it-works.png)

> **公開組裝中。** 這個儲存庫從 2026-09-18 起，正一件一件地公開釋出。今天已經放在這
> 裡的內容都是真實且可運作的；尚未放上來的內容則不會被宣稱已完成。下方每個區塊都會
> 標示最後更新時間。

[安裝](#install) · [使用方式](#how-to-use) · [今天已可運作的功能](#what-runs-today) · [刻意會遺忘的記憶](#memory-that-forgets-on-purpose) · [設計夥伴](#design-partners) · [參考資料](#references)

## Install

*最後更新於 2026-09-19。* 目前還沒有。單一指令安裝功能會隨 onboarding 技能一起推出；
在那之前，請持續關注這個儲存庫。上線後，操作方式會像這樣：

```bash
# inside any Claude Code, Codex or OpenClaw conversation:
Sno onboarding
```

代理人會透過 `sno` CLI 自行完成設定：共用記憶、Sno Reach、Duo 技能，以及各個
harness 所需的 hook。不需要記住任何套件名稱。

## How to use

*最後更新於 2026-09-19。* 安裝完成後，您仍然可以照原本的方式工作，使用您喜歡的任何
代理人。會改變的只有三件事：

1. **其中一個碰到用量上限。** 在另一個代理人裡輸入 `sno reach call`；它會從共用記憶
   與信箱接手任務，且上下文完整無缺。
2. **您想要多一雙眼睛把關。** 請任一代理人對另一個的成果執行 `peer-review`。負責
   審查的一方，永遠來自另一個 harness。
3. **每天晚上，RSI loop 都會執行一次。** 隔天早上，對您喜歡的提案執行 `rem-reflect
   accept <id>`。沒有經過這個 accept，任何東西都不會被改動。

## "我昨晚對著代理人發了頓脾氣，牠倒是把重點記了下來。"

*這是在我們自己機器上實際發生的樣子。三天，三份報告。最後更新於 2026-09-19。*

**第一天——牠學會了。**

![The nightly loop reporting what it learned and changed, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

這是我們在這個儲存庫上執行的 RSI loop 所產生的真實報告。它每天執行一次，讀取我們自己代理
人的工作階段紀錄，找出重複發生的錯誤，並對代理人自己的技能檔案提出修改建議。由真人
閱讀這些提案，決定接受或拒絕。沒有經過這個 accept，任何東西都不會被改動。那天晚上讓
負責人感到不滿的兩件事，到了隔天早上就已經變成上線技能中的規則；沒有人手動輸入過這
些內容。

**第二天——牠檢查自己的功課。**

![The next morning: the RSI loop measures whether yesterday's own changes helped, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

隔天的執行在凌晨 00:58 自行啟動，讀取了 113 個工作階段，並檢驗了前一天修改過的三項
技能。三項技能的失敗率都降到了零。它還發現了我們發布腳本裡一個真正的錯誤，那個錯誤
先前一直被 zsh 從 bash 眼皮底下藏了起來。沒有人叫它去找這個錯誤。

**第三天——換您安裝它。** RSI loop 這週會以技能的形式，在這個儲存庫中發布；到那時，
這個區塊就會變成安裝指令。在那之前，這個段落會隨著 RSI loop 的執行持續更新：每週一
份新報告，不會回頭修改舊的。

它的靈感來自我們一再回頭參考的兩份研究：Andrej Karpathy 的 *"LLM Wiki"*——主張代
理人應該維護一份持續存在、可編輯的 wiki 來記錄自己學到的東西，而不是每次工作階段
都重新推導一遍——以及 Google Research 與 Virginia Tech 提出的 *"WikiSkill"*，它會
把代理人自身的經驗彙整成持續存在的知識，進而改寫代理人的技能。相關連結請見
[參考資料](#references)。

## "共事數月，另一個從沒說過一句 '看起來不錯'。"

這幾個月來，我們一直讓 Claude Code 審查 Codex 的成果，也讓 Codex 審查 Claude Code
的成果，就在這個儲存庫裡進行。沒有一次審查是空手而回的。一次都沒有。我們曾經以為這
代表程式碼寫得不好。但其實它代表的是：只靠一個 harness 的一個審查者，永遠不夠。

我們把這一對稱為 Duo：最小的一支小隊。我們從不會說哪一個比較細心、哪一個比較快。這
件事每個月、每項工作都可能不一樣。重點在於，它們彼此不同。

## "我睡了一覺。它換了班。"

*這是在我們自己機器上實際發生的樣子，2026-09-18。*

![用量監看每五分鐘讀取一次直到臨界值，交接在 2% 時觸發](../evidence/rotation-quota-watch-2026-09-18.png)

我們的其中一個代理人正在執行一項二十七個任務的建置，做到第二十一個任務時，它的每週
用量降到了 2%。它沒有停在那裡等著被切斷。它寫了一份交接簡報：哪些做完了、哪些做到
一半、要從哪一個 commit 接著做。接著它喚醒了另一個 harness 的代理人，並且在對方量測
過簡報的大小與 checksum、並明確回報之前，不讓對方碰任何東西。

有一件事出了錯，而那正是值得一讀的部分。接手方在確認釋出之前就開始編輯了。交出方發
現了，把它暫停，重寫簡報，然後再正式釋出一次。交接開始後十四分鐘四十一秒，第二個代
理人已經在工作，第一個則在剩下 1% 時簽退。交接前的每一個 commit 都完好無缺；第二個
代理人是從第一個未勾選的任務接著做，不是從頭開始。這整段期間我都在睡覺。

整個晚上的紀錄都在 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)：
每五分鐘一次的用量讀數、兩個版本的簡報、就緒與釋出的收據，以及 commit 摘要。主機名
稱、位址與工作階段 id 都已遮蔽；其他內容一律未動。

## What runs today

*最後更新於 2026-09-20。*

| 項目 | 狀態 |
|---|---|
| `packages/chunking` | 已在此儲存庫中，經過測試，並發布至 npm |
| 共用套件（`common-core`、`utils`、`embedder`、`sno-observe`、`sno-station-core-crypto`、`content-sanitizer`） | 已在此儲存庫中 |
| 跨 Claude Code、Codex 與 OpenClaw 的共用記憶 | 引擎與三種介面皆已在此儲存庫中；尚待乾淨機器驗證 |
| Sno Reach——代理人之間互相溝通，不需要 daemon | 原始碼已在此儲存庫中；發布封存檔尚待推出 |
| RSI loop（技能） | 本週 |
| 單一指令安裝（執行 `sno assemble`，或在您的代理人裡輸入 "Sno onboarding"） | 尚未宣稱完成 |

只有在乾淨的機器上運作過之後，該項目才會標示為「已證實」；在那之前，這裡只會說明目前已具備的內容。

## Memory that forgets on purpose

*最後更新於 2026-09-19。*

記憶是這款產品的地基，而不是宣傳重點。但大多數代理人記憶系統出問題，正是出在地基這
一層，而且是以兩種不容易察覺的方式出錯：該留下的忘記了，該淡出的卻留了下來。第二種
失誤代價更高。一個代理人如果還「記得」您已經取消的偏好設定、已經改期的截止日期、您
已經搬離的地址，它會帶著十足的信心繼續依此行動。

直到今年，都還沒有人衡量過這件事。大家常引用的長期記憶基準測試（LoCoMo、
LongMemEval）只衡量回想能力：對的事實有沒有被找回來。一個永遠不會忘記任何東西的系
統，在這些測試上會拿到滿分。2026 年 4 月，亞利桑那州立大學的一組研究團隊發表了
**Memora**（Uddin、Shubham、Blanco、Baral、Wang，*From Recall to Forgetting:
Benchmarking Long-Term Memory for Personalized Agents*，[arXiv
2604.20006](https://arxiv.org/abs/2604.20006)，ACL 2026 Findings）。這是第一個針對
第二種失誤所設計的基準測試。每一道題目都帶有兩種檢查：必須被回想起來的事實，以及在
對話中已被取消或被取代、絕對**不**該再出現的事實。它的核心指標 **FAMA**
（Forgetting-Aware Memory Accuracy，具遺忘意識的記憶準確度）等於回想分數，再扣除代
理人每次依賴過時事實所產生的懲罰。該論文對其測試的六個記憶代理人所得出的結論是：
"frequent reuse of invalid memories and failures to reconcile evolving memories."
（頻繁重複使用無效的記憶，且未能調和不斷演變的記憶內容。）

那正是 Sno Station 的記憶系統從一開始就設計來通過的考驗，也是記憶會自我改進的原因：
哪些該留下、哪些該淘汰，以及後來的事實如何取代先前的事實，這些規則都會隨著使用而調
整，而不是等模型發布新版才改變。

![Memora weekly track: FAMA and forgetting cost, Sno Station against the paper's six agents](../images/memora-forgetting-cost.png)

**我們在該論文 weekly track 上的成績**（六個人物設定、九十道題目、一次正式測試，時
間為 2026-09-06；[九十道題目的回答、裁判紀錄和 trace](../../evals/memora/formal-run-2026-09-06/)
都在這裡）：

| | 記憶 | 推理 | 建議 | **FAMA** | MPA（僅回想） | 遺忘代價 |
|---|---:|---:|---:|---:|---:|---:|
| **Sno Station** | 77.4 | 93.3 | 90.9 | **87.2** | 91.0 | **3.76 分（占回想分數的 4.1%）** |
| LangMem（論文） | 71.2 | 30.0 | 48.9 | 50.0 | 57.7 | 7.70（13.3%） |
| Nemori（論文） | 65.1 | 18.7 | 52.8 | 45.5 | 53.1 | 7.60（14.3%） |
| MemoryOS（論文） | 51.8 | 20.7 | 62.6 | 45.0 | 51.7 | 6.70（13.0%） |
| MemoBase（論文） | 43.6 | 18.0 | 68.9 | 43.5 | 51.5 | 8.00（15.5%） |
| A-Mem（論文） | 71.8 | 2.0 | 35.0 | 36.3 | 39.3 | 3.00（7.6%） |
| Mem-0（論文） | 40.4 | 16.0 | 52.6 | 36.3 | 39.8 | 3.50（8.8%） |

老實說，這張表該怎麼解讀：

- **遺忘代價**是 MPA 減去 FAMA：也就是系統因為依賴過時事實而損失的分數。請把它理解
  成佔該系統自身回想分數的比例，而不是原始分數本身。A-Mem 與 Mem-0 的原始損失分數
  之所以比較低，只是因為它們原本能回想起來的東西就很少，能損失的自然也不多。
- **推理能力**（整合多筆記憶）是目前已發表研究中最弱的一環，普遍落在 100 分中的 2
  到 30 分。我們的成績是 93.3。
- 論文中六個代理人的分數，是用論文自己的評分模型（GPT-4o-mini）評出來的；我們的分
  數則是用我們自己的評分模型組合，並依論文的逐題懲罰公式（§4.2）重新計算。這是方向
  性的比較，不是經過認證的比較。我們的 FAA（正確排除已取消事實的比例）測得為
  0.833；論文並未針對各個代理人公布 FAA 數字，因此沒有列出對手的 FAA。

另外三套證據遵循同樣的規則：每項選擇一個正式結果，底層回答或檢索紀錄都在 `evals/`：

| 基準測試 | 衡量內容 | 結果 |
|---|---|---|
| **LoCoMo** | 長對話問答，1542 道題目 | 96.76%（合併後的答案集：每次修正後仍然答錯的題目會重新作答，已經答對的題目則沿用；收據中有註明） |
| LongMemEval-S 上的 **R@5**（500 道題目） | 檢索能力：正確的記憶是否出現在前五名 | 95.4%（R@10 為 98.6，R@20 為 99.4） |
| **Sno Memory Bench** | 我們自製的 23 項端對端測試，涵蓋公開基準測試未涉及的「保留或淘汰」判斷案例 | 23 之 23 |

## Design partners

我們正在與一小群已經同時並行運作兩個以上代理人，並手動在它們之間搬移執行結果的
使用者合作。如果這就是您的情況，歡迎開一個[設計夥伴 issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)，
告訴我們您正在使用的環境。

## Security

請見 [SECURITY.md](../../SECURITY.md)。

## License

Apache-2.0。從頭到尾完全開源。請見 [LICENSE](../../LICENSE)。

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
