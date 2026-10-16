// node --test scripts/nuke-artifacts.test.ts
//
// Runs against a scratch tree laid out like the repo, so what is deleted and what is kept is
// checked on real directories.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { nukeArtifacts } from "./nuke-artifacts.ts";

let root: string;

function touch(path: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), "x");
}

const TARGET = "packages/platform-desktop/src-tauri/target";
const PROXY = `${TARGET}/release/bundle/macos/Bramble.app/Contents/MacOS/bramble-proxy`;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "nuke-artifacts-"));
	touch("packages/core-rust/target/debug/libvault.rlib");
	touch("packages/platform-mobile/ios/DerivedData/Build/Products/App.app/App");
	touch(`${TARGET}/debug/bramble-desktop`);
	touch(`${TARGET}/x86_64-pc-windows-msvc/release/bramble-desktop.exe`);
	touch(`${TARGET}/release/deps/libtauri.rlib`);
	touch(`${TARGET}/release/bramble-desktop`);
	touch(PROXY);
	touch(`${TARGET}/release/bundle/dmg/Bramble.dmg`);
	// Neighbours that must survive.
	touch("desktop-updater-key.backup.age");
	touch("packages/platform-mobile/ios/App/VaultCryptoFFI/VaultCrypto.xcframework/Info.plist");
	touch("packages/core-rust/src/lib.rs");
});

describe("nukeArtifacts", () => {
	it("deletes the Rust target, iOS DerivedData, and the desktop build tree", () => {
		nukeArtifacts(root);

		assert.equal(existsSync(join(root, "packages/core-rust/target")), false);
		assert.equal(existsSync(join(root, "packages/platform-mobile/ios/DerivedData")), false);
		assert.equal(existsSync(join(root, `${TARGET}/debug`)), false);
		assert.equal(existsSync(join(root, `${TARGET}/x86_64-pc-windows-msvc`)), false);
		assert.equal(existsSync(join(root, `${TARGET}/release/deps`)), false);
		assert.equal(existsSync(join(root, `${TARGET}/release/bramble-desktop`)), false);
	});

	it("keeps the desktop app bundle the browsers' native-messaging host points into", () => {
		nukeArtifacts(root);

		assert.equal(existsSync(join(root, PROXY)), true);
		assert.equal(existsSync(join(root, `${TARGET}/release/bundle/dmg/Bramble.dmg`)), true);
	});

	it("touches nothing else", () => {
		nukeArtifacts(root);

		assert.equal(existsSync(join(root, "desktop-updater-key.backup.age")), true);
		assert.equal(
			existsSync(
				join(
					root,
					"packages/platform-mobile/ios/App/VaultCryptoFFI/VaultCrypto.xcframework/Info.plist",
				),
			),
			true,
		);
		assert.equal(existsSync(join(root, "packages/core-rust/src/lib.rs")), true);
	});

	it("reports what it removed, and is a no-op when there is nothing to remove", () => {
		const first = nukeArtifacts(root);
		assert.ok(first.includes(join(root, "packages/core-rust/target")));
		assert.ok(first.includes(join(root, `${TARGET}/debug`)));

		assert.deepEqual(nukeArtifacts(root), []);
	});
});
