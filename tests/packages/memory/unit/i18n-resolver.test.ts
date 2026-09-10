import { beforeEach, describe, expect, it } from "vitest";
import { detectCategory } from "../../../../apps/mem-claw/src/extraction/capture-policy-detector.ts";
import {
	clearSessionLocaleCache,
	resolveLocale,
} from "../../../../apps/mem-claw/src/i18n/resolver.ts";

describe("i18n resolver", () => {
	beforeEach(() => {
		clearSessionLocaleCache();
	});

	it("R0: explicitLocale wins over detection", () => {
		const locale = resolveLocale({
			text: "我今天去公园散步天气真好",
			explicitLocale: "ja",
		});
		expect(locale).toBe("ja");
	});

	it("R0: invalid explicitLocale is ignored, falls through to detect", () => {
		const locale = resolveLocale({
			text: "Hello, my name is Alice and I live here.",
			explicitLocale: "xx",
		});
		expect(locale).toBe("en");
	});

	it("R1: short text without cache uses default", () => {
		expect(resolveLocale({ text: "hi" })).toBe("en");
	});

	it("R1: empty text always falls back to default without changing session state", () => {
		const sid = "empty-session";
		expect(resolveLocale({ text: "", sessionId: sid })).toBe("en");
		expect(
			resolveLocale({
				text: "我今天去公园散步天气真好很开心",
				sessionId: sid,
			}),
		).toBe("zh");
		expect(resolveLocale({ text: "   ", sessionId: sid })).toBe("en");
		expect(resolveLocale({ text: "嗯", sessionId: sid })).toBe("zh");
	});

	it("R1: short text with cache returns cached locale", () => {
		const sid = "session-1";
		resolveLocale({
			text: "我今天去公园散步天气真好很开心",
			sessionId: sid,
		});
		expect(resolveLocale({ text: "嗯", sessionId: sid })).toBe("zh");
	});

	it("R1: production detectCategory uses the session locale cache for short text", () => {
		const sid = "category-session";
		expect(
			detectCategory("我今天更喜欢使用 Bun 而不是 Node.js，因为启动更快", {
				sessionId: sid,
			}),
		).toBe("profile");

		expect(detectCategory("喜欢")).toBe("profile");
		expect(detectCategory("喜欢", { sessionId: sid })).toBe("profile");
	});

	it("R1: malformed session ids are not used as cache keys", () => {
		const longId = "s".repeat(257);
		resolveLocale({
			text: "我今天去公园散步天气真好很开心",
			sessionId: longId,
		});
		expect(resolveLocale({ text: "嗯", sessionId: longId })).toBe("en");

		const controlCharId = "session-\u0000-id";
		resolveLocale({
			text: "我今天去公园散步天气真好很开心",
			sessionId: controlCharId,
		});
		expect(resolveLocale({ text: "嗯", sessionId: controlCharId })).toBe("en");
	});

	it("R3: session locale remains fixed after first detection", () => {
		const sid = "session-fixed";
		const first = resolveLocale({
			text: "Hello, my name is Alice and I live in San Francisco.",
			sessionId: sid,
		});
		expect(first).toBe("en");

		const dissent1 = resolveLocale({
			text: "我今天去公园散步天气真好很开心",
			sessionId: sid,
		});
		expect(dissent1).toBe("en");

		const dissent2 = resolveLocale({
			text: "我今天去公园散步天气真好很开心",
			sessionId: sid,
		});
		expect(dissent2).toBe("en");
	});

	it("R3: mixed-language disagreements do not change a fixed session locale", () => {
		const sid = "session-mixed";
		resolveLocale({
			text: "Hello, my name is Alice and I live in San Francisco.",
			sessionId: sid,
		});
		expect(
			resolveLocale({
				text: "我今天去公园散步天气真好很开心",
				sessionId: sid,
			}),
		).toBe("en");
		expect(
			resolveLocale({
				text: "今日は公園を散歩しました天気が良かった",
				sessionId: sid,
			}),
		).toBe("en");
		expect(
			resolveLocale({
				text: "今日は公園を散歩しました天気が良かった",
				sessionId: sid,
			}),
		).toBe("en");
	});

	it("R3: explicit locale can override a fixed session locale", () => {
		const sid = "session-explicit";
		resolveLocale({
			text: "Hello, my name is Alice and I live in San Francisco.",
			sessionId: sid,
		});
		const explicit = resolveLocale({
			text: "我今天去公园散步天气真好很开心",
			sessionId: sid,
			explicitLocale: "zh",
		});
		expect(explicit).toBe("zh");

		const sessionLocale = resolveLocale({
			text: "我今天去公园散步天气真好很开心",
			sessionId: sid,
		});
		expect(sessionLocale).toBe("en");
	});
});
