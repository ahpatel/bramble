// Golden vectors for the combine rules (docs/sync-conflicts.md, Phase B). Two builds that combine the
// same inputs must write the same version, so these outputs are frozen for COMBINE_RULES_VERSION 1:
// changing any expected value here means changing the rules, which means bumping the version.

import { describe, expect, it } from "vitest";
import { COMBINE_RULES_VERSION, combineSiblings, type Sibling } from "./combine";

// Inputs are plain JSON, as they arrive decrypted: partial passkeys and unknown fields included.
const CASES: Record<string, { inputs: unknown[]; output: unknown }> = {
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
						changedAt: 20,
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
	bothChangedPassword: {
		inputs: [
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 20, counter: 0, node: "a" },
					vv: { a: { wall: 20, counter: 0, node: "a" } },
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "px",
					notes: "n0",
					partStampsAt: { wall: 20, counter: 0, node: "a" },
					partStamps: {
						name: { wall: 10, counter: 0, node: "a" },
						notes: { wall: 10, counter: 0, node: "a" },
					},
					itemStamps: { urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } } },
				},
			},
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 30, counter: 0, node: "b" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, b: { wall: 30, counter: 0, node: "b" } },
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "py",
					notes: "n0",
					partStampsAt: { wall: 30, counter: 0, node: "b" },
					partStamps: {
						name: { wall: 10, counter: 0, node: "a" },
						notes: { wall: 10, counter: 0, node: "a" },
					},
					itemStamps: { urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } } },
				},
			},
		],
		output: null,
	},
	threeFoldOneLeftOut: {
		inputs: [
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 20, counter: 0, node: "a" },
					vv: { a: { wall: 20, counter: 0, node: "a" } },
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "px",
					notes: "n0",
					partStampsAt: { wall: 20, counter: 0, node: "a" },
					partStamps: {
						name: { wall: 10, counter: 0, node: "a" },
						notes: { wall: 10, counter: 0, node: "a" },
					},
					itemStamps: { urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } } },
				},
			},
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 30, counter: 0, node: "b" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, b: { wall: 30, counter: 0, node: "b" } },
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "p",
					notes: "ny",
					partStampsAt: { wall: 30, counter: 0, node: "b" },
					partStamps: {
						credential: { wall: 10, counter: 0, node: "a" },
						name: { wall: 10, counter: 0, node: "a" },
					},
					itemStamps: { urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } } },
				},
			},
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 40, counter: 0, node: "c" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, c: { wall: 40, counter: 0, node: "c" } },
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "pz",
					notes: "n0",
					partStampsAt: { wall: 40, counter: 0, node: "c" },
					partStamps: {
						name: { wall: 10, counter: 0, node: "a" },
						notes: { wall: 10, counter: 0, node: "a" },
					},
					itemStamps: { urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } } },
				},
			},
		],
		output: {
			data: {
				type: "login",
				name: "GitHub",
				urls: ["https://github.com"],
				username: "u",
				password: "pz",
				notes: "ny",
				partStampsAt: { wall: 40, counter: 1, node: "~merge:KTDk5XGpbTRQYNipPUmobw" },
				partStamps: {
					credential: { wall: 40, counter: 0, node: "c" },
					name: { wall: 10, counter: 0, node: "a" },
					notes: { wall: 30, counter: 0, node: "b" },
				},
				itemStamps: { urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } } },
				passwordChangelog: [{ value: "p", changedAt: 40 }],
			},
			hlc: { wall: 40, counter: 1, node: "~merge:KTDk5XGpbTRQYNipPUmobw" },
			causal: {
				vv: {
					a: { wall: 10, counter: 0, node: "a" },
					c: { wall: 40, counter: 0, node: "c" },
					b: { wall: 30, counter: 0, node: "b" },
					"~merge:KTDk5XGpbTRQYNipPUmobw": {
						wall: 40,
						counter: 1,
						node: "~merge:KTDk5XGpbTRQYNipPUmobw",
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
					hlc: { wall: 40, counter: 0, node: "c" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, c: { wall: 40, counter: 0, node: "c" } },
				},
				{
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 30, counter: 0, node: "b" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, b: { wall: 30, counter: 0, node: "b" } },
				},
			],
		},
	},
	passkeyAndUnknownField: {
		inputs: [
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 20, counter: 0, node: "a" },
					vv: { a: { wall: 20, counter: 0, node: "a" } },
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "p",
					notes: "n0",
					partStampsAt: { wall: 20, counter: 0, node: "a" },
					passkeys: [{ credentialId: "k1", rpId: "github.com", privateKey: "sk" }],
					partStamps: {
						credential: { wall: 10, counter: 0, node: "a" },
						name: { wall: 10, counter: 0, node: "a" },
						notes: { wall: 10, counter: 0, node: "a" },
					},
					itemStamps: { urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } } },
				},
			},
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 30, counter: 0, node: "b" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, b: { wall: 30, counter: 0, node: "b" } },
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "p",
					notes: "n0",
					partStampsAt: { wall: 30, counter: 0, node: "b" },
					futureField: { x: 1 },
					partStamps: {
						credential: { wall: 10, counter: 0, node: "a" },
						name: { wall: 10, counter: 0, node: "a" },
						notes: { wall: 10, counter: 0, node: "a" },
					},
					itemStamps: { urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } } },
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
				partStampsAt: { wall: 30, counter: 1, node: "~merge:LAS313DK8yJ0hYTksrnJsw" },
				futureField: { x: 1 },
				partStamps: {
					credential: { wall: 10, counter: 0, node: "a" },
					futureField: { wall: 30, counter: 0, node: "b" },
					name: { wall: 10, counter: 0, node: "a" },
					notes: { wall: 10, counter: 0, node: "a" },
				},
				itemStamps: {
					urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } },
					passkeys: { k1: { wall: 20, counter: 0, node: "a" } },
				},
				passkeys: [{ credentialId: "k1", rpId: "github.com", privateKey: "sk" }],
			},
			hlc: { wall: 30, counter: 1, node: "~merge:LAS313DK8yJ0hYTksrnJsw" },
			causal: {
				vv: {
					a: { wall: 20, counter: 0, node: "a" },
					b: { wall: 30, counter: 0, node: "b" },
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
					hlc: { wall: 30, counter: 0, node: "b" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, b: { wall: 30, counter: 0, node: "b" } },
				},
				{
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 20, counter: 0, node: "a" },
					vv: { a: { wall: 20, counter: 0, node: "a" } },
				},
			],
		},
	},
	olderBuildClearStays: {
		inputs: [
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 30, counter: 0, node: "a" },
					vv: { a: { wall: 30, counter: 0, node: "a" }, t: { wall: 20, counter: 0, node: "t" } },
				},
				data: {
					type: "login",
					name: "renamed",
					urls: ["https://github.com"],
					username: "u",
					password: "p",
					partStampsAt: { wall: 30, counter: 0, node: "a" },
					partStamps: { credential: { wall: 20, counter: 0, node: "t" } },
					itemStamps: { urls: { "https://github.com": { wall: 20, counter: 0, node: "t" } } },
				},
			},
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 25, counter: 0, node: "b" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, b: { wall: 25, counter: 0, node: "b" } },
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com", "https://gh.example"],
					username: "u",
					password: "p",
					notes: "codes",
					partStampsAt: { wall: 25, counter: 0, node: "b" },
					partStamps: {
						credential: { wall: 10, counter: 0, node: "a" },
						name: { wall: 10, counter: 0, node: "a" },
						notes: { wall: 10, counter: 0, node: "a" },
					},
					itemStamps: { urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } } },
				},
			},
		],
		output: {
			data: {
				type: "login",
				name: "renamed",
				urls: ["https://github.com", "https://gh.example"],
				username: "u",
				password: "p",
				partStampsAt: { wall: 30, counter: 1, node: "~merge:k9FJ4C0xPhWkDhaqZPc_3w" },
				partStamps: {
					credential: { wall: 20, counter: 0, node: "t" },
					name: { wall: 30, counter: 0, node: "a" },
				},
				itemStamps: {
					urls: {
						"https://github.com": { wall: 20, counter: 0, node: "t" },
						"https://gh.example": { wall: 25, counter: 0, node: "b" },
					},
				},
			},
			hlc: { wall: 30, counter: 1, node: "~merge:k9FJ4C0xPhWkDhaqZPc_3w" },
			causal: {
				vv: {
					a: { wall: 30, counter: 0, node: "a" },
					t: { wall: 20, counter: 0, node: "t" },
					b: { wall: 25, counter: 0, node: "b" },
					"~merge:k9FJ4C0xPhWkDhaqZPc_3w": {
						wall: 30,
						counter: 1,
						node: "~merge:k9FJ4C0xPhWkDhaqZPc_3w",
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
					hlc: { wall: 30, counter: 0, node: "a" },
					vv: { a: { wall: 30, counter: 0, node: "a" }, t: { wall: 20, counter: 0, node: "t" } },
				},
				{
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 25, counter: 0, node: "b" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, b: { wall: 25, counter: 0, node: "b" } },
				},
			],
		},
	},
	olderBuildNotesAndNewerUrl: {
		inputs: [
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 40, counter: 0, node: "t" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, t: { wall: 40, counter: 0, node: "t" } },
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com"],
					username: "u",
					password: "p",
					tags: ["t0"],
					partStampsAt: { wall: 10, counter: 0, node: "a" },
					notes: "older",
				},
			},
			{
				envelope: {
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 20, counter: 0, node: "b" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, b: { wall: 20, counter: 0, node: "b" } },
				},
				data: {
					type: "login",
					name: "GitHub",
					urls: ["https://github.com", "https://x.example"],
					username: "u",
					password: "p",
					tags: ["t0"],
					partStampsAt: { wall: 20, counter: 0, node: "b" },
					partStamps: {
						credential: { wall: 10, counter: 0, node: "a" },
						name: { wall: 10, counter: 0, node: "a" },
					},
					itemStamps: {
						urls: { "https://github.com": { wall: 10, counter: 0, node: "a" } },
						tags: { t0: { wall: 10, counter: 0, node: "a" } },
					},
				},
			},
		],
		output: {
			data: {
				type: "login",
				name: "GitHub",
				urls: ["https://github.com", "https://x.example"],
				username: "u",
				password: "p",
				tags: ["t0"],
				partStampsAt: { wall: 40, counter: 1, node: "~merge:ACy4efc0Tv4Eofy-GXXwwg" },
				notes: "older",
				partStamps: {
					credential: { wall: 40, counter: 0, node: "t" },
					name: { wall: 40, counter: 0, node: "t" },
					notes: { wall: 40, counter: 0, node: "t" },
				},
				itemStamps: {
					urls: {
						"https://github.com": { wall: 10, counter: 0, node: "a" },
						"https://x.example": { wall: 20, counter: 0, node: "b" },
					},
					tags: { t0: { wall: 10, counter: 0, node: "a" } },
				},
			},
			hlc: { wall: 40, counter: 1, node: "~merge:ACy4efc0Tv4Eofy-GXXwwg" },
			causal: {
				vv: {
					a: { wall: 10, counter: 0, node: "a" },
					t: { wall: 40, counter: 0, node: "t" },
					b: { wall: 20, counter: 0, node: "b" },
					"~merge:ACy4efc0Tv4Eofy-GXXwwg": {
						wall: 40,
						counter: 1,
						node: "~merge:ACy4efc0Tv4Eofy-GXXwwg",
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
					hlc: { wall: 40, counter: 0, node: "t" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, t: { wall: 40, counter: 0, node: "t" } },
				},
				{
					id: "e",
					wrappedDek: "w",
					dekIv: "d",
					ciphertext: "c",
					iv: "i",
					hlc: { wall: 20, counter: 0, node: "b" },
					vv: { a: { wall: 10, counter: 0, node: "a" }, b: { wall: 20, counter: 0, node: "b" } },
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
		expect(await combineSiblings(inputs as Sibling[])).toEqual(output);
	});
});
