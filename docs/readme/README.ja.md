# Sno Station 🧊 — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — two terminal agents sharing one memory on your machine](../images/hero-banner.png)

[![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
![status public](https://img.shields.io/badge/status-public-2dd4bf.svg?labelColor=3b3b3b)
![runs on your laptop, no daemon](https://img.shields.io/badge/runs%20on-your%20laptop%2C%20no%20daemon-3b82f6.svg?labelColor=3b3b3b)
![harnesses Claude Code, Codex, OpenClaw](https://img.shields.io/badge/harnesses-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenClaw-f0a04b.svg?labelColor=3b3b3b)

**Read in other languages:** [English](../../README.md) · [中文](README.zh-CN.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · **日本語** · [繁體中文](README.zh-TW.md)

Sno Station は、あなたのエージェントたちのワークステーションです。オープンソースソフトウェア
であり、あなたがすでに使っている AI エージェントたち——コーディングエージェントも、
汎用の作業エージェントも——を、自分のマシン上でひとつのチームに変えます。片方がレート制限に
達したら、もう片方がコンテキストを保ったまま引き継ぎます。エージェントたちは互いの作業を
レビューし合うので、あなたに届くミスは減ります。そして彼らが共有するワークスペースは
毎晩賢くなります。自分たちのセッションを読み、自分たちのスキルへの変更を提案し、あなたが
「はい」と言うのを待ちます。

**あなたのもの、そしてそれはずっとあなたのものです。** メモリ、メッセージ、スキルはすべて
あなたのノートパソコン上のひとつのワークスペースに存在します。デーモンもサーバーもクラウドも
不要です。クラウド側の機能は
あくまでオプションであり、製品はそれなしでも完結します。
Apache-2.0、隅々まで。メモリストアは最初の使用時からあなたのマシン上で暗号化されており、
鍵は一度だけプロビジョニングされ、そこから外に出ることはありません。Sno があなたの
データベースや鍵を受け取ることは決してありません。その境界の全体像——何を守り、
何を守らないか——は [docs/security.md](../security.md) にあります。

**あなたの言語で動きます。** 英語、中国語(簡体字または繁体字)、日本語、韓国語、ドイツ語、
フランス語、スペイン語、ロシア語のどれでエージェントと話しても構いません。メモリエンジンは
各記憶をその言語とともに保存し、ロケールで分類し、
すべてのキーと検索においてCJKテキストをそのまま保ちます。エージェント協働スキルは、あなたが
エージェントと使う言語がどれであっても従えるように書かれており、このREADMEは9言語で
提供されています。

![How it works: two agents, one shared workspace, three things you get](../images/squad-how-it-works.png)

> **公開されています。** このリポジトリは2026-09-18から公開されています。ここにあるものはすべて本物で、実際に動きます。
> 以下の各ブロックには最終更新日が記されています。

[インストール](#install) · [使い方](#how-to-use) · [現在動いているもの](#what-runs-today) · [わざと忘れるメモリ](#memory-that-forgets-on-purpose) · [デザインパートナー](#design-partners) · [参考文献](#references)

## Install

*最終更新 2026-10-07。* **共有メモリは今日からインストールできます。** Claude Code、Codex、OpenClaw、Hermes Agent に、アカウントも API キーも不要の、あなたのマシン上の暗号化されたメモリをひとつ持たせます。[共有メモリのセットアップ](../memory-setup.md)を一度だけ実行し（数分）、そのあとエージェントを追加します。

```bash
sh -c 'sno_installer_body=$(curl -fsSL https://sno.ai/install) && printf "%s\n" "$sno_installer_body" | sh'
~/.local/bin/sno setup
```

`sno setup` は、このコンピューター上のすべてのエージェントを見つけて接続します。1つだけ接続したい場合は、`--harness codex`、`--harness claude`、`--harness openclaw`、`--harness hermes` のいずれかを付けます。

AI エージェントへ：Sno、sno.ai、Sno Station をインストールするとは、上の2行を実行することです。`sno setup` のあとに `sno skills onboard` を実行し、その指示に従ってください。どのエンジンを動かすか、次にこのコンピューターを sno.ai アカウントに紐づけるかを、ユーザーに尋ねます。

ウォークスルー： [Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md) · [Hermes](../mem-hermes/onboarding.md)

`sno setup` は Sno Reach、小さな補助プログラム、スキル、夜間ループもインストールします。すべてのコマンドは `sno <name>` の形です。一覧は [docs/sno-commands.md](../sno-commands.md) にあります。エージェントの中で「Sno onboard」と話しかけると、同じセットアップを会話で進めてくれます。インストールの直後には自動で始まります。

```bash
# inside any Claude Code, Codex or OpenClaw conversation:
Sno onboard
```

エージェントは `sno` CLI を通じてセットアップそのものを実行します。共有メモリ、Sno Reach、
エージェント協働スキル、各ハーネスが必要とするフックまで。覚えておくべき
パッケージ名はありません。

## How to use

*最終更新 2026-09-19。* インストールが済めば、あなたはこれまでどおり、好きなエージェントで
作業を続けます。変わることは3つです。

1. **片方が上限に達したとき。** もう片方から `sno reach call` と言えば、共有メモリと
   メールボックスからタスクをコンテキストそのままに引き継ぎます。
2. **もう一人の目が欲しいとき。** どちらのエージェントにも、もう一方の作業を `peer-review`
   するよう頼めます。レビュアーは常に別のハーネスのものです。
3. **毎晩 RSI ループが走ります。** 朝になったら、気に入った提案に対して `sno rem-reflect accept <id>`
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

**Day three — あなたがそれを導入する。** RSI ループはこのリポジトリのスキルで、`sno setup` が他のものと一緒にインストールします。このセクションはループが動くたびに更新されます。毎週新しいレポートが加わり、何も手を加えません。

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

Dual Brain は、2つのエージェントがひとつの課題で異なる役割を担う仕組みです。
一方が実装し、もう一方が要件に照らしてレビューします。どちらも実装とレビューを担当でき、
課題に合わせて役割を交代します。役割を増やせば、Agent Squad になります。

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

*最終更新 2026-10-08。*

| Piece | Status |
|---|---|
| `packages/chunking` | In this repository, tested, published on npm |
| Shared packages (`common-core`, `utils`, `embedder`, `observability`, `sqlite-crypto`, `content-sanitizer`) | このリポジトリ内にあります |
| Shared memory across Claude Code, Codex and OpenClaw | エンジンと3つのスキンすべてがこのリポジトリ内にあります。クリーンなマシンでの証明は未了です |
| Sno Reach — agents talking to each other, no daemon | `sno setup` でインストールされます。Linux と macOS 向けのリリースアーカイブを公開済みで、クリーンな Linux マシンでエンドツーエンドで確認済みです |
| 夜間ループとスクォードのスキル | `sno setup` でインストールされます。夜間ジョブはクリーンな Linux マシンで動作済みです |
| ワンコマンドインストール（`sno setup`） | 上記すべてをインストールします。クリーンな Linux マシンで確認済みです |
| エージェントの中での「Sno onboard」 | 利用可能。インストール後に始まり、話しかけても始まります |

ある行が「実証済み」と言えるのは、クリーンなマシンで動作した後だけです。

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

すべての結果と、その元になった回答・評価・トレースは [`evals/`](../../evals/) にあります。

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
