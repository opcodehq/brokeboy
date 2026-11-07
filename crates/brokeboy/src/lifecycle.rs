//! Registered cancellation and draining shared by every native API surface.
use brokeboy_core::{BillingError, Result, error::identifier};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct State {
    closing: bool,
    requests: HashMap<String, Request>,
}
struct Request {
    token: CancellationToken,
    running: bool,
}
#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    drained: Notify,
}

/// Registration is synchronous: callers may cancel before an async operation
/// is scheduled. IDs remain reserved until completion or shutdown.
#[derive(Clone, Default)]
pub struct Lifecycle(Arc<Inner>);

impl Lifecycle {
    fn state(&self) -> MutexGuard<'_, State> {
        // No application callbacks execute while this lock is held.
        self.0
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    pub fn register(&self, id: &str) -> Result<()> {
        identifier(id)?;
        let mut state = self.state();
        if state.closing {
            return Err(BillingError::new("billing_closed"));
        }
        if state.requests.contains_key(id) {
            return Err(BillingError::new("request_conflict"));
        }
        state.requests.insert(
            id.into(),
            Request {
                token: CancellationToken::new(),
                running: false,
            },
        );
        Ok(())
    }
    pub fn cancel(&self, id: &str) -> bool {
        let state = self.state();
        if let Some(request) = state.requests.get(id) {
            request.token.cancel();
            true
        } else {
            false
        }
    }
    /// Release registration when a transport rejects input before work starts.
    pub fn discard_pending(&self, id: &str) -> bool {
        let mut state = self.state();
        if state.requests.get(id).is_some_and(|r| !r.running) {
            state.requests.remove(id);
            self.0.drained.notify_waiters();
            true
        } else {
            false
        }
    }
    pub fn start(&self, id: &str) -> Result<RequestGuard> {
        let mut state = self.state();
        if state.closing {
            return Err(BillingError::new("billing_closed"));
        }
        let request = state
            .requests
            .get_mut(id)
            .ok_or_else(|| BillingError::new("request_not_registered"))?;
        if request.running {
            return Err(BillingError::new("request_conflict"));
        }
        request.running = true;
        Ok(RequestGuard {
            lifecycle: self.clone(),
            id: id.into(),
            token: request.token.clone(),
        })
    }
    /// Stop acceptance, cancel registered work, then wait for safe I/O cleanup.
    pub async fn shutdown(&self) {
        {
            let mut state = self.state();
            state.closing = true;
            state.requests.retain(|_, request| {
                request.token.cancel();
                request.running
            });
        }
        loop {
            let notified = self.0.drained.notified();
            if self.state().requests.is_empty() {
                return;
            }
            notified.await;
        }
    }
}

pub struct RequestGuard {
    lifecycle: Lifecycle,
    id: String,
    token: CancellationToken,
}
impl RequestGuard {
    /// Check only at safe interruption boundaries. Nonabortable driver calls
    /// finish first; callers explicitly roll back before returning cancellation.
    pub fn check(&self) -> Result<()> {
        if self.token.is_cancelled() {
            Err(BillingError::new("interrupted"))
        } else {
            Ok(())
        }
    }
    pub async fn cancelled(&self) {
        self.token.cancelled().await;
    }
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.lifecycle.state().requests.remove(&self.id);
        self.lifecycle.0.drained.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn early_cancel_is_not_lost_and_shutdown_drains_cleanup() {
        let lifecycle = Lifecycle::default();
        lifecycle.register("rejected").unwrap();
        assert!(lifecycle.discard_pending("rejected"));
        lifecycle.register("rejected").unwrap();
        let running_rejected = lifecycle.start("rejected").unwrap();
        assert!(!lifecycle.discard_pending("rejected"));
        drop(running_rejected);
        lifecycle.register("early").unwrap();
        assert!(lifecycle.cancel("early"));
        let early = lifecycle.start("early").unwrap();
        assert_eq!(early.check().unwrap_err().code, "interrupted");
        assert!(lifecycle.start("early").is_err());
        drop(early);
        lifecycle.register("running").unwrap();
        lifecycle.register("unused").unwrap();
        let running = lifecycle.start("running").unwrap();
        let shutdown = tokio::spawn({
            let lifecycle = lifecycle.clone();
            async move { lifecycle.shutdown().await }
        });
        running.cancelled().await;
        assert!(!shutdown.is_finished());
        assert!(lifecycle.register("late").is_err());
        drop(running);
        shutdown.await.unwrap();
        lifecycle.shutdown().await;
    }
}
