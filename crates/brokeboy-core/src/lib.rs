//! Runtime-independent billing rules and the frozen 0.1 wire contract.
pub mod compatibility;
pub mod decimal;
pub mod error;
pub mod models;
pub mod periods;
pub mod pricing;
pub mod records;
pub mod schema;

pub use error::{BillingError, Result};

/// Maximum accepted raw payment webhook body, shared with native transports.
pub const MAX_WEBHOOK_BYTES: usize = 8 * 1024 * 1024;
