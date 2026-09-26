/**
 * Which backup targets a run started outside the settings screen is uploading right now, so the
 * screen can say "Backing up" for work it did not start. Mobile runs backups on unlock and on
 * resume, from outside React; without this an automatic run was invisible while it happened.
 *
 * `subscribe` calls back immediately with the current set, then on every change.
 */
export interface BackupActivityAdapter {
	subscribe(callback: (runningTargetIds: ReadonlySet<string>) => void): () => void;
}
