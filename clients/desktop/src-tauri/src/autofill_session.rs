//! Lets the macOS AutoFill extension fill from the unlocked app, so a fill while Bramble is
//! unlocked asks for nothing, and one after it locks (by hand, auto-lock or quitting) asks again.
//!
//! The app listens on a socket in the App Group container. Every process the user runs can reach
//! that file, so the caller's code signature is checked from the socket's audit token before
//! anything is read, and only Bramble's own extension gets an answer. Answers come from the
//! index the browser link serves (`index_store`), set on unlock and cleared on lock: one login's
//! secret per fetch, and a list with no secrets for the sheet. The VEK never leaves the app.
//!
//! The other way round, an unlock in the extension unlocks the app: the extension hands over the
//! key it just unwrapped, and a locked app takes it for its active vault, so a two-step sign-in's
//! password page fills without a second unlock. See docs/macos-credential-provider.md.

// macOS AutoFill: Windows builds the module and calls none of it.
#![cfg_attr(windows, allow(dead_code))]

use serde::{Deserialize, Serialize};

use crate::index_store::IndexEntry;

/// The extension, and only the extension, signed by us.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const EXTENSION_REQUIREMENT: &str = r#"anchor apple generic and identifier "app.bramble.desktop.autofill" and certificate leaf[subject.OU] = "BHGR3PP64J""#;

/// Short: a socket path is capped at 104 bytes, and the group container's path is long.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SOCKET: &str = "fill";

/// A request is a few ids; anything bigger is not one.
const MAX_REQUEST: u32 = 4096;

#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Request {
    /// One login's secrets, for the login macOS or the sheet picked.
    Fetch { vault_id: String, id: String },
    /// The open vault's logins with no secrets, for the sheet. `vault_id` pins the vault.
    List { vault_id: Option<String> },
    /// The extension unlocked `vault_id`: its key, for a locked app to unlock with.
    Unlock { vault_id: String, vek: String },
}

/// The app as a request finds it.
struct Snapshot {
    locked: bool,
    /// The vault the app has open, locked or not.
    active: Option<String>,
    index: Vec<IndexEntry>,
}

/// What answering asks of the app besides the reply.
#[derive(Debug, PartialEq)]
enum Effect {
    None,
    /// A secret went out, which counts as using the app.
    Used,
    /// Unlock the app with the extension's key. The reply says whether it took.
    Unlock {
        vault_id: String,
        vek: String,
    },
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Reply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    totp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vault_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    logins: Option<Vec<Login>>,
}

/// A login as the sheet lists it: what it shows and matches on, never a secret.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Login {
    id: String,
    name: String,
    username: String,
    hostnames: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subdomain_match: Option<String>,
    has_password: bool,
    has_totp: bool,
}

/// Listen for the extension. Without a group container or a socket, AutoFill asks to unlock as
/// before, so a failure here is logged and nothing more.
#[cfg(target_os = "macos")]
pub fn start(app: tauri::AppHandle) {
    use std::{os::unix::net::UnixListener, time::Duration};

    let Ok(root) = crate::storage::data_dir(&app) else {
        return;
    };
    let Some(dir) = crate::autofill_provider::group_dir() else {
        return;
    };
    let path = dir.join(SOCKET);
    let bound = std::fs::create_dir_all(&dir).and_then(|()| match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => UnixListener::bind(&path),
    });
    let listener = match bound {
        Ok(l) => l,
        Err(e) => {
            log::warn!("[autofill] no fill socket at {}: {e}", path.display());
            return;
        }
    };
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let root = root.clone();
            let app = app.clone();
            std::thread::spawn(move || {
                let mut stream = stream;
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let state = || Snapshot {
                    locked: vault_crypto::is_locked(),
                    active: crate::pairing::open_vault_id(&root).ok().flatten(),
                    index: crate::index_store::snapshot(),
                };
                let apply = |effect: &Effect| match effect {
                    Effect::None => true,
                    Effect::Used => {
                        crate::autolock::touch();
                        true
                    }
                    Effect::Unlock { vault_id, vek } => unlock_app(&app, vault_id, vek),
                };
                let trusted = |s: &std::os::unix::net::UnixStream| {
                    let ok = peer_satisfies(s, EXTENSION_REQUIREMENT);
                    if !ok {
                        log::warn!("[autofill] fill socket: caller is not Bramble's extension");
                    }
                    ok
                };
                if let Err(e) = serve(&mut stream, trusted, state, apply) {
                    log::warn!("[autofill] fill socket: {e}");
                }
            });
        }
    });
}

/// Unlock the app with a key the extension unwrapped for `vault_id`, the vault the app has open.
/// The key must open that vault's AutoFill copy, or the app stays locked. The window then opens
/// the vault as after its own Touch ID, and auto-lock counts from now.
#[cfg(target_os = "macos")]
fn unlock_app(app: &tauri::AppHandle, vault_id: &str, vek: &str) -> bool {
    use tauri::Emitter;

    // Checked again here: the window may have unlocked since the request was read.
    if !vault_crypto::is_locked() || vault_crypto::unlock_with_vek(vek.to_string()).is_err() {
        return false;
    }
    let opens = crate::autofill_provider::group_dir().is_some_and(|dir| {
        crate::autofill_provider::copy_opens(&dir, vault_id, |iv, ct| {
            vault_crypto::decrypt_with_vek(iv.to_string(), ct.to_string()).is_ok()
        })
    });
    if !opens {
        vault_crypto::lock();
        log::warn!("[autofill] the key AutoFill sent does not open the open vault");
        return false;
    }
    crate::autolock::touch();
    if let Err(e) = app.emit(AUTOFILL_UNLOCKED_EVENT, vault_id) {
        log::warn!("[autofill] unlock not delivered to the window: {e}");
    }
    true
}

/// Heard by the main window (src/auto-lock.ts).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const AUTOFILL_UNLOCKED_EVENT: &str = "vault://autofill-unlocked";

/// What to send back, and what else to do.
fn answer(request: Request, now: &Snapshot) -> (Reply, Effect) {
    if let Request::Unlock { vault_id, vek } = request {
        // Only a locked app, and only for the vault it has open: never switch vaults behind the
        // user's back, and never replace a key that is in use.
        return if now.locked && now.active.as_deref() == Some(vault_id.as_str()) {
            (Reply::default(), Effect::Unlock { vault_id, vek })
        } else {
            (Reply::default(), Effect::None)
        };
    }
    let open = match (&now.active, now.locked) {
        (Some(active), false) => active.as_str(),
        _ => return (Reply::default(), Effect::None),
    };
    let index = &now.index;
    let logins = || index.iter().filter(|e| e.kind == "login");
    match request {
        Request::Fetch { vault_id, id } if vault_id == open => {
            match logins().find(|e| e.id == id) {
                Some(e) => (
                    Reply {
                        ok: true,
                        username: Some(e.username.clone()),
                        password: Some(e.password.clone()),
                        totp: e.totp.clone(),
                        ..Default::default()
                    },
                    Effect::Used,
                ),
                None => (Reply::default(), Effect::None),
            }
        }
        Request::List { vault_id } if vault_id.as_deref().map_or(true, |v| v == open) => (
            Reply {
                ok: true,
                vault_id: Some(open.to_string()),
                logins: Some(
                    logins()
                        .map(|e| Login {
                            id: e.id.clone(),
                            name: e.name.clone(),
                            username: e.username.clone(),
                            hostnames: e.hostnames.clone(),
                            subdomain_match: e.subdomain_match.clone(),
                            has_password: !e.password.is_empty(),
                            has_totp: e.totp.as_deref().is_some_and(|t| !t.is_empty()),
                        })
                        .collect(),
                ),
                ..Default::default()
            },
            Effect::None,
        ),
        _ => (Reply::default(), Effect::None),
    }
}

/// Answer one request on `stream`: nothing at all unless `trusted` accepts the caller. `state` is
/// read only after the request arrives, so an answer is never older than its question. `apply`
/// carries out the answer's effect; for an unlock, the reply says whether it took.
#[cfg(unix)]
fn serve(
    stream: &mut std::os::unix::net::UnixStream,
    trusted: impl Fn(&std::os::unix::net::UnixStream) -> bool,
    state: impl Fn() -> Snapshot,
    apply: impl FnOnce(&Effect) -> bool,
) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind, Read, Write};

    if !trusted(stream) {
        return Ok(());
    }
    let mut len = [0u8; 4];
    stream.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len);
    if len > MAX_REQUEST {
        return Err(Error::new(ErrorKind::InvalidData, "request too large"));
    }
    let mut body = vec![0u8; len as usize];
    stream.read_exact(&mut body)?;
    let request: Request =
        serde_json::from_slice(&body).map_err(|e| Error::new(ErrorKind::InvalidData, e))?;
    let (mut reply, effect) = answer(request, &state());
    let took = apply(&effect);
    if matches!(effect, Effect::Unlock { .. }) {
        reply.ok = took;
    }
    let body = serde_json::to_vec(&reply).map_err(|e| Error::new(ErrorKind::InvalidData, e))?;
    stream.write_all(&(body.len() as u32).to_le_bytes())?;
    stream.write_all(&body)?;
    Ok(())
}

/// Whether the process at the other end of `stream` satisfies `requirement`, from the audit token
/// the kernel recorded when it connected (a pid could be reused by then).
#[cfg(target_os = "macos")]
fn peer_satisfies(stream: &std::os::unix::net::UnixStream, requirement: &str) -> bool {
    use core_foundation::{base::TCFType, data::CFData};
    use security_framework::os::macos::code_signing::{
        Flags, GuestAttributes, SecCode, SecRequirement,
    };
    use std::{ffi::c_int, os::fd::AsRawFd, str::FromStr};

    // <sys/un.h>: SOL_LOCAL, LOCAL_PEERTOKEN; an audit_token_t is eight u32s.
    const SOL_LOCAL: c_int = 0;
    const LOCAL_PEERTOKEN: c_int = 6;
    extern "C" {
        fn getsockopt(
            socket: c_int,
            level: c_int,
            name: c_int,
            value: *mut std::ffi::c_void,
            len: *mut u32,
        ) -> c_int;
    }
    let mut token = [0u8; 32];
    let mut len = token.len() as u32;
    let got = unsafe {
        getsockopt(
            stream.as_raw_fd(),
            SOL_LOCAL,
            LOCAL_PEERTOKEN,
            token.as_mut_ptr().cast(),
            &mut len,
        )
    };
    if got != 0 || len as usize != token.len() {
        return false;
    }
    let Ok(requirement) = SecRequirement::from_str(requirement) else {
        return false;
    };
    let token = CFData::from_buffer(&token);
    let mut attrs = GuestAttributes::new();
    attrs.set_audit_token(token.as_concrete_TypeRef());
    SecCode::copy_guest_with_attribues(None, &attrs, Flags::NONE)
        .and_then(|code| code.check_validity(Flags::NONE, &requirement))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(id: &str, password: &str, totp: Option<&str>) -> IndexEntry {
        IndexEntry {
            id: id.into(),
            kind: "login".into(),
            name: format!("{id} name"),
            hostnames: vec!["github.com".into()],
            username: format!("{id}@example.com"),
            password: password.into(),
            totp: totp.map(str::to_string),
            subdomain_match: Some("exact".into()),
        }
    }

    fn index() -> Vec<IndexEntry> {
        vec![
            login("a", "pw-a", None),
            login("b", "pw-b", Some("JBSWY3DPEHPK3PXP")),
            IndexEntry {
                id: "card".into(),
                kind: "card".into(),
                password: "4111".into(),
                ..Default::default()
            },
        ]
    }

    fn unlocked_on(vault: &str) -> Snapshot {
        Snapshot {
            locked: false,
            active: Some(vault.into()),
            index: index(),
        }
    }

    fn locked_on(vault: &str) -> Snapshot {
        Snapshot {
            locked: true,
            active: Some(vault.into()),
            index: vec![],
        }
    }

    fn unlock(vault: &str) -> Request {
        Request::Unlock {
            vault_id: vault.into(),
            vek: "K".into(),
        }
    }

    fn fetch(vault: &str, id: &str) -> Request {
        Request::Fetch {
            vault_id: vault.into(),
            id: id.into(),
        }
    }

    #[test]
    fn a_fetch_from_the_open_vault_hands_over_that_login_and_counts_as_use() {
        let (reply, effect) = answer(fetch("v1", "b"), &unlocked_on("v1"));
        assert_eq!(
            reply,
            Reply {
                ok: true,
                username: Some("b@example.com".into()),
                password: Some("pw-b".into()),
                totp: Some("JBSWY3DPEHPK3PXP".into()),
                ..Default::default()
            }
        );
        assert_eq!(effect, Effect::Used);
    }

    #[test]
    fn a_locked_app_answers_nothing() {
        assert_eq!(
            answer(fetch("v1", "a"), &locked_on("v1")),
            (Reply::default(), Effect::None)
        );
        let list = Request::List { vault_id: None };
        assert_eq!(
            answer(list, &locked_on("v1")),
            (Reply::default(), Effect::None)
        );
    }

    #[test]
    fn another_vault_answers_nothing() {
        assert_eq!(
            answer(fetch("v2", "a"), &unlocked_on("v1")),
            (Reply::default(), Effect::None)
        );
        let list = Request::List {
            vault_id: Some("v2".into()),
        };
        assert_eq!(
            answer(list, &unlocked_on("v1")),
            (Reply::default(), Effect::None)
        );
    }

    #[test]
    fn an_unknown_id_or_a_card_answers_nothing() {
        assert_eq!(
            answer(fetch("v1", "zz"), &unlocked_on("v1")),
            (Reply::default(), Effect::None)
        );
        assert_eq!(
            answer(fetch("v1", "card"), &unlocked_on("v1")),
            (Reply::default(), Effect::None)
        );
    }

    #[test]
    fn the_list_is_the_open_vaults_logins_without_a_secret() {
        let (reply, effect) = answer(Request::List { vault_id: None }, &unlocked_on("v1"));
        assert_eq!(effect, Effect::None);
        assert!(reply.ok);
        assert_eq!(reply.vault_id.as_deref(), Some("v1"));
        let logins = reply.logins.as_ref().unwrap();
        assert_eq!(
            logins.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(
            logins[1],
            Login {
                id: "b".into(),
                name: "b name".into(),
                username: "b@example.com".into(),
                hostnames: vec!["github.com".into()],
                subdomain_match: Some("exact".into()),
                has_password: true,
                has_totp: true,
            }
        );
        let wire = serde_json::to_string(&reply).unwrap();
        assert!(!wire.contains("pw-") && !wire.contains("JBSWY"), "{wire}");
    }

    #[test]
    fn the_list_answers_for_the_vault_it_names_when_that_one_is_open() {
        let list = Request::List {
            vault_id: Some("v1".into()),
        };
        assert!(answer(list, &unlocked_on("v1")).0.ok);
    }

    #[test]
    fn an_unlock_in_autofill_unlocks_the_locked_app_on_that_vault() {
        assert_eq!(
            answer(unlock("v1"), &locked_on("v1")),
            (
                Reply::default(),
                Effect::Unlock {
                    vault_id: "v1".into(),
                    vek: "K".into()
                }
            )
        );
    }

    #[test]
    fn an_unlock_never_switches_vaults_or_replaces_a_key_in_use() {
        assert_eq!(
            answer(unlock("v2"), &locked_on("v1")),
            (Reply::default(), Effect::None)
        );
        assert_eq!(
            answer(unlock("v1"), &unlocked_on("v1")),
            (Reply::default(), Effect::None)
        );
        let nothing_open = Snapshot {
            locked: true,
            active: None,
            index: vec![],
        };
        assert_eq!(
            answer(unlock("v1"), &nothing_open),
            (Reply::default(), Effect::None)
        );
    }

    #[cfg(unix)]
    mod wire {
        use super::*;
        use std::{
            io::{Read, Write},
            os::unix::net::UnixStream,
        };

        fn send(stream: &mut UnixStream, body: &[u8]) {
            stream
                .write_all(&(body.len() as u32).to_le_bytes())
                .unwrap();
            stream.write_all(body).unwrap();
        }

        fn received(stream: &mut UnixStream) -> Option<serde_json::Value> {
            let mut len = [0u8; 4];
            stream.read_exact(&mut len).ok()?;
            let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
            stream.read_exact(&mut body).ok()?;
            serde_json::from_slice(&body).ok()
        }

        fn unlocked() -> Snapshot {
            unlocked_on("v1")
        }

        #[test]
        fn a_trusted_caller_gets_its_answer() {
            let (mut ours, mut theirs) = UnixStream::pair().unwrap();
            send(&mut theirs, br#"{"op":"fetch","vaultId":"v1","id":"a"}"#);
            let applied = std::cell::RefCell::new(None);
            serve(
                &mut ours,
                |_| true,
                unlocked,
                |e| {
                    applied.replace(Some(format!("{e:?}")));
                    true
                },
            )
            .unwrap();
            assert_eq!(applied.take().as_deref(), Some("Used"));
            drop(ours);
            let reply = received(&mut theirs).unwrap();
            assert_eq!(reply["ok"], true);
            assert_eq!(reply["password"], "pw-a");
        }

        #[test]
        fn an_untrusted_caller_gets_nothing_and_its_request_is_never_read() {
            let (mut ours, mut theirs) = UnixStream::pair().unwrap();
            send(&mut theirs, br#"{"op":"fetch","vaultId":"v1","id":"a"}"#);
            let asked = std::cell::Cell::new(false);
            let state = || {
                asked.set(true);
                unlocked()
            };
            let applied = std::cell::Cell::new(false);
            serve(
                &mut ours,
                |_| false,
                state,
                |_| {
                    applied.set(true);
                    true
                },
            )
            .unwrap();
            assert!(!asked.get());
            assert!(!applied.get());
            drop(ours);
            assert!(received(&mut theirs).is_none());
        }

        #[test]
        fn an_oversized_or_garbled_request_gets_nothing() {
            let (mut ours, mut theirs) = UnixStream::pair().unwrap();
            theirs.write_all(&(MAX_REQUEST + 1).to_le_bytes()).unwrap();
            assert!(serve(&mut ours, |_| true, unlocked, |_| true).is_err());
            drop(ours);
            assert!(received(&mut theirs).is_none());

            let (mut ours, mut theirs) = UnixStream::pair().unwrap();
            send(&mut theirs, b"{not json");
            assert!(serve(&mut ours, |_| true, unlocked, |_| true).is_err());
            drop(ours);
            assert!(received(&mut theirs).is_none());
        }

        #[test]
        fn an_unlock_replies_whether_the_app_took_the_key() {
            for took in [true, false] {
                let (mut ours, mut theirs) = UnixStream::pair().unwrap();
                send(&mut theirs, br#"{"op":"unlock","vaultId":"v1","vek":"K"}"#);
                let applied = std::cell::RefCell::new(None);
                serve(
                    &mut ours,
                    |_| true,
                    || locked_on("v1"),
                    |e| {
                        applied.replace(Some(format!("{e:?}")));
                        took
                    },
                )
                .unwrap();
                assert_eq!(
                    applied.take().as_deref(),
                    Some(r#"Unlock { vault_id: "v1", vek: "K" }"#)
                );
                drop(ours);
                assert_eq!(
                    received(&mut theirs).unwrap(),
                    serde_json::json!({ "ok": took })
                );
            }
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn the_peer_check_reads_the_callers_signature() {
            let (ours, _theirs) = UnixStream::pair().unwrap();
            // Any signed code satisfies "always", so this proves the audit token resolved to code.
            assert!(peer_satisfies(&ours, "always"));
            // This test binary is not our extension.
            assert!(!peer_satisfies(&ours, EXTENSION_REQUIREMENT));
            assert!(!peer_satisfies(&ours, "not a requirement"));
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn the_requirements_parse() {
            use std::str::FromStr;
            security_framework::os::macos::code_signing::SecRequirement::from_str(
                EXTENSION_REQUIREMENT,
            )
            .unwrap();
        }
    }

    #[test]
    fn requests_parse_as_the_extension_sends_them() {
        let r: Request = serde_json::from_str(r#"{"op":"fetch","vaultId":"v1","id":"a"}"#).unwrap();
        assert!(matches!(r, Request::Fetch { vault_id, id } if vault_id == "v1" && id == "a"));
        let r: Request = serde_json::from_str(r#"{"op":"list"}"#).unwrap();
        assert!(matches!(r, Request::List { vault_id: None }));
        let r: Request =
            serde_json::from_str(r#"{"op":"unlock","vaultId":"v1","vek":"K"}"#).unwrap();
        assert!(matches!(r, Request::Unlock { vault_id, vek } if vault_id == "v1" && vek == "K"));
    }
}
