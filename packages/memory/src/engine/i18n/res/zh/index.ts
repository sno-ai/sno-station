import type { LocaleResources } from "../_types";
import { defineLocaleResources } from "../locale-resource-helpers";
import { buildDateResolutionPrompt } from "../date-resolution-prompt";
import { buildDedupPrompt, buildExtractionPrompt } from "./extraction-prompts";
import { buildReflectionFallbackText, buildReflectionPrompt } from "./reflection-prompts";

const captureTriggers = {
	identityPattern: /我的.+是|我叫|名字|住在|工作于|过敏|邮箱|电话/,
	preferencePattern: /喜欢|偏好|讨厌|不喜欢|爱用|习惯|想要|需要/,
	entityPattern: /\+\d{10,}|[\w.-]+@[\w.-]+\.\w+|项目|团队|公司|组织|经理|宠物|服务|仓库|联系人/,
	eventPattern: /决定|选择|改用|上线|发布|部署|事故|发生|以后|从现在开始/,
	lessonPattern: /学到|教训|经验教训|下次|避免|根因|复盘|反思|错误|解决方案/,
	explicitMemoryCommandPositivePatterns: [
		/^\s*(?:请|麻烦|帮我)?\s*(?:记住|记一下|记下|帮记|帮记住)/,
		/^\s*(?:请)?\s*(?:把|将)[^\n]{0,80}(?:保存|存)(?:为|到|进|作为)[^\n]{0,30}(?:长期)?记忆/,
		/^\s*(?:请)?\s*(?:把|将)[^\n]{0,80}(?:保存|存)[^\n]{0,30}(?:以备|供|留作)[^\n]{0,20}(?:日后|以后|后续)(?:回忆|参考|查阅)/,
	],
	explicitMemoryCommandRecallQuestionPatterns: [
		/^\s*(?:你)?(?:还)?\s*记得[^\n]{0,40}吗\??/,
		/^\s*你能(?:想起|回忆起|记起)[^\n]{0,40}吗\??/,
	],
	explicitMemoryCommandManagementPatterns: [
		/^\s*(?:请|麻烦)?\s*(?:忘记|忘掉|删除|删掉|清除|清空|擦除|清掉|抹去)/,
	],
	weekStartDay: 1,
} as const;

const noise = {
	denialPatterns: [
		/我没有(任何)?(信息|数据|记忆|记录)/,
		/我不太确定/,
		/我不记得/,
		/我想不起来/,
		/看起来我没有/,
		/我没找到/,
		/没有找到(相关)?记忆/,
		/我没有访问权限/,
	],
	metaQuestionPatterns: [
		/你还?记得/,
		/记不记得/,
		/还记得.*吗/,
		/你知道.+吗/,
		/我(?:之前|上次|以前)(?:说|提|讲).*(?:吗|呢|？|\?)/,
		/我(?:之前|以前|上次|先前|曾经).{0,30}(保存|存|记住|记下|记录|记忆).{0,40}(是什么|什么|哪|吗|呢|？|\?)/,
		/(我的|我).{0,30}(保存|存|记住|记下|记录|记忆).{0,40}(是什么|什么|哪|吗|呢|？|\?)/,
		/如果你知道.+只回复/,
		/如果不知道.+只回复\s*none/,
		/只回答.{0,30}(验证码|代号|代码|名称|名字|茶名)/,
		/只回复精确代号/,
		/只回复\s*none/,
	],
	metaFrustrationPatterns: [
		/你(从来|老是|总是|怎么|又|还|经常){0,3}(记不住|不记得|记不得|忘记|忘了)/,
		/为什么你(总是|老是|又|还|从来|经常){0,3}(不记得|记不住|忘)/,
		/我的(记忆|记录|笔记)(怎么|为什么)?(没了|不见了|是错的|坏了|乱了|不对|丢了)/,
	],
} as const;



const toolDescriptions = {
	memoryRecall: "通过混合检索（向量 + 关键词）搜索长期记忆。",
	memoryStore: "将重要信息保存到长期记忆中。",
	memoryForget: "按 ID 或查询删除指定的记忆。",
	memoryUpdate: "按 ID 更新已存储的记忆。",
	memoryStats: "显示记忆使用统计。",
	memoryList: "列出已存储的记忆，支持分页和筛选。",
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
	invariantSignals: [/总是|从不|必须|应该|规则|不变|决定|稳定/],
	derivedSignals: [/学到|观察|反思|派生|变化|验证|复查/],
	openLoopSignals: [/待办|跟进|下一步|行动|验证|复查/],
	invariantLegacySignals: [/总是|从不|必须|应该|规则|不变|决定|稳定/],
	derivedLegacySignals: [/学到|观察|反思|派生|变化|验证|复查/],
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
		correctionSignals: [/其实|不对|错了|更正|应该是|改成/],
		ackTokens: [/^(了解|好的|好|嗯|收到|明白|知道了|👍)\s*[。.!]?$/],
		memoryIntent: [/记住|记一下|保存|别忘了/],
		reflectionSliceClassifiers,
	},
);
