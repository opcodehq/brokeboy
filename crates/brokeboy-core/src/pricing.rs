use crate::{BillingError, Result, decimal::Decimal};
use chrono::{Datelike, Months, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier {
    pub up_to: Option<Decimal>,
    pub amount: Decimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flat: Option<Decimal>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Dimension {
    pub r#match: BTreeMap<String, String>,
    pub amount: Decimal,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TierMode {
    Graduated,
    Volume,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Rate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<Decimal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tiers: Option<Vec<Tier>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<TierMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<Vec<Dimension>>,
}

impl Rate {
    pub fn validate(&self) -> Result<()> {
        if usize::from(self.amount.is_some())
            + usize::from(self.tiers.is_some())
            + usize::from(self.dimensions.is_some())
            != 1
        {
            return Err(BillingError::new("invalid_rate"));
        }
        if let Some(amount) = self.amount {
            amount.nonnegative()?;
        }
        if let Some(tiers) = &self.tiers {
            if tiers.is_empty() || tiers.last().is_some_and(|t| t.up_to.is_some()) {
                return Err(BillingError::new("invalid_tiers"));
            }
            let mut last = Decimal::ZERO;
            for (i, tier) in tiers.iter().enumerate() {
                tier.amount.nonnegative()?;
                if let Some(flat) = tier.flat {
                    flat.nonnegative()?;
                }
                if let Some(top) = tier.up_to {
                    top.positive()?;
                    if top <= last {
                        return Err(BillingError::new("invalid_tiers"));
                    }
                    last = top;
                } else if i != tiers.len() - 1 {
                    return Err(BillingError::new("invalid_tiers"));
                }
            }
        }
        if let Some(dimensions) = &self.dimensions {
            if dimensions.is_empty() {
                return Err(BillingError::new("invalid_dimensions"));
            }
            for dimension in dimensions {
                dimension.amount.nonnegative()?;
                if dimension.r#match.is_empty() {
                    return Err(BillingError::new("invalid_dimensions"));
                }
            }
        }
        Ok(())
    }

    pub fn rate(
        &self,
        quantity: Decimal,
        properties: &BTreeMap<String, String>,
    ) -> Result<Decimal> {
        let n = quantity.nonnegative()?;
        if n == Decimal::ZERO {
            return Ok(n);
        }
        if let Some(dimensions) = &self.dimensions {
            let matches: Vec<_> = dimensions
                .iter()
                .filter(|d| d.r#match.iter().all(|(k, v)| properties.get(k) == Some(v)))
                .collect();
            return match matches.as_slice() {
                [matched] => n.checked_mul(matched.amount),
                [] => Err(BillingError::new("missing_rate")),
                _ => Err(BillingError::new("ambiguous_rate")),
            };
        }
        let Some(tiers) = &self.tiers else {
            return n.checked_mul(self.amount.unwrap_or(Decimal::ONE).nonnegative()?);
        };
        let mut previous = Decimal::ZERO;
        // Sum in the wider representation, checking only the final amount as 0.1 does.
        let mut total: i128 = 0;
        for tier in tiers {
            let top = tier.up_to.unwrap_or(n);
            if self.mode == Some(TierMode::Volume) {
                if n <= top {
                    return Decimal::from_scaled(
                        n.scaled() * tier.amount.scaled() / crate::decimal::SCALE
                            + tier.flat.unwrap_or_default().scaled(),
                    );
                }
            } else {
                let part = n.min(top).scaled() - previous.scaled();
                if part > 0 {
                    total += part * tier.amount.scaled() / crate::decimal::SCALE
                        + tier.flat.unwrap_or_default().scaled();
                }
                if n <= top {
                    return Decimal::from_scaled(total);
                }
            }
            previous = top;
        }
        Decimal::from_scaled(total)
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Interval {
    Month,
    Year,
}

pub fn elapsed_intervals(start: i64, end: i64, interval: Interval) -> Result<i64> {
    let a = Utc
        .timestamp_millis_opt(start)
        .single()
        .ok_or_else(|| BillingError::new("invalid_timestamp"))?;
    let b = Utc
        .timestamp_millis_opt(end)
        .single()
        .ok_or_else(|| BillingError::new("invalid_timestamp"))?;
    Ok(match interval {
        Interval::Year => i64::from(b.year() - a.year()),
        Interval::Month => {
            i64::from((b.year() - a.year()) * 12 + b.month() as i32 - a.month() as i32)
        }
    })
}

pub fn add_interval(start: i64, interval: Interval, count: u32) -> Result<i64> {
    crate::error::timestamp(start)?;
    let date = Utc
        .timestamp_millis_opt(start)
        .single()
        .ok_or_else(|| BillingError::new("invalid_timestamp"))?;
    let months = match interval {
        Interval::Month => count,
        Interval::Year => count
            .checked_mul(12)
            .ok_or_else(|| BillingError::new("invalid_timestamp"))?,
    };
    let anchor = date
        .with_day(1)
        .ok_or_else(|| BillingError::new("invalid_timestamp"))?;
    let target = anchor
        .checked_add_months(Months::new(months))
        .ok_or_else(|| BillingError::new("invalid_timestamp"))?;
    let next = target
        .checked_add_months(Months::new(1))
        .ok_or_else(|| BillingError::new("invalid_timestamp"))?;
    let last_day = next
        .checked_sub_signed(chrono::TimeDelta::days(1))
        .ok_or_else(|| BillingError::new("invalid_timestamp"))?
        .day();
    Ok(target
        .with_day(date.day().min(last_day))
        .ok_or_else(|| BillingError::new("invalid_timestamp"))?
        .timestamp_millis())
}

pub fn iso_date(now: i64) -> Result<String> {
    Ok(Utc
        .timestamp_millis_opt(now)
        .single()
        .ok_or_else(|| BillingError::new("invalid_timestamp"))?
        .format("%Y-%m-%d")
        .to_string())
}
