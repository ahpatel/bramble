// The edit route's pop-out draft: the form's values plus the version the form opened, so a save
// from the detached window still supersedes that version (docs/sync-conflicts.md, "Saving the edit
// form"). The previous build handed over the bare form values.

import { z } from "zod";
import { HlcSchema, VersionVectorSchema } from "../../sync";
import type { OpenedVersion } from "../../vault/entry-mutations";
import type { EntryFormDraft } from "../screens/CreateEntry/EntryForm";

export interface EditDraft {
	values: EntryFormDraft;
	opened?: OpenedVersion;
}

const OpenedVersionSchema = z.object({
	hlc: HlcSchema,
	vv: VersionVectorSchema.optional(),
	floor: HlcSchema.optional(),
	data: z.looseObject({ id: z.string(), type: z.string() }),
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** The draft a pop-out window opened with, in this build's shape or the previous build's. */
export function readEditDraft(draft: unknown): EditDraft | undefined {
	if (!isRecord(draft)) return undefined;
	const keys = Object.keys(draft);
	const wrapped = isRecord(draft.values) && keys.every((k) => k === "values" || k === "opened");
	if (!wrapped) return { values: draft };
	const opened = OpenedVersionSchema.safeParse(draft.opened);
	return opened.success
		? { values: draft.values as EntryFormDraft, opened: opened.data as unknown as OpenedVersion }
		: { values: draft.values as EntryFormDraft };
}
