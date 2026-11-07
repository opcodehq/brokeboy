//! Connection settings shared by native bindings and administrative tools.
use crate::{Billing, BillingOptions};
pub use brokeboy_core::models::{OpenConfig, StripeConnection as StripeConfig};
use brokeboy_core::{BillingError, Result};
impl Billing {
    pub async fn open_config(config: OpenConfig, mut options: BillingOptions) -> Result<Self> {
        if let Some(environment) = config.environment {
            options.environment = environment;
        }
        if let Some(stripe) = config.stripe {
            if options.provider.is_some() {
                return Err(BillingError::new("conflicting_provider_configuration"));
            }
            #[cfg(feature = "stripe")]
            {
                let mut provider = crate::stripe::StripeOptions::new(
                    stripe.secret_key,
                    stripe.webhook_secret.unwrap_or_default(),
                );
                provider.environment = options.environment;
                provider.clock = options.clock.clone();
                if let Some(base) = stripe.api_base {
                    provider.api_base = base;
                }
                options.provider = Some(std::sync::Arc::new(crate::stripe::Stripe::new(provider)?));
                options.owns_provider = true;
            }
            #[cfg(not(feature = "stripe"))]
            {
                let _ = stripe;
                return Err(BillingError::new("payment_provider_not_enabled"));
            }
        }
        Self::open(config.database, options).await
    }
}
