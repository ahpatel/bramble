/**
 * How an outbound request actually reaches the network on this platform.
 *
 * Absent from a `Platform` means the webview can simply `fetch`, which is the extension (a
 * background worker holding `<all_urls>` bypasses CORS) and the dev browser. The desktop and
 * mobile provide one, because their webviews cannot reach an arbitrary provider at all: no S3
 * endpoint, WebDAV server, or CORS-less API grants anything to `tauri://localhost` or
 * `capacitor://localhost`.
 *
 * Two rules hold in every implementation, the native ones included, and they are why this is an
 * interface rather than a per-platform `fetch` wrapper:
 *
 * - **No ambient cookies.** The only credential is the header the caller set. A browser session
 *   for the same host has already outranked an `Authorization` header here once (1255ab7b, where
 *   an open Nextcloud tab made correct WebDAV credentials surface as a 401).
 * - **No redirect following.** A redirect out of an API call means the session was rejected and
 *   the destination is an HTML login page with no CORS, so chasing it turns a clean "bad key"
 *   into an opaque failure. A 3xx comes back as itself.
 *
 * See docs/email-aliases.md and docs/cloud-storage-backups.md.
 */
export interface HttpTransport {
	send(req: HttpRequest): Promise<HttpResponse>;
}

export interface HttpRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: Uint8Array;
}

/** Body arrives whole: these are API replies and vault blobs, never a stream. */
export interface HttpResponse {
	status: number;
	ok: boolean;
	body: Uint8Array;
}

/**
 * The default, for platforms that can reach a provider from the process they run in.
 *
 * `redirect: "manual"` surfaces a redirect as an opaque response with status 0 rather than a
 * 3xx, so callers distinguishing the two should treat 0 as a redirect as well. A native
 * transport, having no opaque responses, returns the real status instead.
 */
export const fetchTransport: HttpTransport = {
	async send({ method, url, headers, body }) {
		const res = await fetch(url, {
			method,
			headers,
			body: body as BodyInit | undefined,
			credentials: "omit",
			redirect: "manual",
		});
		return {
			status: res.status,
			ok: res.ok,
			body: new Uint8Array(await res.arrayBuffer()),
		};
	},
};
