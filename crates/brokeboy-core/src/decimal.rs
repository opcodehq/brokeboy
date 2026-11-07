use crate::{BillingError, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use std::{fmt, str::FromStr};

pub const SCALE: i128 = 1_000_000;
pub const MAX: i128 = i64::MAX as i128;

/// Six-place fixed point with the symmetric range used by the 0.1 engine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Decimal(i64);

impl Decimal {
    pub const ZERO: Self = Self(0);
    pub const ONE: Self = Self(SCALE as i64);
    pub fn from_scaled(value: i128) -> Result<Self> {
        if !(-MAX..=MAX).contains(&value) {
            return Err(BillingError::new("decimal_overflow"));
        }
        Ok(Self(value as i64))
    }
    pub fn scaled(self) -> i128 {
        self.0 as i128
    }
    pub fn nonnegative(self) -> Result<Self> {
        if self.0 < 0 {
            return Err(BillingError::new("invalid_amount"));
        }
        Ok(self)
    }
    pub fn positive(self) -> Result<Self> {
        if self.0 <= 0 {
            return Err(BillingError::new("invalid_amount"));
        }
        Ok(self)
    }
    pub fn checked_add(self, other: Self) -> Result<Self> {
        Self::from_scaled(self.scaled() + other.scaled())
    }
    pub fn checked_sub(self, other: Self) -> Result<Self> {
        Self::from_scaled(self.scaled() - other.scaled())
    }
    pub fn checked_mul(self, other: Self) -> Result<Self> {
        Self::from_scaled(self.scaled() * other.scaled() / SCALE)
    }
    pub fn minor_units(self, currency: &str) -> Result<String> {
        self.nonnegative()?;
        let exponent = match currency {
            "bif" | "clp" | "djf" | "gnf" | "jpy" | "kmf" | "krw" | "mga" | "pyg" | "rwf"
            | "ugx" | "vnd" | "vuv" | "xaf" | "xof" | "xpf" => 0,
            "bhd" | "jod" | "kwd" | "omr" | "tnd" => 3,
            _ => 2,
        };
        let divisor = 10_i128.pow(6 - exponent);
        Ok(((self.scaled() + divisor / 2) / divisor).to_string())
    }
}

impl FromStr for Decimal {
    type Err = BillingError;
    fn from_str(value: &str) -> Result<Self> {
        let invalid = || {
            BillingError::message(
                "invalid_decimal",
                "Use a decimal string with at most six fractional digits.",
            )
        };
        let (negative, unsigned) = value
            .strip_prefix('-')
            .map_or((false, value), |v| (true, v));
        let (whole, fraction) = unsigned
            .split_once('.')
            .map_or((unsigned, None), |(w, f)| (w, Some(f)));
        if whole.is_empty()
            || !whole.bytes().all(|b| b.is_ascii_digit())
            || (whole.len() > 1 && whole.starts_with('0'))
            || fraction.is_some_and(|f| {
                f.is_empty() || f.len() > 6 || !f.bytes().all(|b| b.is_ascii_digit())
            })
        {
            return Err(invalid());
        }
        let overflow = || BillingError::new("decimal_overflow");
        let whole: i128 = whole.parse().map_err(|_| overflow())?;
        let fraction = fraction.unwrap_or("");
        let frac: i128 = if fraction.is_empty() {
            0
        } else {
            fraction.parse().map_err(|_| invalid())?
        };
        let n = whole
            .checked_mul(SCALE)
            .and_then(|w| w.checked_add(frac * 10_i128.pow(6 - fraction.len() as u32)))
            .ok_or_else(overflow)?;
        Self::from_scaled(if negative { -n } else { n })
    }
}
impl fmt::Display for Decimal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let n = self.scaled().abs();
        if self.0 < 0 {
            f.write_str("-")?;
        }
        write!(f, "{}", n / SCALE)?;
        if n % SCALE != 0 {
            write!(f, ".{}", format!("{:06}", n % SCALE).trim_end_matches('0'))?;
        }
        Ok(())
    }
}
impl Serialize for Decimal {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
impl<'de> Deserialize<'de> for Decimal {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(de::Error::custom)
    }
}

macro_rules! unit_type {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Decimal);
    };
}
unit_type!(Money);
unit_type!(Credits);
unit_type!(Quantity);
