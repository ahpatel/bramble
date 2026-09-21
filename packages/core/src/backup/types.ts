// Types for the cloud backup storage layer. A BackupTarget is the minimal
// object-store surface the orchestrator needs; S3 and WebDAV both implement it.
// See docs/cloud-storage-backups.md.

import type { HttpRequest, HttpResponse, HttpTransport } from "../adapters/http";

export interface BackupObject {
	key: string;
	size: number;
	lastModified?: string;
}

export interface BackupTarget {
	put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
	get(key: string): Promise<Uint8Array>;
	list(prefix: string): Promise<BackupObject[]>;
	remove(key: string): Promise<void>;
}

export type BackupHttpRequest = HttpRequest;
export type BackupHttpResponse = HttpResponse;

/**
 * How a provider's requests actually reach the network, and who authenticates them.
 *
 * The platform's `HttpTransport` under a name that says what it carries, plus one rule the
 * generic one does not have: a backup transport OWNS the credentials. A provider builds an
 * unauthenticated request and the transport adds the auth.
 *
 * That is what lets the desktop pass its own, which hands the request to Rust: its webview
 * cannot reach a provider at all (no S3 endpoint or WebDAV server grants CORS to
 * `tauri://localhost`) and its credentials live in the OS credential store, so the only place
 * that CAN authenticate a request is the Rust side. Signing in JS and sending over a native
 * transport is the other valid split, for a platform that cannot reach a provider but has no
 * credential store to keep its secrets out of the webview either.
 */
export type BackupTransport = HttpTransport;

/** Decode a response body as text (XML listings, error documents). */
export function responseText(res: BackupHttpResponse): string {
	return new TextDecoder().decode(res.body);
}

export interface S3Config {
	kind: "s3";
	endpoint: string; // e.g. https://s3.us-west-002.backblazeb2.com
	region: string;
	bucket: string;
	prefix?: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export interface WebdavConfig {
	kind: "webdav";
	serverUrl: string; // e.g. https://host/remote.php/dav/files/me/
	// No folder field: the user's folder is the object-key prefix (see backupPrefix),
	// so it arrives in the keys rather than being baked into the base URL.
	username: string;
	password: string;
}

export interface DropboxConfig {
	kind: "dropbox";
	refreshToken: string; // long-lived; mints access tokens on demand
	accessToken?: string; // optional warm token, else minted lazily from the refresh token
	path?: string; // optional subfolder within the connected app folder
}

export type ProviderConfig = S3Config | WebdavConfig | DropboxConfig;
