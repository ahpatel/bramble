import { describe, expect, it } from "vitest";
import { readEditDraft } from "./edit-draft";

const opened = {
	hlc: { wall: 1000, counter: 0, node: "laptop" },
	vv: { laptop: { wall: 1000, counter: 0, node: "laptop" } },
	data: { id: "e", type: "login", name: "A", urls: [], username: "u", password: "p" },
};

describe("readEditDraft", () => {
	it("a draft from this build carries the opened version", () => {
		const values = { name: "A2", username: "u" };
		expect(readEditDraft({ values, opened })).toEqual({ values, opened });
	});

	it("a draft whose opened version is malformed keeps its values", () => {
		const values = { name: "A2" };
		expect(readEditDraft({ values, opened: { hlc: "x" } })).toEqual({ values });
	});

	it("a plain draft from the previous build restores its values", () => {
		const values = { name: "A2", username: "u", password: "p" };
		expect(readEditDraft(values)).toEqual({ values });
	});

	it("anything else restores nothing", () => {
		for (const draft of [undefined, null, "x", 3, ["a"]]) {
			expect(readEditDraft(draft)).toBeUndefined();
		}
	});
});
