// Family sharing settings: enable sharing on this vault, and manage the
// collections that decide who can open what. The owner-side UI for the
// sharing layer; the member experience lives with the member join flow.
// See docs/adr/0001..0005 and vault/sharing-mutations.

import { Trans, useLingui } from "@lingui/react/macro";
import { FolderPlus, Pencil, Share2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useVault } from "../../../../hooks/useVault";
import { decryptWithKey } from "../../../../vault/sharing-crypto";
import { createCollection, renameCollection } from "../../../../vault/sharing-mutations";
import { Button } from "../../../components/ui/button";
import { TextField } from "../../../components/ui/text-field";
import { useToast } from "../../../components/ui/toast";
import { Row, RowGroup, Section } from "./primitives";

/** Decrypts a collection label for display; the owner always holds the key. */
function CollectionLabel({
	collectionKey,
	labelIv,
	labelCiphertext,
	fallback,
}: {
	collectionKey: string | undefined;
	labelIv: string;
	labelCiphertext: string;
	fallback: string;
}) {
	const [label, setLabel] = useState<string | null>(null);
	useEffect(() => {
		if (!collectionKey) return;
		let cancelled = false;
		decryptWithKey(collectionKey, labelIv, labelCiphertext)
			.then((l) => {
				if (!cancelled) setLabel(l);
			})
			.catch(() => {
				if (!cancelled) setLabel(fallback);
			});
		return () => {
			cancelled = true;
		};
	}, [collectionKey, labelIv, labelCiphertext, fallback]);
	return <span>{label ?? fallback}</span>;
}

export function SharingSection() {
	const { sharing, runSharingTransition, enableSharing, isLocked } = useVault();
	const { t } = useLingui();
	const { show } = useToast();
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);

	const act = async (fn: () => Promise<void>) => {
		setBusy(true);
		try {
			await fn();
		} catch (e) {
			show({
				message: e instanceof Error ? e.message : t`Something went wrong.`,
				variant: "error",
			});
		} finally {
			setBusy(false);
		}
	};

	const createNew = () =>
		act(async () => {
			await runSharingTransition((deps, state) => createCollection(deps, state, name.trim()));
			setCreating(false);
			setName("");
		});

	// Locked or not sharing-enabled: a single row that turns sharing on.
	if (isLocked || !sharing) {
		return (
			<Section icon={<Users className="w-4 h-4 text-primary" />} title={t`Family sharing`}>
				<RowGroup label={t`Sharing`}>
					<Row
						icon={<Users className="w-4 h-4 text-primary" />}
						title={t`Share entries with family`}
						subtitle={
							isLocked
								? t`Unlock this vault to manage sharing.`
								: t`Create collections of entries and share each with specific people. Everyone keeps their own password; no account, no server.`
						}
					>
						{!isLocked && (
							<Button
								variant="secondary"
								size="sm"
								disabled={busy}
								onClick={() => void act(enableSharing)}
							>
								<Trans>Enable sharing</Trans>
							</Button>
						)}
					</Row>
				</RowGroup>
				<p className="px-4 pb-3 text-xs text-muted-foreground">
					<Trans>
						Once sharing is on, update Bramble on your other devices before syncing again — an
						out-of-date device can no longer open this vault.
					</Trans>
				</p>
			</Section>
		);
	}

	return (
		<Section icon={<Users className="w-4 h-4 text-primary" />} title={t`Family sharing`}>
			{creating && (
				<div className="px-4 py-3 space-y-2 border-b border-border/50">
					<TextField
						label={t`Collection name`}
						value={name}
						onChange={(e) => setName(e.target.value)}
						autoFocus
					/>
					<div className="flex gap-2 justify-end">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setCreating(false);
								setName("");
							}}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button size="sm" disabled={busy || !name.trim()} onClick={() => void createNew()}>
							<Trans>Create</Trans>
						</Button>
					</div>
				</div>
			)}
			<RowGroup label={t`Collections`}>
				{sharing.region.collections.map((collection) => (
					<Row
						key={collection.id}
						icon={<Share2 className="w-4 h-4 text-primary" />}
						title={
							<CollectionLabel
								collectionKey={sharing.collectionKeys[collection.id]}
								labelIv={collection.labelIv}
								labelCiphertext={collection.labelCiphertext}
								fallback={collection.id}
							/>
						}
						subtitle={t`${collection.memberIds.length} member(s) · ${
							sharing.region.wrappers.filter((w) => w.collectionId === collection.id).length
						} entries`}
					>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							aria-label={t`Rename collection`}
							onClick={() =>
								void act(async () => {
									const next = window.prompt(t`New name`);
									if (!next?.trim()) return;
									await runSharingTransition((deps, state) =>
										renameCollection(deps, state, collection.id, next.trim()),
									);
								})
							}
						>
							<Pencil className="w-4 h-4" />
						</Button>
					</Row>
				))}
				{sharing.region.collections.length === 0 && (
					<p className="px-4 text-xs text-muted-foreground">
						<Trans>No collections yet. Create one, then share entries into it.</Trans>
					</p>
				)}
				<Row
					icon={<FolderPlus className="w-4 h-4 text-primary" />}
					title={t`New collection`}
					subtitle={t`A named set of entries, shared with the people you pick.`}
				>
					<Button variant="secondary" size="sm" disabled={busy} onClick={() => setCreating(true)}>
						<Trans>Create</Trans>
					</Button>
				</Row>
			</RowGroup>
			<RowGroup label={t`People`}>
				<Row
					icon={<Users className="w-4 h-4 text-primary" />}
					title={t`Invite someone`}
					subtitle={t`In person: they scan the code, you both confirm the words, and they choose their own password.`}
				>
					<Button variant="secondary" size="sm" disabled>
						<Trans>Coming soon</Trans>
					</Button>
				</Row>
			</RowGroup>
		</Section>
	);
}
