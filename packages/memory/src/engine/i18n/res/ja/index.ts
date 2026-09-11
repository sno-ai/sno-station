import type { LocaleResources } from "../_types";
import { defineLocaleResources } from "../locale-resource-helpers";
import { buildDateResolutionPrompt } from "../date-resolution-prompt";
import { buildDedupPrompt, buildExtractionPrompt } from "./extraction-prompts";
import { buildReflectionFallbackText, buildReflectionPrompt } from "./reflection-prompts";

const captureTriggers = {
	identityPattern: /名前|私は|住んで|働いて|役割|メール|電話|アレルギー/,
	preferencePattern: /好き|嫌い|好み|必要|欲しい|愛用/,
	entityPattern:
		/\+\d{10,}|[\w.-]+@[\w.-]+\.\w+|プロジェクト|チーム|会社|組織|マネージャー|家族|ペット|リポジトリ|サービス/,
	eventPattern: /決めた|決定|選んだ|移行|切り替え|リリース|デプロイ|障害|起きた|今後/,
	lessonPattern: /学んだ|教訓|次回|ミス|避ける|二度と|根本原因|解決策|反省/,
	explicitMemoryCommandPositivePatterns: [
		/^\s*\S{0,30}?(?:覚えて(?:おいて)?(?:ください|下さい)?|記憶して(?:おいて)?(?:ください|下さい)?)/,
		/(?:長期記憶として|長期メモリとして|記憶として)\S{0,80}保存(?:して)?/,
		/後で(?:思い出せる|参照できる|読み返せる)ように\S{0,80}保存/,
	],
	explicitMemoryCommandRecallQuestionPatterns: [
		/(?:覚えてい?ますか|覚えてる\??\s*$|思い出せますか|思い出せる\??\s*$)/,
	],
	explicitMemoryCommandManagementPatterns: [
		/^\s*\S{0,30}?(?:忘れて(?:ください|下さい)?|削除して|消して|クリアして|破棄して)/,
	],
	weekStartDay: 1,
} as const;

const noise = {
	denialPatterns: [
		/(情報|データ|記憶|記録)(は|が)(ありません|ない)/,
		/よくわかりません/,
		/思い出せません/,
		/覚えていません/,
		/見つけられませんでした/,
		/(関連する)?記憶は見つかりませんでした/,
		/アクセスできません/,
		/分かりません/,
	],
	metaQuestionPatterns: [
		/覚えていますか|覚えてる/,
		/思い出せますか|思い出せる/,
		/(私|僕|俺)が(言いました|話しました|伝えました|共有しました)か/,
		/(私|僕|俺)は(言った|話した|伝えた)/,
		/何を(言いました|話しました|伝えました)か/,
	],
	metaFrustrationPatterns: [
		// Assistant-targeted (te-kureru benefactive) or memory-system failure only —
		// subjectless "I always forget" self-facts are legitimate memories, not noise.
		/(覚えて|記憶して)くれ(ない|ません|なかった)/,
		/記憶が(おかしい|消えた|壊れ(た|てる)|間違って)/,
	],
} as const;



const toolDescriptions = {
	memoryRecall: "ハイブリッド検索（ベクトル + キーワード）で長期記憶を検索します。",
	memoryStore: "重要な情報を長期記憶に保存します。",
	memoryForget: "ID またはクエリで特定の記憶を削除します。",
	memoryUpdate: "ID で保存された記憶を更新します。",
	memoryStats: "記憶の使用状況の統計を表示します。",
	memoryList: "保存された記憶をページングとフィルターで一覧表示します。",
} as const;

const extractionPrompts = {
	buildDateResolutionPrompt,
	buildExtractionPrompt,
	buildDedupPrompt,
} as const;

const reflectionPrompts = {
	buildReflectionPrompt,
	buildReflectionFallbackText,
} as const;

const reflectionSliceClassifiers = {
	invariantSignals: [/必ず|決して|ルール|規則|不変|決定|安定/],
	derivedSignals: [/学び|観察|振り返り|反省|派生|差分|確認|変更/],
	openLoopSignals: [/TODO|フォロー|次|アクション|確認|再確認/i],
	invariantLegacySignals: [/必ず|決して|ルール|規則|不変|決定|安定/],
	derivedLegacySignals: [/学び|観察|振り返り|反省|派生|差分|確認|変更/],
} as const;

export const resources: LocaleResources = defineLocaleResources(
	{
		captureTriggers,
		noise,
		toolDescriptions,
		extractionPrompts,
		reflectionPrompts,
	},
	{
		correctionSignals: [/実は|違う|訂正|本当は/],
		ackTokens: [/^(了解|わかりました|分かった|はい)\s*[。.!]?$/],
		memoryIntent: [/覚えて|記録|保存/],
		reflectionSliceClassifiers,
	},
);
