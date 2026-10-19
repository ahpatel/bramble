/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextArea } from "./text-area";

// happy-dom has no layout: model scrollHeight as rows-or-lines of 20px plus 24px padding.
const LINE = 20;
const PAD = 24;
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const px = (rows: number) => `${rows * LINE + PAD}px`;

function stubScrollHeight(get: (el: HTMLTextAreaElement) => number) {
	Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
		configurable: true,
		get(this: HTMLTextAreaElement) {
			return get(this);
		},
	});
}

beforeEach(() =>
	stubScrollHeight((el) => Math.max(el.rows, el.value.split("\n").length) * LINE + PAD),
);
afterEach(() => {
	cleanup();
	Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
});

type Values = { notes: string };

function renderNotes(notes = "") {
	const form: { current?: UseFormReturn<Values> } = {};
	function Notes() {
		const methods = useForm<Values>({ defaultValues: { notes } });
		form.current = methods;
		return <TextArea label="Notes" rows={3} autoGrow {...methods.register("notes")} />;
	}
	render(<Notes />);
	return { textarea: screen.getByLabelText("Notes") as HTMLTextAreaElement, form: form.current! };
}

describe("TextArea autoGrow", () => {
	it("sizes a long stored note on load, with no input event", () => {
		const { textarea } = renderNotes(lines(30));
		expect(textarea.value).toBe(lines(30));
		expect(textarea.style.height).toBe(px(30));
	});

	it("grows with typing and shrinks back to the rows minimum", () => {
		const { textarea, form } = renderNotes();
		expect(textarea.style.height).toBe(px(3));

		fireEvent.input(textarea, { target: { value: lines(12) } });
		expect(textarea.style.height).toBe(px(12));
		expect(form.getValues("notes")).toBe(lines(12));

		fireEvent.input(textarea, { target: { value: "one line" } });
		expect(textarea.style.height).toBe(px(3));
		expect(textarea.parentElement?.style.minHeight).toBe("");
	});

	it("refits when the form resets or sets the value", () => {
		const { textarea, form } = renderNotes();

		act(() => form.setValue("notes", lines(20)));
		expect(textarea.style.height).toBe(px(20));

		act(() => form.reset({ notes: lines(25) }));
		expect(textarea.value).toBe(lines(25));
		expect(textarea.style.height).toBe(px(25));

		act(() => form.reset({ notes: "" }));
		expect(textarea.style.height).toBe(px(3));
	});

	it("scrolls only once the content passes the max height", () => {
		// Inline max-height stands in for the max-h class; happy-dom loads no CSS.
		render(<TextArea label="Notes" rows={3} autoGrow style={{ maxHeight: "300px" }} />);
		const textarea = screen.getByLabelText("Notes") as HTMLTextAreaElement;
		expect(textarea.className).toContain("max-h-");

		fireEvent.input(textarea, { target: { value: lines(10) } });
		expect(textarea.style.overflowY).toBe("hidden");

		fireEvent.input(textarea, { target: { value: lines(30) } });
		expect(textarea.style.height).toBe(px(30));
		expect(textarea.style.overflowY).toBe("auto");

		fireEvent.input(textarea, { target: { value: lines(2) } });
		expect(textarea.style.overflowY).toBe("hidden");
	});

	it("keeps the rows height while it has no layout to measure", () => {
		stubScrollHeight(() => 0);
		const { textarea } = renderNotes(lines(30));
		expect(textarea.style.height).toBe("auto");
	});

	it("is opt-in", () => {
		render(<TextArea label="Public key" rows={2} />);
		const textarea = screen.getByLabelText("Public key") as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: lines(30) } });
		expect(textarea.style.height).toBe("");
		expect(textarea.className).not.toContain("max-h-");
	});
});
