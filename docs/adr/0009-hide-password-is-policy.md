# Hide-password is policy, not enforcement

A collection can carry a hide-password flag. On member devices whose client
understands it, Bramble keeps the collection's passwords out of view: the detail
field is locked ("Hidden by the owner — it still fills on login pages"), the
reveal and copy actions and the password changelog are gone, list rows omit the
password copy action, and plaintext exports (KDBX, OS transfer) omit the password
and say how many were skipped. The encrypted .bramble backup is not scrubbed —
the flag travels inside it, so a restored copy keeps the same concealment.

Autofill, TOTP display, and copying a password *into the active login page*
(filling a site) are intentionally unaffected: the owner's goal is "use it, but
don't browse it," and the vault UI is the browsing surface.

This is the same honesty category as ADR-0004: the member's device necessarily
holds the decrypted secret, because autofill requires it. A member running
modified code, or simply opening the fill flow, can read what this feature
hides. The UI copy must never claim the member *cannot* see it — the shipped
wording says "hidden," "a courtesy, not a lock."

Mechanically the flag is `hidePassword: true` on the collection record inside
the region (ADR-0007's sealed JSON), toggled by an owner-only transition. No
re-encryption, no key rotation; it converges like any region edit. Zod strips
unknown keys, so older member clients parse the region but silently ignore the
flag and show passwords as before — concealment holds only on up-to-date
clients, which is why the setting lives behind the existing "update your other
devices first" guidance rather than a claim of security.

Scope: login passwords. Other secret fields (card numbers, secure notes) are
not concealed in this version; TOTP codes are deliberately visible — they are
short-lived by design and hiding them would be the same policy at more UI cost.
