// Share and unshare: the collection-granting actions for the selection
// toolbar. Both require a sharing-enabled vault — the action hides itself
// otherwise, since the toolbar can't know the vault state ahead of the menu.
// See docs/adr/0001 (grant model) and docs/adr/0005 (owner-only grants).

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Share2, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useVault } from "../../hooks/useVault";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import type { BulkAction, BulkActionDialogProps } from "./types";

function dialogFor(mode: "share" | "unshare") {
	return function ShareDialog({ open, onClose, onDone, ids }: BulkActionDialogProps) {
		const { sharing: sharingLayer, shareEntries, unshareEntries } = useVault();
		const [error, setError] = useState<string | null>(null);
		const [picked, setPicked] = useState<string | null>(null);
		const isShare = mode === "share";

		if (!sharingLayer) {
			return (
				<ConfirmDialog
					open={open}
					onClose={onClose}
					title={isShare ? <Trans>Share</Trans> : <Trans>Unshare</Trans>}
					confirmLabel={<Trans>OK</Trans>}
					busyLabel={<Trans>Working…</Trans>}
					onConfirm={() => {
						onDone();
						return Promise.resolve();
					}}
				>
					<p className="text-sm text-muted-foreground">
						<Trans>Sharing is not enabled on this vault yet. Turn it on in Settings.</Trans>
					</p>
				</ConfirmDialog>
			);
		}

		const collections = sharingLayer.region.collections;
		// For unshare, only collections that actually contain at least one of the
		// selected entries can change anything.
		const relevant = isShare
			? collections
			: collections.filter((c: (typeof collections)[number]) =>
					sharingLayer.region.wrappers.some(
						(w) => w.collectionId === c.id && ids.includes(w.entryId),
					),
				);
		const list = relevant;

		const run = async () => {
			if (!picked) return;
			setError(null);
			try {
				if (isShare) await shareEntries(ids, picked);
				else await unshareEntries(ids, picked);
				onDone();
			} catch (e) {
				setError(e instanceof Error ? e.message : null);
			}
		};

		return (
			<ConfirmDialog
				open={open}
				onClose={onClose}
				title={isShare ? <Trans>Share with a collection</Trans> : <Trans>Unshare</Trans>}
				confirmLabel={
					isShare ? (
						<Plural value={ids.length} one="Share # entry" other="Share # entries" />
					) : (
						<Plural value={ids.length} one="Unshare # entry" other="Unshare # entries" />
					)
				}
				busyLabel={<Trans>Sharing…</Trans>}
				onConfirm={run}
			>
				{list.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{isShare ? (
							<Trans>No collections yet. Create one in Settings &rarr; Family sharing.</Trans>
						) : (
							<Trans>None of the selected entries are in a collection.</Trans>
						)}
					</p>
				) : (
					<>
						<div className="space-y-1.5">
							{list.map((c) => (
								<Button
									key={c.id}
									variant={picked === c.id ? "secondary" : "ghost"}
									size="sm"
									className="w-full justify-start"
									onClick={() => setPicked(c.id)}
								>
									<CollectionName collectionId={c.id} fallback={c.id} />
								</Button>
							))}
						</div>
						{!isShare && (
							<p className="text-xs text-muted-foreground">
								<Trans>
									Sharing stops here. Anyone who already has a copy keeps it — rotate the password
									if that matters.
								</Trans>
							</p>
						)}
					</>
				)}
				{error && <p className="text-sm text-destructive">{error}</p>}
			</ConfirmDialog>
		);
	};
}

/** The collection label is sealed under the collection key; the owner holds
 * every key, so decrypt it. Falls back to the id while loading. */
function CollectionName({ collectionId, fallback }: { collectionId: string; fallback: string }) {
	const { sharing } = useVault();
	const [name, setName] = useState<string | null>(null);
	const collection = sharing?.region.collections.find((c) => c.id === collectionId);
	const key = sharing?.collectionKeys[collectionId];
	useEffect(() => {
		if (!collection || !key) return;
		let cancelled = false;
		import("../../vault/sharing-crypto").then(({ decryptWithKey }) =>
			decryptWithKey(key, collection.labelIv, collection.labelCiphertext)
				.then((n) => !cancelled && setName(n))
				.catch(() => !cancelled && setName(fallback)),
		);
		return () => {
			cancelled = true;
		};
	}, [collection, key, fallback]);
	return <>{name ?? fallback}</>;
}

export const shareAction: BulkAction = {
	id: "share",
	get label() {
		return i18n._(msg`Share…`);
	},
	icon: Share2,
	Dialog: dialogFor("share"),
};

export const unshareAction: BulkAction = {
	id: "unshare",
	get label() {
		return i18n._(msg`Unshare…`);
	},
	icon: ShieldOff,
	Dialog: dialogFor("unshare"),
};
