# How established E2EE password managers model per-member sharing

Researched against primary sources (official security whitepapers, first-party docs, and implementation code) to inform Bramble's per-entry sharing design (one vault; entries shared with dad only / wife only; collection keys wrapped per member; revocation by rotating the collection key).

## Bottom line

Every major end-to-end-encrypted password manager converges on one skeleton: content is encrypted with a random symmetric key, and that key is **wrapped once per member under the member's long-term public key** (RSA-OAEP in Bitwarden and 1Password; OpenPGP/ECC in Passbolt and Proton Pass). The systems differ in *where the first-level key sits*: Bitwarden uses a single organization key per org — collections are access control only, **not** cryptographic boundaries; 1Password and Proton Pass put a key per vault, wrapped per member; Passbolt has no intermediate key at all and encrypts every secret separately for every recipient. None of them cryptographically enforces revocation: Bitwarden has no org-key rotation and tells you to change the credentials themselves; 1Password documents that removal is server policy plus client erasure, with "make a new vault" as the only real re-key; Passbolt just deletes the recipient's copies; Proton removes share access server-side and (like all four) recommends rotating the actual password after revoking. This settles three things for Bramble: (1) collection keys wrapped per member is the established, defensible layer — it is exactly Proton's share-key model and strictly stronger than Bitwarden's org-key model; (2) "revocation" must be honestly defined as rotate-and-rewrap plus treating already-viewed secrets as burned; (3) storing per-recipient wrapped-key blobs on a server/relay for offline members is what all four systems do — Bramble's Durable Object doing the same is normal, not a departure.

---

## 1. Bitwarden

### Wrapping tree

```
Master password ──PBKDF2/HKDF──> Stretched Master Key
                                      │ wraps
                                      ▼
                          User Symmetric Key (account encryption key, 512-bit)
                                      │ wraps (RSA-OAEP to member's RSA public key)
                          Organization Symmetric Key  ◄── ONE key per organization
                                      │ wraps
             ┌────────────────────────┼──────────────────────────────┐
             ▼                        ▼                              ▼
   Cipher Key (64-byte,      Collection NAME (no            Attachment Key
   one per vault item)       collection key exists)         (attachment name/size
             │                                              under Cipher Key)
             ▼
   Item content (AES-256-CBC + HMAC)
```

- Org creation: a CSPRNG generates the **Organization Symmetric Key**; it is encrypted with the creator's RSA public key (RSA-OAEP) and stored server-side as the *Protected Organization Symmetric Key*. The unprotected org key is never stored server-side. https://bitwarden.com/help/bitwarden-security-white-paper/ (§Sharing data between users)
- Member onboarding: an established member's client fetches the new user's RSA public key and encrypts the org key with it; each member has a unique wrapped copy. https://bitwarden.com/help/bitwarden-security-white-paper/ (§When users join an organization)
- **Every vault item has its own random 64-byte Cipher Key**, encrypted with the User Symmetric Key (individual items) or the Organization Symmetric Key (org items). Attachment metadata (file name, size) is encrypted under the Cipher Key, which also wraps the Attachment Key that encrypts the file data. Added to the whitepaper 2024-07-25 (document changelog) and shipped as the "Vault item keys" release-note feature. https://bitwarden.com/help/bitwarden-security-white-paper/ (§How vault data is encrypted); https://bitwarden.com/help/releasenotes/
- **Collections have no key of their own.** The server entity is just `Id / OrganizationId / Name (encrypted) / ExternalId / dates / flags` — no key column: https://github.com/bitwarden/server/blob/main/src/Core/AdminConsole/Entities/Collection.cs. Org items are "encrypted with the Organization's key": https://bitwarden.com/blog/making-the-move-with-organization-sharing. Consequence (stated bluntly by the independent Vaultwarden implementation): "There is no per-collection key; there is a single organization key used to encrypt all entries (in any collection) belonging to that org" — https://vaultwarden.discourse.group/t/security-aspects-of-removing-a-user-from-an-organization-or-collection/1267. **Collections are authorization-layer partitions over one shared org key.**
- Sharing an item = *moving* it into the organization: ownership transfers to the org and the client re-encrypts the item under a Cipher Key wrapped by the org key. https://bitwarden.com/blog/making-the-move-with-organization-sharing
- Wrapping algorithm: RSA-OAEP ("Bitwarden uses the RSA cryptosystem with Optimal Asymmetric Encryption Padding"); AES-256-CBC + HMAC-SHA256 for data. https://bitwarden.com/help/what-encryption-is-used/
- The "2023 account-keys change": **no RSA→X25519/Ed25519 migration exists in any primary source** (whitepaper 2026 revision, encryption doc, and `org:bitwarden` code all still specify RSA-OAEP; a GitHub code search for `x25519` in `org:bitwarden` matches only the unrelated `agent-access`/`credential-exchange` projects). The account-key change that *did* ship is the **legacy user key migration**: accounts created before 2021 held a master-password-derived key directly and must migrate to the modern scheme (random account key wrapped under the HKDF-stretched master key); self-hosted server 2025.1.3 forces the login-time migration. https://bitwarden.com/help/releasenotes/ (2025.1.x notes); whitepaper §Account creation.

### Add a member

Wrap the org key once for the new member (one RSA encryption). No per-item or per-collection work. https://bitwarden.com/help/bitwarden-security-white-paper/ (§When users join an organization)

### Revoke a member — cost and honest limits

- Removal is server-side only; **no key is changed and there is no supported organization-key rotation** (only per-user account-key rotation exists, which re-encrypts that user's *own* vault data: https://bitwarden.com/help/account-encryption-key/).
- Bitwarden's official guidance: "Removing a user from Bitwarden, and their access to credentials, does not change the password for an item that they may have formerly had access to... Therefore such credentials should be changed whenever access is removed." https://bitwarden.com/blog/making-the-move-with-organization-sharing
- Removed members keep their personal "My vault" items; org-owned collections/items become inaccessible. Offline devices "cache a read-only copy of data, including organization items" and "may retain access to this read-only data for a short time after a member is removed." https://bitwarden.com/help/remove-users/ ; https://bitwarden.com/help/onboarding-and-succession/
- Extra power to note for a family: with **account recovery** enrolled, the member's User Symmetric Key is encrypted with the organization's RSA public key, so an org admin can decrypt a member's account (and vault). https://bitwarden.com/help/bitwarden-security-white-paper/ (§Account recovery)

### Server-visible metadata

Encrypted (client-side, per https://bitwarden.com/help/vault/): item names, notes, usernames, passwords, URIs, TOTP secrets, custom fields, attachment names and contents, folder names, **collection names**. Plaintext server-side: email, name, device GUID, billing, org name/plan/seat counts, admin emails (https://bitwarden.com/help/administrative-data/); event logs including IP addresses for Teams/Enterprise (same page); the *number of items* in an account (whitepaper §Data types and data retention); and all relationships — which items sit in which collections, which members/groups can access them, org membership.

### Published analysis

Third-party audits are annual (whitepaper §Code assessments); the 2021 assessment discusses admin-reset power over member vaults: https://assets.ctfassets.net/7rncvj1f8mw7/7FvIxrQGKRiVlhgXHdvYee/52f01c770267729a015257b03897f195/2021-bitwarden-security-assessment-report.pdf. No public cryptographic critique of the org-key design found; the strongest statements about its limits are Bitwarden's own (revoke ⇒ rotate credentials) and Vaultwarden's (no per-collection key).

## 2. 1Password

### Wrapping tree

```
Account password + 128-bit Secret Key ──2SKD (PBKDF2 650k + HKDF)──> Account Unlock Key (KEK)
                                                                          │ encrypts
                                                              User key set (JWK bundle):
                                                                RSA-2048 key pair (OAEP)
                                                                + AES-256-GCM symmetric key
                                                                          │ public key wraps
                                                                    Vault Key (32-byte, one per vault)
                                                                          │ encrypts
                                                              Item overview (title/URLs/tags)
                                                              Item details (password/notes)
                                                          (+ vault key copy wrapped to
                                                           Recovery Group public key)
```

- Items are encrypted with a per-vault 32-byte key generated on-device; overviews and details are encrypted *separately* with the same vault key so lists can render without decrypting everything. https://agilebits.github.io/security-design/secureItems.html
- "If you have access to a vault, a copy of the vault key is encrypted with your public key." Private key is encrypted with the KEK derived from account password + Secret Key. Sharing = encrypting the vault key with the recipient's public key; the server never holds a decrypted vault key. https://agilebits.github.io/security-design/sharedVaults.html
- Groups (incl. the Recovery Group) have their own key pairs; vault keys are additionally wrapped to group public keys, which is how recovery works and why recovery-group members can decrypt anything they can obtain ciphertext for. https://agilebits.github.io/security-design/secureItems.html (Story 4); https://agilebits.github.io/security-design/leopard.html (§A.2)
- Public-key crypto is RSA-OAEP 2048 (e=65537); symmetric is AES-256-GCM; key sets are JWK bundles designed to allow algorithm migration. https://agilebits.github.io/security-design/secureItems.html (§5.2)

### Add a member

One operation: encrypt a copy of the vault key with the new member's public key. https://agilebits.github.io/security-design/sharedVaults.html

### Revoke a member — cost and honest limits

- 1Password is unusually candid: "Removing someone from a vault, group, or team isn't cryptographically enforced. **Cryptographic keys are not changed.**" Removal deletes the member's wrapped vault-key copy, stops serving vault data, and pushes a client policy telling the (well-behaved) client to erase cached keys/data. https://agilebits.github.io/security-design/revoke-access.html ; https://agilebits.github.io/security-design/leopard.html (§A.4.1, Story 10)
- Documented residual risk: a member who saved their keys before removal and later obtains encrypted vault data (e.g., from another member's poorly secured device) can decrypt **all future data** in that vault. Documented mitigation: "create a new vault (which will have a new key), and move items from the old vault to the new one." https://agilebits.github.io/security-design/leopard.html (§A.4.1–A.4.2)

### Server-visible metadata

The whitepaper enumerates the cleartext columns: team domain/name/avatars, group names/descriptions, user full names, emails, avatars, public keys, IP addresses, device makes/models/OS, MFA secrets. Item titles, URLs, and vault names are encrypted (overview/details/vault-name are ciphertext; "vault title encryption" is a marketed differentiator). https://agilebits.github.io/security-design/infra.html ; https://support.1password.com/files/msp/1password-security.pdf. The server can also confirm whether a given email belongs to a team ("revealing who is registered" — a conceded design flaw): https://agilebits.github.io/security-design/leopard.html (§A.11)

### Published critique — their own appendix

The "Beware of the leopard" appendix is the best self-critique in the industry and directly relevant to Bramble: (A.3) **there is no user-verifiable binding of public keys to people** — a malicious/compromised server can hand out fake public keys and MITM the vault-key wrapping ("it would be possible for the 1Password server to acquire vault encryption keys with little ability for users to detect or prevent it"). https://agilebits.github.io/security-design/leopard.html (§A.3) and https://agilebits.github.io/security-design/mitm.html

## 3. Passbolt

### Wrapping tree

```
Per-user OpenPGP key pair (passphrase-protected, generated on device)
        │  encrypt+sign, once per recipient — for EVERY shared secret
        ▼
Secret (password/TOTP/note) ── one PGP message per user with access
Resource metadata (name, username, URI, description)
        ├── legacy/v4: plaintext server-side ("searchable non encrypted metadata")
        └── v5.1+ (opt-in): encrypted with the user's personal key
            or a shared team "metadata key" (OpenPGP)
```

- Explicit anti-design: "One of the main differences with other password managers is that there is **no symmetrically encrypted vault** acting as a collection of credentials, shared with multiple users. Passbolt instead treats each secret individually. **Each secret is encrypted once per user** that requires access to that credential." Security White Paper v5.10 (March 2026), §Encryption keys: https://www.passbolt.com/docs/files/security_white_paper_-_passbolt_pro_edition_v5.10_-_%28march_2026_-_rev10%29.pdf
- Data is split into *resource* (metadata: name, username, URL — historically server-readable) and *secret* (encrypted). 2021 whitepaper: https://www.passbolt.com/docs/files/security_paper.pdf ; the dev docs still note metadata "isn't End-to-end encrypted (yet 😉)" in the legacy flow: https://www.passbolt.com/docs/development/resources/updating-deleting/
- v5.1 (May 2025) added opt-in **encrypted resource metadata** using OpenPGP with either the user's personal key or a *shared metadata key trusted by the team* (with guided verification/rotation); audited by Cure53 (PBL-13, April 2025). https://www.passbolt.com/blog/passbolt-5-1-strengthens-metadata-security-for-shared-passwords ; audit list: https://www.passbolt.com/security
- Secrets are also **signed** by the sharer's key. https://www.passbolt.com/docs/user/introduction/how-passbolt-secures-your-data

### Add a member

O(shared items) human- or client-driven re-encryption: "Adding someone to a group means decrypting each secret shared with the group and re-encrypting it for the newcomer, and only someone with access to those secrets can do that" — admins who are not group managers *cannot* add members for this exact reason. https://www.passbolt.com/docs/admin/user-provisioning/manage-groups ; https://github.com/passbolt/passbolt-docs/blob/main/docs/admin/user-provisioning/roles-and-permissions.mdx. The server then enforces completeness: it "checks that all the recipients are included when a new version of the secret is published." 2021 whitepaper, §Sharing.

### Revoke a member — cost and honest limits

- "Revoking a user access means removing the secret from the database and the ability to decrypt future versions." https://www.passbolt.com/security. The v5.10 whitepaper strengthens this to "removing the ability to decrypt past and future versions" (vs. 2021's "future versions") — the mechanical change is that the recipient's encrypted copies are deleted so un-fetched revisions (v5 keeps encrypted secret history: https://www.passbolt.com/docs/admin/resource-policies/secret-history) can no longer be obtained. Copies already downloaded are gone forever, and there is no key to rotate because no shared key exists.
- Deletion is destructive: deleting a user who solely held items deletes those items unless ownership is transferred during the flow. https://www.passbolt.com/docs/admin/user-provisioning/manage-groups

### Server-visible metadata

By default the server reads resource names, usernames, URLs, descriptions, plus all permission/group/folder relationships. With v5.1 encrypted metadata enabled, metadata becomes ciphertext (personal or shared-team key). Secrets always encrypted.

### Offline-member handling

The server is the store-and-forward point: it holds one PGP ciphertext per (secret, user). Passbolt even offers email delivery of PGP-encrypted secrets for out-of-band pickup. https://www.passbolt.com/security

## 4. Proton Pass

### Wrapping tree

```
Account password ──bcrypt──> wraps  User key (asymmetric)
Address keys (1+ per email address; used for sharing/signing)
        │ public key wraps (+ signature by sender's address key)
        ▼
ShareKey(s) per share, with KeyRotation counter  ── one encrypted copy per member
        │ encrypts (vault shares)
        ▼
ItemKey per item (32-byte, AES-256-GCM content), also rotation-numbered
        │ encrypts
Item content  (item shares: the ShareKey IS the item key)
```

- Each user has an asymmetric **user key** encrypted with a bcrypt hash of the account password. Vault creation generates a **32-byte vault key**, "encrypted and signed with your user key." For multi-user vaults, "Proton Pass will encrypt the vault key with each user's public user key." Security model blog (by the Pass crypto team): https://proton.me/blog/proton-pass-security-model
- Every item gets a **32-byte item key**; item content is AES-256-GCM under the item key, and the item key is encrypted under the vault key. The blog explicitly motivates per-item keys for least-privilege sharing of single items without sharing the vault key. Same blog, §Item encryption.
- Sharing protocol (blog, §Sharing): admin encrypts the vault key with the recipient's **address key**; recipient validates the signature against the sender's address key; the client then re-encrypts the vault key with the recipient's **user key** and stores it — i.e., per-recipient wrapped copies live on Proton's servers. Same blog. Crypto stack: OpenPGP with ECC Curve25519. https://proton.me/pass/security
- Implementation (open source, matches the blog and extends it): every share carries multiple **ShareKeys** tagged with a `KeyRotation` (u8), fetched from `GET /pass/v1/share/{id}/key` and cached per-share — https://github.com/protonpass/pass-cli/blob/main/pass/src/share/keys.rs. Item keys are also rotation-numbered; for vault shares each item key is decrypted under the share key of the *same rotation* (`EncryptionTag::ItemKey`); for item-type shares "share keys are directly user keys" — the share key acts as the item key — https://github.com/protonpass/pass-cli/blob/main/pass/src/item/item_keys.rs. Share keys are opened with the user's private keys and verified against the counterparty public keys; group shares verify against group keys — https://github.com/protonpass/pass-cli/blob/main/pass/src/crypto/share_key.rs. Item updates reuse the current rotation's item key (no rotation on edit) — https://github.com/protonpass/pass-cli/blob/main/pass/src/item/update.rs. Data model: a *Share* is the user↔resource relation (vault share = all current+future items; item share = exactly one item), with viewer/editor/manager roles — https://github.com/protonpass/pass-cli/blob/main/docs/public/docs/objects/share.md
- Docs trail code here: the 2023 security-model blog describes only vault sharing; per-item shares and rotation counters exist in the shipped clients.

### Add a member

One wrapped-key copy per share (or per item share). Cheap. https://proton.me/blog/proton-pass-security-model

### Revoke a member — cost and honest limits

- Revocation is a server-side access action ("Remove access... The user will no longer be able to access this vault"): https://proton.me/support/remove-access-shared-vault. Note the family-plan nuance: removing someone from the *plan* does **not** remove their vault membership — "they'll still have access to any shared vaults that they're a member of"; you must revoke per vault: https://proton.me/support/pass-family-remove-user
- No published statement that share/item keys are rotated on revocation, and 1Password-style residual risk applies (a member who retained keys + obtains ciphertext can still decrypt). Proton's own advice after stopping a *link* share is to rotate the underlying credential: "Update your items after you stop sharing." https://proton.me/support/pass-secure-link-security

### Server-visible metadata

Strongest claim of the four: "not only are your usernames and passwords encrypted, but all metadata is also secure — not even Proton can access this data," including usernames, URLs, and notes. https://proton.me/pass/security ; https://proton.me/blog/proton-pass-security-model. The server necessarily sees share membership and per-recipient wrapped key blobs (they are stored server-side per the API shape above).

## Comparison

| | Bitwarden | 1Password | Passbolt | Proton Pass |
|---|---|---|---|---|
| **Wrapping tree** | item → Cipher Key → org key (or user key); org key wrapped per member (RSA-OAEP). Collections: names only, no keys | item → vault key → member/group public keys (RSA-OAEP); user key set under KEK (password+Secret Key) | secret → per-recipient PGP copies; no intermediate key; optional per-user/shared metadata key for v5.1 metadata | item → item key → share key (per rotation) → member public key (OpenPGP Curve25519); vault key per vault |
| **Add member** | 1 RSA wrap of org key | 1 RSA wrap of vault key per vault | decrypt + re-encrypt **every shared secret** (only possible by someone with access) | 1 wrap per share (vault or single item) |
| **Revoke: what's re-keyed** | nothing (no org-key rotation exists) | nothing; server drops wrapped copy + stops serving + client erasure policy | nothing; recipient's copies deleted; future versions not encrypted for them | access removed server-side; no published key-rotation-on-revoke |
| **Revoke: honest limit** | "credentials should be changed whenever access is removed" (official blog); offline read-only cache persists briefly | saved keys + obtained ciphertext decrypt all future vault data; mitigation = new vault + move items | downloaded copies remain; no key to rotate | retained keys + ciphertext; rotate the credential after revoking (their own link-share advice) |
| **Server-visible metadata** | item names/URIs/usernames/attachments/folder+collection names encrypted; emails, event logs w/ IP, item counts, collection membership plaintext | item titles/URLs, vault names encrypted; team/group/user names, emails, IPs, device info, MFA secrets plaintext | resource name/username/URL plaintext by default (v5.1 opt-in encrypts); secrets always encrypted | all fields incl. metadata encrypted; sees share membership + wrapped key blobs |
| **Offline member handling** | wrapped org key + ciphertext stored server-side; fetch on login | wrapped vault keys + ciphertext stored server-side; fetch on login | per-user PGP copies stored server-side (+ optional PGP-encrypted email delivery) | per-recipient share keys + ciphertext stored server-side; fetch on login |
| **Public-key verification** | none documented | explicitly absent (server MITM can substitute keys — their own appendix) | secrets signed by sharer's key; TOFU key model | share keys signed by sender's address key; verified on open |

## Lessons for Bramble

**1. The proposed design is Proton Pass's model with Bramble's naming.** Bramble already has Proton's item-key layer (per-entry DEKs wrapped under the VEK = Proton's item keys under the vault key). Adding collection keys wrapped once per member under the member's public key reproduces Proton's share keys (and 1Password's per-vault-key wrapping, generalized). Do not copy Bitwarden: its single org key means collections are ACLs, not crypto boundaries — a family member who extracts their org key can decrypt every org item they can obtain. Bramble's goal (dad cannot decrypt wife-only entries) is precisely what Bitwarden does *not* deliver and what per-collection keys do.

**2. What "collection key rotation" should concretely mean.** On revocation: (a) generate a new collection key; (b) unwrap each affected entry's DEK (old collection key) and re-wrap under the new one — cheap symmetric re-wraps, **never** re-encrypting entry content; (c) wrap the new collection key for each remaining member; (d) drop the removed member's wrapped copies. Every system's data model supports this: rotations are just new wrapped copies (Proton's `KeyRotation` counter is the pattern to copy — it lets offline members distinguish stale from current keys). Be honest about the limit all four share: rotation cannot undo secrets the removed member already viewed. Bitwarden's and Proton's own guidance — rotate the underlying credential after revoking — should be Bramble's in-app suggestion, not a hidden assumption.

**3. Metadata policy: each system answers a different question — pick deliberately.** Bitwarden encrypts item content but its server sees collection membership, event logs (with IPs), and item counts. 1Password encrypts item and vault names but sees team/group/user identities. Passbolt historically exposed resource names/URLs to the server (fixed only optionally in v5.1). Proton encrypts everything but still sees share membership and per-recipient blobs. For Bramble the decision is about the relay: today the Durable Object stores nothing; a collection-key model with store-and-forward means the DO will hold (i) per-recipient wrapped collection keys, (ii) re-wrapped DEK blobs, (iii) member identities. That is exactly the metadata class all four servers accept seeing. The line to hold: the DO never holds unwrapped keys or entry content, and collection *membership* visibility is a conscious choice (Bitwarden/Proton accept it; a fully P2P design avoiding it has no precedent among these four and costs offline-membership delivery).

**4. Consciously avoid Passbolt's per-recipient-copies-without-an-intermediate-key.** Its add-member cost is O(shared items) of decrypt-and-re-encrypt done by whoever holds access, its groups can only be grown by members who can decrypt everything the group holds, and there is nothing to rotate on revocation. For a family vault with hundreds of entries this model makes every invite and every revoke a bulk crypto chore. The collection-key middle layer exists precisely to amortize this to O(1) per membership change plus O(collection) cheap re-wraps on rotation.

**5. Do better than 1Password on key verification; copy Proton's signatures.** 1Password's own appendix concedes no user-verifiable public-key binding, so its server can silently substitute keys and capture vault keys. Proton at least signs every share key with the sender's address key and verifies on open. Bramble already has a per-vault roster of Ed25519 device keys — use them: sign collection-key wrappings, verify on receipt, and expose fingerprints for out-of-band confirmation. This closes the one attack 1Password documents but doesn't fix.

**6. Store-and-forward of wrapped keys is the universal pattern — the DO design is validated.** Bitwarden stores each member's Protected Organization Symmetric Key; 1Password stores `enc_vault_key` per member; Proton stores per-recipient share keys behind a paginated API; Passbolt stores one PGP blob per (secret, user). None of the four attempts pure peer-to-peer key delivery. A Cloudflare Durable Object holding per-recipient wrapped collection keys (and rotated re-wrapped DEKs) for offline family members is the industry-standard shape; "stores nothing" should be relaxed to "stores only ciphertext addressed to a member."
