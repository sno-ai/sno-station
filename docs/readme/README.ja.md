# Sno Station 🧊 — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — two terminal agents sharing one memory on your machine](../images/hero-banner.png)

[![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
![status assembled in public](https://img.shields.io/badge/status-assembled%20in%20public-2dd4bf.svg?labelColor=3b3b3b)
![runs on your laptop, no daemon](https://img.shields.io/badge/runs%20on-your%20laptop%2C%20no%20daemon-3b82f6.svg?labelColor=3b3b3b)
![harnesses Claude Code, Codex, OpenClaw](https://img.shields.io/badge/harnesses-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenClaw-f0a04b.svg?labelColor=3b3b3b)

**他の言語で読む:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · **日本語** · [繁體中文](README.zh-TW.md)

Sno Station は、あなたのエージェントたちのワークステーションです。オープンソースソフトウェア
であり、あなたがすでに使っている AI エージェントたち——コーディングエージェントも、
汎用の作業エージェントも——を、自分のマシン上でひとつのチームに変えます。片方がレート制限に
達したら、もう片方がコンテキストを保ったまま引き継ぎます。エージェントたちは互いの作業を
レビューし合うので、あなたに届くミスは減ります。そして彼らが共有するワークスペースは
毎晩賢くなります。自分たちのセッションを読み、自分たちのスキルへの変更を提案し、あなたが
「はい」と言うのを待ちます。

**あなたのもの、そしてそれはずっとあなたのものです。** メモリ、メッセージ、スキルはすべて
あなたのノートパソコン上のひとつのワークスペースに存在します。デーモンもサーバーもクラウドも
不要です。クラウド側の機能が
登場するとしても、それはあくまでオプションであり、製品はそれなしでも完結します。
Apache-2.0、隅々まで。メモリストアは最初の使用時からあなたのマシン上で暗号化されており、
鍵は一度だけプロビジョニングされ、そこから外に出ることはありません。Sno があなたの
データベースや鍵を受け取ることは決してありません。その境界の全体像——何を守り、
何を守らないか——は [docs/security.md](../security.md) にあります。

**あなたの言語で動きます。** 英語、中国語(簡体字または繁体字)、日本語、韓国語、ドイツ語、
フランス語、スペイン語、ロシア語のどれでエージェントと話しても構いません。メモリエンジンは
各記憶をその言語とともに保存し、ロケールで分類し、
すべてのキーと検索においてCJKテキストをそのまま保ちます。Duo のスキルは、あなたが
エージェントと使う言語がどれであっても従えるように書かれており、このREADMEは9言語で
提供されています。

![How it works: two agents, one shared workspace, three things you get](../images/squad-how-it-works.png)

> **公開の場で組み立てる。** このリポジトリは2026-09-18から、一つずつ部品を公開しています。
> 今日ここにあるものは本物であり、実際に動きます。まだここにないものは、あるとは主張していません。
> 以下の各ブロックには最終更新日が記されています。

[インストール](#install) · [使い方](#how-to-use) · [現在動いているもの](#what-runs-today) · [わざと忘れるメモリ](#memory-that-forgets-on-purpose) · [デザインパートナー](#design-partners) · [参考文献](#references)

## Install

*最終更新 2026-09-19。* まだです。ワンコマンドインストールはオンボーディングスキルとともに
到着します。それまではこのリポジトリを見守ってください。到着すると、次のようになります。

```bash
# inside any Claude Code, Codex or OpenClaw conversation:
Sno onboarding
```

エージェントは `sno` CLI を通じてセットアップそのものを実行します。共有メモリ、Sno Reach、
Duo のスキル、各ハーネスが必要とするフックまで。覚えておくべき
パッケージ名はありません。

## How to use

*最終更新 2026-09-19。* インストールが済めば、あなたはこれまでどおり、好きなエージェントで
作業を続けます。変わることは3つです。

1. **片方が上限に達したとき。** もう片方から `sno reach call` と言えば、共有メモリと
   メールボックスからタスクをコンテキストそのままに引き継ぎます。
2. **もう一人の目が欲しいとき。** どちらのエージェントにも、もう一方の作業を `peer-review`
   するよう頼めます。レビュアーは常に別のハーネスのものです。
3. **毎晩 RSI ループが走ります。** 朝になったら、気に入った提案に対して `rem-reflect accept <id>`
   としてください。承認しない限り何も変わりません。

## "昨夜エージェントを怒鳴りつけた。翌朝にはメモを取っていた。"

*これが私たち自身のマシンで実際にどう見えるかです。3日間、3件のレポート。最終更新 2026-09-19。*

**Day one — 学習する。**

![The nightly loop reporting what it learned and changed, 2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

これは、私たちがこのリポジトリ上で運用している RSI ループからの実際のレポートです。1日に一度、
自分たち自身のエージェントセッションを読み、繰り返されるミスを見つけ、エージェント自身の
スキルファイルへの変更を提案します。人間がその提案を読み、承認するか却下するかを決めます。
承認しない限り何も変わりません。その晩オーナーが苛立っていた2つのことは、翌朝には
稼働中のスキルのルールになっていました。誰もそれをタイプ入力してはいません。

**Day two — 自分の宿題を採点する。**

![The next morning: the RSI loop measures whether yesterday's own changes helped, 2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

翌日の実行は00:58に自動的に発火し、113件のセッションを読み、前日に変更した3つのスキルを
測定しました。3つすべてで失敗はゼロになりました。それは、zsh が bash から隠していた
リリーススクリプトの実際のバグも見つけました。誰もそれを探せとは言っていません。

**Day three — あなたがそれを導入する。** RSI ループは今週、このリポジトリのスキルとして
公開されます。それが実現したら、このブロックはインストール手順になります。それまでは、
このセクションはループが走るたびに更新されます。毎週新しいレポートが1件、手を加えずに。

これは、私たちが何度も立ち返る2つの仕事に着想を得ています。Andrej Karpathy の *"LLM Wiki"*
——エージェントは毎セッション知識を再導出するのではなく、学んだことの永続的で編集可能な
ウィキを持つべきだという発想——、そして Google Research と Virginia Tech による
*"WikiSkill"*——エージェント自身の経験を永続的な知識にコンパイルし、そのスキルを書き換える
というもの。リンクは[参考文献](#references)にあります。

## "何か月も、もう一方が「良さそうですね」と言ったことは一度もない。"

私たちはこのリポジトリで何か月もの間、Claude Code に Codex の作業をレビューさせ、
Codex に Claude Code の作業をレビューさせてきました。空振りに終わったレビューはひとつも
ありません。ひとつも。かつては、それは作業の出来が悪いということだと思っていました。
実際には、1つのハーネスからの1人のレビュアーだけでは決して足りない、ということなのです。

私たちはこのペアを Duo と呼びます:最小のスコッドです。私たちはどちらが慎重な方でどちらが
速い方かを決して言いません。それは月によって、仕事によって入れ替わります。重要なのは、
彼らが違うということです。

## "私は眠りについた。向こうはシフトを交代した。"

*これが私たち自身のマシンで実際にどう見えるかです。2026-09-18。*

![クォータ監視が5分ごとに閾値へ向かって読み取りを続け、2%で引き継ぎが発火する](../evidence/rotation-quota-watch-2026-09-18.png)

私たちのエージェントの1つは、27件のタスクからなるビルドの21件目まで進んだところで、
週間クォータが2%に達しました。そこで止まって、死ぬのを待つことはしませんでした。
引き継ぎメモを書いたのです。何が終わり、何が途中で、どのコミットから続ければよいかを
正確に。それから、もう一方のハーネスのエージェントを起こし、そのエージェントがメモの
サイズとチェックサムを測定してそう申告するまで、何にも触らせませんでした。

1つだけうまくいかなかったことがあり、それこそが読む価値のある部分です。受け手は、
引き渡しを確認する前に編集を始めてしまいました。送り手はそれを捉え、一時停止させ、
メモを書き直し、あらためて正しく引き渡しました。引き継ぎが始まってから14分41秒後、
2人目のエージェントは作業しており、1人目は残り1%でサインオフしました。引き継ぎ前の
コミットはすべて無傷です。2人目のエージェントは最初からではなく、最初の未完了タスクから
続けました。その間ずっと、私は眠っていました。

その一晩のすべては [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)
にあります。5分間隔のすべてのクォータ読み取り、メモの両バージョン、準備完了と引き渡しの
受領記録、そしてコミットの要約。ホスト名、アドレス、セッション ID は伏せています。
それ以外には手を加えていません。

## What runs today

*最終更新 2026-09-20。*

| Piece | Status |
|---|---|
| `packages/chunking` | In this repository, tested, published on npm |
| Shared packages (`common-core`, `utils`, `embedder`, `sno-observe`, `sno-station-core-crypto`, `content-sanitizer`) | このリポジトリ内にあります |
| Shared memory across Claude Code, Codex and OpenClaw | エンジンと3つのスキンすべてがこのリポジトリ内にあります。クリーンなマシンでの証明は未了です |
| Sno Reach — agents talking to each other, no daemon | ソースはこのリポジトリ内にあります。リリースアーカイブは未了です |
| The RSI loop (skill) | This week |
| One-command install (`sno assemble`, or say "Sno onboarding" inside your agent) | Not yet claimed |

ある行が「実証済み」と言えるのは、クリーンなマシンで動作した後だけです。それまでは、ここに何があるかを述べます。

## Memory that forgets on purpose

*最終更新 2026-09-19。*

メモリはこの製品の土台であり、看板ではありません。しかしその土台こそが、たいていの
エージェントメモリが失敗する場所であり、それは2つの静かなやり方で失敗します。残るべき
ものを忘れる、そして減衰すべきものを保持し続ける、です。後者のほうが高くつく失敗です。
あなたがキャンセルした好み、動いてしまった締め切り、離れた住所を、エージェントがまだ
「覚えて」いれば、それを完全な自信を持って実行してしまいます。

今年までは、誰もそれを測定していませんでした。人々が引用する長期記憶ベンチマーク
(LoCoMo、LongMemEval) は再現だけをスコアします。正しい事実が返ってきたかどうか、です。
何も忘れないシステムはそれらで満点を取れます。2026年4月、アリゾナ州立大学のグループが
**Memora** を発表しました (Uddin, Shubham, Blanco, Baral, Wang, *From Recall to Forgetting:
Benchmarking Long-Term Memory for Personalized Agents*, [arXiv 2604.20006](https://arxiv.org/abs/2604.20006), ACL 2026 Findings)。
これは後者の失敗を中心に構築された最初のベンチマークです。各質問には2種類のチェックが
含まれます。再現されなければならない事実と、会話の中でキャンセルまたは置き換えられ、
**表に出てはならない**事実です。その代表的な指標である **FAMA** (Forgetting-Aware Memory
Accuracy) は、再現率から、エージェントがまだ頼っている古い事実1つごとのペナルティを
差し引いたものです。この論文がテストした6つのメモリエージェントについての自身の指摘は
こうです。「無効になった記憶の頻繁な再利用と、進化する記憶を統合できないこと。」

それが、Sno Station のメモリが合格するために作られた試験であり、メモリが自己改善する
理由でもあります。何を保持し、何を引退させ、後の事実がどのように以前の事実に取って
代わるかは、すべてモデルのリリースではなく、使用とともに変化します。

![Memora weekly track: FAMA and forgetting cost, Sno Station against the paper's six agents](../images/memora-forgetting-cost.png)

**論文のウィークリートラックにおける私たちの結果**(6人のペルソナ、90問、正式実行1回、
2026-09-06。[90問すべての回答、判定、トレース](../../evals/memora/formal-run-2026-09-06/)
はこちらです):

| | Remember | Reason | Recommend | **FAMA** | MPA (recall alone) | Forgetting cost |
|---|---:|---:|---:|---:|---:|---:|
| **Sno Station** | 77.4 | 93.3 | 90.9 | **87.2** | 91.0 | **3.76 pts (4.1% of recall)** |
| LangMem (paper) | 71.2 | 30.0 | 48.9 | 50.0 | 57.7 | 7.70 (13.3%) |
| Nemori (paper) | 65.1 | 18.7 | 52.8 | 45.5 | 53.1 | 7.60 (14.3%) |
| MemoryOS (paper) | 51.8 | 20.7 | 62.6 | 45.0 | 51.7 | 6.70 (13.0%) |
| MemoBase (paper) | 43.6 | 18.0 | 68.9 | 43.5 | 51.5 | 8.00 (15.5%) |
| A-Mem (paper) | 71.8 | 2.0 | 35.0 | 36.3 | 39.3 | 3.00 (7.6%) |
| Mem-0 (paper) | 40.4 | 16.0 | 52.6 | 36.3 | 39.8 | 3.50 (8.8%) |

これを誠実に読むなら:

- **Forgetting cost** は MPA から FAMA を引いたもの、つまり古い事実によってシステムが
  失うポイントです。これは生のポイントとしてではなく、そのシステム自身の再現率に対する
  割合として読んでください。A-Mem と Mem-0 が失う生のポイントが少ないのは、そもそも
  再現する量が少なく、失うものがほとんどないからにすぎません。
- **Reasoning**(複数の記憶を組み合わせること)は、公開されているこの分野で最も弱い
  部分で、100点満点中2から30点です。私たちのものは93.3です。
- 論文の6つのエージェントは論文のジャッジ(GPT-4o-mini)でスコアされました。私たちの
  ものは私たち自身のジャッジスタックで、論文の質問ごとのペナルティ計算式(§4.2)を
  使って再計算しています。方向性としての比較であり、認証されたものではありません。
  私たちの FAA(正しく除外されたキャンセル済み事実の割合)は0.833と測定されています。
  論文はエージェントごとの FAA を公開していないため、競合の FAA は表示していません。

残り3つの証拠セットも同じルールです。それぞれ1つの正式な結果を選び、その回答または
検索記録を `evals/` に収録しています:

| Benchmark | What it measures | Result |
|---|---|---|
| **LoCoMo** | Long-conversation QA, 1542 questions | 96.76% (merged answer set: questions still wrong after each fix were re-answered, already-correct ones carried over; the receipt says so) |
| **R@5** on LongMemEval-S (500 questions) | Retrieval: is the right memory in the top five | 95.4% (R@10 98.6, R@20 99.4) |
| **Sno Memory Bench** | 23 end-to-end probes of our own, including keep-versus-retire cases the public benchmarks do not cover | 23 of 23 |

## Design partners

私たちは、すでに2つ以上のエージェントを並行して動かし、結果を手作業で
やり取りしている人たち数名と協力しています。もしそれがあなたなら、
[design partner issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml) を開いて、あなたが何を動かしているか
教えてください。

## Security

[SECURITY.md](../../SECURITY.md) を参照してください。

## License

Apache-2.0。オープンソース、隅々まで。[LICENSE](../../LICENSE) を参照してください。

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
