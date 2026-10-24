// Golden vectors for the combine rules (docs/sync-conflicts.md, Phase B). Two builds that combine the
// same inputs must write the same version, so these outputs are frozen for COMBINE_RULES_VERSION 1:
// changing any expected value here means changing the rules, which means bumping the version.

import { describe, expect, it } from "vitest";
import { COMBINE_RULES_VERSION, combineSiblings, type Sibling } from "./combine";

const CASES: Record<string, { inputs: Sibling[]; output: unknown }> = {
	loginPasswordAndNotes: {
		inputs: [
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					vv: {
						a: {
							wall: 20,
							counter: 0,
							node: "a",
						},
					},
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "px",
					notes: "n0",
					tags: ["a", "b"],
					partStamps: {
						credential: {
							wall: 20,
							counter: 0,
							node: "a",
						},
						name: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						notes: {
							wall: 10,
							counter: 0,
							node: "a",
						},
					},
					itemStamps: {
						urls: {
							"https://github.com": {
								wall: 10,
								counter: 0,
								node: "a",
							},
						},
						tags: {
							a: {
								wall: 10,
								counter: 0,
								node: "a",
							},
							b: {
								wall: 10,
								counter: 0,
								node: "a",
							},
						},
					},
					partStampsAt: {
						wall: 20,
						counter: 0,
						node: "a",
					},
				},
			},
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 30,
						counter: 0,
						node: "b",
					},
					vv: {
						a: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						b: {
							wall: 30,
							counter: 0,
							node: "b",
						},
					},
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "p",
					notes: "ny",
					tags: ["a", "b"],
					partStamps: {
						credential: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						name: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						notes: {
							wall: 30,
							counter: 0,
							node: "b",
						},
					},
					itemStamps: {
						urls: {
							"https://github.com": {
								wall: 10,
								counter: 0,
								node: "a",
							},
						},
						tags: {
							a: {
								wall: 10,
								counter: 0,
								node: "a",
							},
							b: {
								wall: 10,
								counter: 0,
								node: "a",
							},
						},
					},
					partStampsAt: {
						wall: 30,
						counter: 0,
						node: "b",
					},
				},
			},
		],
		output: {
			data: {
				type: "login",
				name: "GitHub",
				urls: ["https://github.com"],
				username: "u",
				password: "px",
				notes: "ny",
				tags: ["a", "b"],
				partStamps: {
					credential: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					name: {
						wall: 10,
						counter: 0,
						node: "a",
					},
					notes: {
						wall: 30,
						counter: 0,
						node: "b",
					},
				},
				itemStamps: {
					urls: {
						"https://github.com": {
							wall: 10,
							counter: 0,
							node: "a",
						},
					},
					tags: {
						a: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						b: {
							wall: 10,
							counter: 0,
							node: "a",
						},
					},
				},
				partStampsAt: {
					wall: 30,
					counter: 1,
					node: "~merge:LAS313DK8yJ0hYTksrnJsw",
				},
				passwordChangelog: [
					{
						value: "p",
						changedAt: 30,
					},
				],
			},
			hlc: {
				wall: 30,
				counter: 1,
				node: "~merge:LAS313DK8yJ0hYTksrnJsw",
			},
			causal: {
				vv: {
					a: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					b: {
						wall: 30,
						counter: 0,
						node: "b",
					},
					"~merge:LAS313DK8yJ0hYTksrnJsw": {
						wall: 30,
						counter: 1,
						node: "~merge:LAS313DK8yJ0hYTksrnJsw",
					},
				},
			},
			replaces: [
				{
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 30,
						counter: 0,
						node: "b",
					},
					vv: {
						a: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						b: {
							wall: 30,
							counter: 0,
							node: "b",
						},
					},
				},
				{
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					vv: {
						a: {
							wall: 20,
							counter: 0,
							node: "a",
						},
					},
				},
			],
		},
	},
	tagsAddAndRemove: {
		inputs: [
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					vv: {
						a: {
							wall: 20,
							counter: 0,
							node: "a",
						},
					},
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "p",
					notes: "n0",
					tags: ["b"],
					partStamps: {
						credential: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						name: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						notes: {
							wall: 10,
							counter: 0,
							node: "a",
						},
					},
					itemStamps: {
						urls: {
							"https://github.com": {
								wall: 10,
								counter: 0,
								node: "a",
							},
						},
						tags: {
							b: {
								wall: 10,
								counter: 0,
								node: "a",
							},
						},
					},
					partStampsAt: {
						wall: 20,
						counter: 0,
						node: "a",
					},
				},
			},
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 30,
						counter: 0,
						node: "b",
					},
					vv: {
						a: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						b: {
							wall: 30,
							counter: 0,
							node: "b",
						},
					},
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "p",
					notes: "n0",
					tags: ["a", "b", "c"],
					partStamps: {
						credential: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						name: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						notes: {
							wall: 10,
							counter: 0,
							node: "a",
						},
					},
					itemStamps: {
						urls: {
							"https://github.com": {
								wall: 10,
								counter: 0,
								node: "a",
							},
						},
						tags: {
							a: {
								wall: 10,
								counter: 0,
								node: "a",
							},
							b: {
								wall: 10,
								counter: 0,
								node: "a",
							},
							c: {
								wall: 30,
								counter: 0,
								node: "b",
							},
						},
					},
					partStampsAt: {
						wall: 30,
						counter: 0,
						node: "b",
					},
				},
			},
		],
		output: {
			data: {
				type: "login",
				name: "GitHub",
				urls: ["https://github.com"],
				username: "u",
				password: "p",
				notes: "n0",
				tags: ["b", "c"],
				partStamps: {
					credential: {
						wall: 10,
						counter: 0,
						node: "a",
					},
					name: {
						wall: 10,
						counter: 0,
						node: "a",
					},
					notes: {
						wall: 10,
						counter: 0,
						node: "a",
					},
				},
				itemStamps: {
					urls: {
						"https://github.com": {
							wall: 10,
							counter: 0,
							node: "a",
						},
					},
					tags: {
						b: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						c: {
							wall: 30,
							counter: 0,
							node: "b",
						},
					},
				},
				partStampsAt: {
					wall: 30,
					counter: 1,
					node: "~merge:LAS313DK8yJ0hYTksrnJsw",
				},
			},
			hlc: {
				wall: 30,
				counter: 1,
				node: "~merge:LAS313DK8yJ0hYTksrnJsw",
			},
			causal: {
				vv: {
					a: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					b: {
						wall: 30,
						counter: 0,
						node: "b",
					},
					"~merge:LAS313DK8yJ0hYTksrnJsw": {
						wall: 30,
						counter: 1,
						node: "~merge:LAS313DK8yJ0hYTksrnJsw",
					},
				},
			},
			replaces: [
				{
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 30,
						counter: 0,
						node: "b",
					},
					vv: {
						a: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						b: {
							wall: 30,
							counter: 0,
							node: "b",
						},
					},
				},
				{
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					vv: {
						a: {
							wall: 20,
							counter: 0,
							node: "a",
						},
					},
				},
			],
		},
	},
	cardNumberAndName: {
		inputs: [
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					vv: {
						a: {
							wall: 20,
							counter: 0,
							node: "a",
						},
					},
				},
				data: {
					type: "card",
					name: "Visa",
					cardholderName: "A",
					number: "5555",
					expMonth: "01",
					expYear: "30",
					cvv: "123",
					partStamps: {
						card: {
							wall: 20,
							counter: 0,
							node: "a",
						},
						name: {
							wall: 10,
							counter: 0,
							node: "a",
						},
					},
					itemStamps: {},
					partStampsAt: {
						wall: 20,
						counter: 0,
						node: "a",
					},
				},
			},
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 30,
						counter: 0,
						node: "b",
					},
					vv: {
						a: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						b: {
							wall: 30,
							counter: 0,
							node: "b",
						},
					},
				},
				data: {
					type: "card",
					name: "Mine",
					cardholderName: "A",
					number: "4111",
					expMonth: "01",
					expYear: "30",
					cvv: "123",
					partStamps: {
						card: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						name: {
							wall: 30,
							counter: 0,
							node: "b",
						},
					},
					itemStamps: {},
					partStampsAt: {
						wall: 30,
						counter: 0,
						node: "b",
					},
				},
			},
		],
		output: {
			data: {
				type: "card",
				name: "Mine",
				cardholderName: "A",
				number: "5555",
				expMonth: "01",
				expYear: "30",
				cvv: "123",
				partStamps: {
					card: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					name: {
						wall: 30,
						counter: 0,
						node: "b",
					},
				},
				itemStamps: {},
				partStampsAt: {
					wall: 30,
					counter: 1,
					node: "~merge:LAS313DK8yJ0hYTksrnJsw",
				},
			},
			hlc: {
				wall: 30,
				counter: 1,
				node: "~merge:LAS313DK8yJ0hYTksrnJsw",
			},
			causal: {
				vv: {
					a: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					b: {
						wall: 30,
						counter: 0,
						node: "b",
					},
					"~merge:LAS313DK8yJ0hYTksrnJsw": {
						wall: 30,
						counter: 1,
						node: "~merge:LAS313DK8yJ0hYTksrnJsw",
					},
				},
			},
			replaces: [
				{
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 30,
						counter: 0,
						node: "b",
					},
					vv: {
						a: {
							wall: 10,
							counter: 0,
							node: "a",
						},
						b: {
							wall: 30,
							counter: 0,
							node: "b",
						},
					},
				},
				{
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: {
						wall: 20,
						counter: 0,
						node: "a",
					},
					vv: {
						a: {
							wall: 20,
							counter: 0,
							node: "a",
						},
					},
				},
			],
		},
	},
};

describe("combine golden vectors", () => {
	it("are pinned to rules version 1", () => {
		expect(COMBINE_RULES_VERSION).toBe(1);
	});

	it.each(Object.entries(CASES))("%s", async (_name, { inputs, output }) => {
		expect(await combineSiblings(inputs)).toEqual(output);
	});
});
