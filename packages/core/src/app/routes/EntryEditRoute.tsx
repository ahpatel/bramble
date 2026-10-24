import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { type EntryData, useVault } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { getEntryMode } from "../entry-modes";
import { usePopOut } from "../hooks/usePopOut";
import { takeTotpForEntry } from "../pending-totp";
import { EntryForm, type EntryFormDraft } from "../screens/CreateEntry/EntryForm";
import { type EditDraft, readEditDraft } from "./edit-draft";

/** Edit route for an existing entry; restores pop-out drafts and re-checks breach on password change. */
export function EntryEditRoute() {
	const navigate = useNavigate();
	const { entryId } = useParams({ from: "/_app/vault/$entryId/edit" });
	const { entries, updateEntry, openVersion } = useVault();
	const { prefs } = usePrefs();
	const { registerDraftGetter, takeInitialDraft } = usePopOut();
	// Pop-out draft takes precedence over the stored entry; consumed once on mount.
	const [draft] = useState(() => readEditDraft(takeInitialDraft()));
	// The version the form opened, which the save supersedes; a pop-out keeps the original's.
	const [opened] = useState(() => draft?.opened ?? openVersion(entryId));
	const registerDraft = useCallback(
		(getter: (() => EntryFormDraft) | null) =>
			registerDraftGetter(getter && ((): EditDraft => ({ values: getter(), opened }))),
		[registerDraftGetter, opened],
	);
	// An authenticator key routed here from the TOTP setup screen. Seeded into the form
	// rather than written: an OS handoff never saves on its own. See docs/totp-uri-handler.md.
	const [handedTotp] = useState(() => takeTotpForEntry(entryId));
	const stored = entries.find((e) => e.id === entryId);

	if (!stored) return null;

	const entry = handedTotp && stored.type === "login" ? { ...stored, totp: handedTotp } : stored;

	const mode = getEntryMode(entry.type);

	const handleSave = async (data: EntryData) => {
		const before = opened?.data ?? entry;
		// Re-check breach only when a login's password changed; reuse the cached value otherwise.
		if (data.type === "login" && before.type === "login") {
			const passwordChanged = data.password !== before.password;
			const breach =
				passwordChanged && prefs.breachCheckEnabled
					? await checkPasswordBreach(data.password)
					: before.breach;
			await updateEntry(entryId, { ...data, breach }, opened);
			return;
		}
		await updateEntry(entryId, data, opened);
	};

	// pb-3 balances EntryForm's pt-3: the card is height-capped here and scrolls internally.
	return (
		<div className="flex-1 min-h-0 flex flex-col pb-3">
			<EntryForm
				key={entry.type}
				type={entry.type}
				initialEntry={entry}
				initialBreach={
					prefs.breachCheckEnabled && entry.type === "login" ? entry.breach : undefined
				}
				draftValues={draft?.values}
				registerDraft={registerDraft}
				submitLabel={`Update ${mode.label}`}
				onBack={() => navigate({ to: "/vault/$entryId", params: { entryId } })}
				onSave={handleSave}
			/>
		</div>
	);
}
