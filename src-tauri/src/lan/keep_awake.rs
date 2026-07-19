//! Keep the desktop awake while the LAN companion is sharing.
//!
//! The phone companion's whole value is *unattended* monitoring — a phone
//! watching an agent run or CI is useless if the desktop falls asleep mid-watch.
//! So while sharing is on we hold a system-stays-awake request (the display may
//! still sleep — only the machine is kept from suspending). The hold is tied
//! exactly to the LAN server lifecycle: acquired in `lan_enable`, released when
//! the [`RunningServer`](super::RunningServer) is dropped (disable, mode-switch
//! restart — the only paths that drop a live server; the enable-path store only
//! ever assigns onto `None`). No quit hook is needed — the OS clears the request
//! on process death.
//!
//! ## Why a dedicated holder thread
//!
//! On Windows the underlying request is `SetThreadExecutionState`, which is
//! **thread-affine**: it sets state on the *calling* thread and the RAII guard's
//! `Drop` restores it on the *dropping* thread. `lan_enable`/`lan_disable` are
//! async Tauri commands running on tokio worker threads, so a guard created on
//! worker T1 and dropped on worker T2 would leak the hold until process exit.
//!
//! [`KeepAwakeHold`] sidesteps this by owning a dedicated OS thread: that thread
//! builds the guard and then blocks, so both the acquire and the release
//! (`Drop`) happen on the *same* thread. Dropping the hold disconnects the
//! channel, the holder thread unblocks, the guard drops on that thread, and the
//! thread exits. The dropping thread never blocks or joins.
//!
//! Keep-awake is **best-effort**: a build failure (a headless CI box, a denied
//! power request) logs a warning to stderr and yields `None` — it never fails or
//! delays `lan_enable`.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// How long [`KeepAwakeHold::acquire`] waits for the holder thread to report that
/// the OS keep-awake request built, before returning anyway. Bounds the worst-case
/// stall a blocking `keepawake::Builder::create()` (a synchronous D-Bus round trip
/// on Linux) can impose on the async `lan_enable` — a hung session bus can't hang
/// enable. 2s is generously above a healthy build (sub-millisecond on Windows/macOS,
/// a fast IPC on Linux) yet short enough to feel instant if the bus is wedged.
const ACQUIRE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);

/// A system-stays-awake hold, owned for its `Drop`. Held on a dedicated OS thread
/// so acquire and release happen on the same thread (`SetThreadExecutionState` is
/// thread-affine — see the module docs). Dropping this disconnects `stop`, which
/// unblocks the holder thread so the keep-awake guard drops there.
pub struct KeepAwakeHold {
    /// Send half of the stop channel. Held only so its `Drop` disconnects the
    /// channel; the value is never sent or read — dropping the field (when this
    /// hold drops) is exactly the release signal to the holder thread. Hence
    /// `dead_code`: it's load-bearing for its `Drop`, not for any read.
    #[allow(dead_code)]
    stop: mpsc::Sender<()>,
}

impl KeepAwakeHold {
    /// Acquire a keep-awake hold on a dedicated thread. Returns `Some(hold)` once
    /// the holder thread has successfully built the OS request; returns `None`
    /// (after a stderr warning) if the request could not be built — keep-awake is
    /// best-effort and must never fail `lan_enable`.
    ///
    /// The `ready` handshake makes acquisition bounded to ~2s worst case: we block
    /// on it only long enough to learn success/failure, then return. Building the
    /// OS request can BLOCK — on Linux `keepawake` makes a synchronous zbus/D-Bus
    /// round trip to the session bus, and a slow or hung bus would otherwise stall
    /// the tokio worker `lan_enable` runs on indefinitely (the D-Bus client's own
    /// timeout isn't ours to rely on). So we cap the wait at
    /// [`ACQUIRE_HANDSHAKE_TIMEOUT`]; see the timeout arm below for why that's still
    /// leak-free and honors the best-effort contract. The guard then lives on the
    /// holder thread until this hold is dropped.
    pub fn acquire() -> Option<KeepAwakeHold> {
        Self::acquire_inner().map(|(hold, _exited)| hold)
    }

    /// The acquire body, also returning an `exited` receiver whose channel
    /// DISCONNECTS when the holder thread ends (its sender lives on that thread and
    /// is dropped when the thread returns) — the seam the unit test uses to assert
    /// release without depending on the OS actually granting the power request.
    fn acquire_inner() -> Option<(KeepAwakeHold, mpsc::Receiver<()>)> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<bool>();
        let (exited_tx, exited_rx) = mpsc::channel::<()>();

        thread::Builder::new()
            .name("lan-keep-awake".to_string())
            .spawn(move || {
                // `exited_tx` fires on Drop (i.e. when this thread unwinds/returns),
                // regardless of which branch we take — the test's release signal.
                let _exited = exited_tx;
                let guard = keepawake::Builder::default()
                    .idle(true) // system stays awake…
                    .display(false) // …display may sleep
                    // Intentionally NOT .sleep(true): away-mode is a relic
                    // unsupported under Modern Standby.
                    .reason("Phone companion sharing")
                    .app_name("GitDesktop")
                    .app_reverse_domain("com.thebguy.gitdesktop")
                    .create();
                match guard {
                    Ok(guard) => {
                        // Signal success, then park until the hold is dropped. `recv`
                        // returns `Err` once every `stop` sender is gone → we fall
                        // through, `guard` drops HERE (same thread it was built on),
                        // and the thread exits.
                        let _ = ready_tx.send(true);
                        let _ = stop_rx.recv();
                        drop(guard);
                    }
                    Err(e) => {
                        // Match the module's neighbor (server.rs): log to stderr so a
                        // dev sees it; `log`/`tracing` aren't wired in this crate.
                        eprintln!("lan companion keep-awake unavailable: {e}");
                        let _ = ready_tx.send(false);
                        // Thread exits immediately; `_exited` fires.
                    }
                }
            })
            .ok()?;

        // Wait — but only up to the timeout — for the holder thread to report
        // whether the guard built. Three outcomes:
        //   Ok(true)      → guard built: hold it.
        //   Ok(false)     → guard build FAILED (the thread already exited after its
        //                   stderr warning): nothing to hold → None.
        //   Disconnected  → the sender dropped without signalling (the thread
        //                   panicked before either send): treat as failure → None.
        //   Timeout       → the build is still in flight (e.g. a wedged D-Bus). We
        //                   return `Some(hold)` ANYWAY rather than stall enable: the
        //                   hold owns `stop_tx`, so the holder thread stays governed
        //                   by the channel exactly as in the fast path. If the build
        //                   eventually succeeds, the guard releases on this hold's
        //                   Drop; if it eventually FAILS, that thread just exits — so
        //                   this cannot leak a hold, and keep-awake stays best-effort.
        match ready_rx.recv_timeout(ACQUIRE_HANDSHAKE_TIMEOUT) {
            Ok(true) => Some((KeepAwakeHold { stop: stop_tx }, exited_rx)),
            Ok(false) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => None,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                eprintln!(
                    "lan companion keep-awake is still initializing after {}s; \
                     proceeding without waiting (it will apply once ready, or exit)",
                    ACQUIRE_HANDSHAKE_TIMEOUT.as_secs()
                );
                Some((KeepAwakeHold { stop: stop_tx }, exited_rx))
            }
        }
    }
}

// `stop`'s `Drop` disconnects the channel on its own; no explicit `Drop` impl is
// needed. Documented here so the release mechanism is discoverable at the type.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_then_drop_exits_the_holder_thread() {
        use std::sync::mpsc::{RecvTimeoutError, TryRecvError};

        // Assert the THREAD LIFECYCLE, not OS power state: on CI the actual power
        // request may be denied, in which case `acquire` returns `None` and there
        // is nothing to release — a valid outcome we tolerate. When it DID acquire,
        // dropping the hold must disconnect the channel, unblock the holder thread,
        // drop the guard on that thread, and let it exit. The `exited` channel's
        // sender lives on the holder thread and is never sent on — the thread's exit
        // is observed as the channel DISCONNECTING (the sender drops with the thread).
        let Some((hold, exited)) = KeepAwakeHold::acquire_inner() else {
            // Power request denied in this environment (e.g. headless CI): the
            // best-effort contract says that's fine — nothing to release.
            return;
        };

        // Still held: the holder thread is parked on `stop_rx`, so its `exited`
        // sender is still alive — the channel is Empty, not yet Disconnected.
        assert_eq!(
            exited.try_recv(),
            Err(TryRecvError::Empty),
            "holder thread must stay alive while the hold is held"
        );

        drop(hold);

        // Dropping the hold disconnects `stop` → the holder thread unblocks, drops
        // the guard on that thread, and returns. Its exit drops the `exited` sender,
        // so a bounded recv resolves to `Disconnected` — that IS the exit signal.
        // (A `Timeout` would mean the thread is still parked → the release leaked.)
        assert_eq!(
            exited.recv_timeout(Duration::from_secs(5)),
            Err(RecvTimeoutError::Disconnected),
            "holder thread must exit promptly after the hold is dropped"
        );
    }
}
