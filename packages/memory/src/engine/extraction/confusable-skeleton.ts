/** @file confusable-skeleton.ts
 * @purpose Normalizes common Unicode confusables before prompt-injection checks.
 */

const CONFUSABLES: Readonly<Record<string, string>> = {
	Α: "A",
	А: "A",
	Β: "B",
	В: "B",
	Ε: "E",
	Е: "E",
	Η: "H",
	Н: "H",
	Ι: "I",
	І: "I",
	Κ: "K",
	К: "K",
	Μ: "M",
	М: "M",
	Ν: "N",
	О: "O",
	Ρ: "P",
	Р: "P",
	С: "C",
	Τ: "T",
	Т: "T",
	Χ: "X",
	Х: "X",
	Υ: "Y",
	а: "a",
	е: "e",
	і: "i",
	ο: "o",
	о: "o",
	р: "p",
	с: "c",
	х: "x",
	у: "y",
	"０": "0",
	"１": "1",
	"２": "2",
	"３": "3",
	"４": "4",
	"５": "5",
	"６": "6",
	"７": "7",
	"８": "8",
	"９": "9",
};

export function buildConfusableSkeleton(text: string): string {
	return Array.from(text.normalize("NFKC"), (char) => CONFUSABLES[char] ?? char).join("");
}
