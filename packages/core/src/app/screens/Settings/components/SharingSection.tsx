// Family sharing settings: enable sharing on this vault, and manage the
// collections that decide who can open what. The owner-side UI for the
// sharing layer; the member experience lives with the member join flow.
// See docs/adr/0001..0005 and vault/sharing-mutations.

import { Trans, useLingui } from "@lingui/react/macro";
import { FolderPlus, Pencil, Share2, Users } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { usePendingEnrollApproval } from "../../../../hooks/usePendingEnrollApproval";
import { useVault } from "../../../../hooks/useVault";
import { decryptWithKey } from "../../../../vault/sharing-crypto";
import {
	createCollection,
	removeMember,
	renameCollection,
} from "../../../../vault/sharing-mutations";
import { Button } from "../../../components/ui/button";
import { TextField } from "../../../components/ui/text-field";
import { useToast } from "../../../components/ui/toast";
import { Row, RowGroup, Section } from "./primitives";

/** The removal copy is load-bearing (ADR-0004): never imply a remote wipe. */
const REMOVE_COPY =
	"Remove this member? They will no longer receive updates. They keep copies of anything already synced — rotate the affected passwords after removing them.";

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
	const { sharing, runSharingTransition, enableSharing, inviteMember, isLocked } = useVault();
	const { t } = useLingui();
	const { show } = useToast();
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [inviteCode, setInviteCode] = useState<string | null>(null);

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

	const invite = () =>
		act(async () => {
			if (!sharing) return;
			const label = window.prompt(t`What should this person be called?`);
			if (!label?.trim()) return;
			// The relay comes from the sync settings (the hook resolves the stored one);
			// the invite reuses whatever relay this device already syncs through.
			const code = await inviteMember("", undefined, {
				sharing,
				memberLabel: label.trim(),
				persistWraps: async (wrapsJson: string) => {
					// The host registered the member; adopt its wraps and persist.
					const { sharingWrapFromWire } = await import("../../../../vault/member-invite");
					const wraps = JSON.parse(wrapsJson) as Parameters<typeof sharingWrapFromWire>[0][];
					await runSharingTransition(async () => ({
						...sharing,
						sharingWraps: wraps.map(sharingWrapFromWire),
					}));
				},
			});
			setInviteCode(code);
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
				{sharing.region.members.map((member) => (
					<Row
						key={member.id}
						icon={<Users className="w-4 h-4 text-primary" />}
						title={member.label ?? member.id.slice(0, 8)}
						subtitle={t`${sharing.region.collections.filter((c) => c.memberIds.includes(member.id)).length} collection(s)`}
					>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							aria-label={t`Remove member`}
							onClick={() => {
								// The honest copy (ADR-0004): removal stops future access;
								// it is not a remote wipe. The passwords must rotate.
								if (!window.confirm(REMOVE_COPY)) return;
								void act(async () => {
									await runSharingTransition((deps, state) => removeMember(deps, state, member.id));
								});
							}}
						>
							<Trans>Remove</Trans>
						</Button>
					</Row>
				))}
				<Row
					icon={<Users className="w-4 h-4 text-primary" />}
					title={t`Invite someone`}
					subtitle={t`In person: they scan the code, you both confirm the words, and they choose their own password.`}
				>
					<Button variant="secondary" size="sm" disabled={busy} onClick={() => void act(invite)}>
						<Trans>Invite</Trans>
					</Button>
				</Row>
			</RowGroup>
			{inviteCode && <InvitePanel code={inviteCode} onClose={() => setInviteCode(null)} />}
		</Section>
	);
}

/** The in-person invite: a QR the other device scans, plus the approval prompt
 * when it connects. Mirrors the device-invite panel's flow in compact form. */
function InvitePanel({ code, onClose }: { code: string; onClose: () => void }) {
	const { shell } = usePlatform();
	const [approval, setApproval] = usePendingEnrollApproval(shell, true);
	return (
		<div className="px-4 py-3 space-y-3 border-b border-border/50">
			<div className="flex justify-center p-2 bg-white rounded-lg w-fit mx-auto">
				<QRCodeSVG value={code} size={144} />
			</div>
			<p className="text-xs text-muted-foreground break-all font-mono">{code}</p>
			{approval ? (
				<div className="space-y-2">
					<p className="text-sm">
						<Trans>Confirm this code matches on their device:</Trans>{" "}
						<span className="font-mono font-semibold">{approval.sas}</span>
					</p>
					<div className="flex gap-2 justify-end">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setApproval(null);
								void shell.approveEnrollment?.(false);
							}}
						>
							<Trans>Deny</Trans>
						</Button>
						<Button
							size="sm"
							onClick={() => {
								setApproval(null);
								void shell.approveEnrollment?.(true);
							}}
						>
							<Trans>Approve</Trans>
						</Button>
					</div>
				</div>
			) : (
				<div className="flex justify-end">
					<Button variant="ghost" size="sm" onClick={onClose}>
						<Trans>Done</Trans>
					</Button>
				</div>
			)}
		</div>
	);
}
