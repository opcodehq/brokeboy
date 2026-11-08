//! Cost allowance policy. Values use the host's fixed minor unit, never floats.
use crate::{BillingError, Result};
use serde::{Deserialize, Serialize};

pub const MAX: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PeriodStatus {
    Active,
    Pending,
    Grace,
    BillingHold,
    Ended,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostPolicy {
    pub status: PeriodStatus,
    pub included: i64,
    pub markup_basis_points: i64,
    pub overage_cap: i64,
}

impl CostPolicy {
    pub fn validate(&self) -> Result<()> {
        if [self.included, self.markup_basis_points, self.overage_cap]
            .iter()
            .any(|v| !(0..=MAX).contains(v))
        {
            return Err(BillingError::new("invalid_period_policy"));
        }
        Ok(())
    }
    fn rated(&self, cost: i128) -> i128 {
        (cost - i128::from(self.included)).max(0) * (10_000 + i128::from(self.markup_basis_points))
            / 10_000
    }
    /// Historical settled charges are authoritative; only held cost is rated here.
    pub fn held(&self, confirmed: i64, charged: i64, reserved: i64) -> Result<bool> {
        self.validate()?;
        if self.status == PeriodStatus::Manual {
            return Ok(false);
        }
        if matches!(
            self.status,
            PeriodStatus::Grace | PeriodStatus::BillingHold | PeriodStatus::Ended
        ) {
            return Ok(true);
        }
        let raw = i128::from(confirmed);
        let total = (raw + i128::from(reserved)).max(0);
        let incremental = (self.rated(total) - self.rated(raw.max(0))).max(0);
        Ok(total > i128::from(self.included)
            && i128::from(charged) + incremental >= i128::from(self.overage_cap))
    }
    /// New settlement delta; existing charged money is never recomputed on reads.
    pub fn settlement(&self, confirmed: i64, charged: i64, cost: i64) -> Result<i64> {
        self.validate()?;
        if [confirmed, charged, cost]
            .iter()
            .any(|v| !(0..=MAX).contains(v))
        {
            return Err(BillingError::new("invalid_period_amount"));
        }
        let target = if self.status == PeriodStatus::Manual {
            0
        } else {
            self.rated(i128::from(confirmed) + i128::from(cost))
                .min(i128::from(self.overage_cap))
        };
        i64::try_from(target - i128::from(charged))
            .map_err(|_| BillingError::new("period_amount_overflow"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allowance_boundaries_and_authoritative_settlement() {
        let mut p = CostPolicy {
            status: PeriodStatus::Active,
            included: 100,
            markup_basis_points: 500,
            overage_cap: 105,
        };
        assert!(!p.held(100, 0, 0).unwrap());
        assert!(p.held(100, 0, 100).unwrap());
        p.overage_cap = 106;
        assert!(!p.held(100, 0, 100).unwrap());
        assert!(!p.held(900, 40, 0).unwrap());
        p.overage_cap = 0;
        assert!(p.held(100, 0, 1).unwrap());
        for status in [
            PeriodStatus::Grace,
            PeriodStatus::BillingHold,
            PeriodStatus::Ended,
        ] {
            p.status = status;
            assert!(p.held(0, 0, 0).unwrap());
        }
        p.status = PeriodStatus::Manual;
        assert!(!p.held(i64::MAX, 0, i64::MAX).unwrap());
        p.included = -1;
        assert!(p.held(0, 0, 0).is_err());
        assert!(serde_json::from_str::<PeriodStatus>("\"unknown\"").is_err());
    }
    #[test]
    fn cumulative_cost_policy_regression_vectors() {
        for (cap, confirmed, charged, reserved, expected) in [
            (25_000_000, 35_000_000, 0, 0, false),
            (0, 35_000_000, 0, 1, true),
            (1_050_000, 35_000_000, 0, 1_000_000, true),
            (1_050_001, 35_000_000, 0, 1_000_000, false),
            (25_000_000, 70_000_000, 10_000_000, 0, false),
        ] {
            let policy = CostPolicy {
                status: PeriodStatus::Active,
                included: 35_000_000,
                markup_basis_points: 500,
                overage_cap: cap,
            };
            assert_eq!(policy.held(confirmed, charged, reserved).unwrap(), expected);
        }
    }
}
