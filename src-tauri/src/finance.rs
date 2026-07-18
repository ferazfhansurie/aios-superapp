use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinanceAdjustment {
    pub id: String,
    pub at: String,
    pub kind: String,
    pub amount: f64,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinanceSnapshot {
    pub schema_version: u8,
    pub revision: u64,
    pub updated_at: String,
    pub currency: String,
    pub month: String,
    pub income_received: f64,
    pub opening_spent: f64,
    pub spend_budget: f64,
    pub cash: f64,
    pub cash_floor: f64,
    pub card_debt: f64,
    pub next_month_cash_target: f64,
    pub adjustments: Vec<FinanceAdjustment>,
}

fn validate(s: &FinanceSnapshot) -> Result<(), String> {
    if s.schema_version != 1 || s.currency != "MYR" || s.month.len() != 7 {
        return Err("invalid finance schema".into());
    }
    for value in [
        s.income_received,
        s.opening_spent,
        s.spend_budget,
        s.cash,
        s.cash_floor,
        s.card_debt,
        s.next_month_cash_target,
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err("invalid finance amount".into());
        }
    }
    if s.spend_budget <= 0.0 {
        return Err("invalid spend budget".into());
    }
    let mut ids = HashSet::new();
    let mut spent = s.opening_spent;
    for a in &s.adjustments {
        if !ids.insert(&a.id) || !a.amount.is_finite() || a.amount == 0.0 {
            return Err("invalid finance adjustment".into());
        }
        if (a.kind == "expense" && a.amount <= 0.0)
            || (a.kind == "refund" && a.amount >= 0.0)
            || !matches!(a.kind.as_str(), "expense" | "refund" | "correction")
        {
            return Err("invalid adjustment sign".into());
        }
        let dt =
            chrono::DateTime::parse_from_rfc3339(&a.at).map_err(|_| "invalid adjustment time")?;
        if dt.format("%Y-%m").to_string() != s.month {
            return Err("adjustment outside month".into());
        }
        spent += a.amount;
    }
    if spent < 0.0 {
        return Err("negative spend".into());
    }
    Ok(())
}

fn default_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME unavailable")?;
    Ok(PathBuf::from(home).join(".aios/state/finance/cfo.json"))
}

#[tauri::command]
pub fn finance_snapshot() -> Result<Option<FinanceSnapshot>, String> {
    let path = default_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let snapshot: FinanceSnapshot = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    validate(&snapshot)?;
    Ok(Some(snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_july_snapshot() {
        let snapshot = FinanceSnapshot {
            schema_version: 1,
            revision: 1,
            updated_at: "2026-07-15T03:00:00+08:00".into(),
            currency: "MYR".into(),
            month: "2026-07".into(),
            income_received: 11700.0,
            opening_spent: 6300.0,
            spend_budget: 6700.0,
            cash: 5400.0,
            cash_floor: 5000.0,
            card_debt: 4578.91,
            next_month_cash_target: 7000.0,
            adjustments: vec![],
        };
        assert!(validate(&snapshot).is_ok());
    }
    #[test]
    fn rejects_negative_core_amount() {
        let mut snapshot = FinanceSnapshot {
            schema_version: 1,
            revision: 1,
            updated_at: "x".into(),
            currency: "MYR".into(),
            month: "2026-07".into(),
            income_received: 1.0,
            opening_spent: 0.0,
            spend_budget: 1.0,
            cash: 0.0,
            cash_floor: 0.0,
            card_debt: 0.0,
            next_month_cash_target: 0.0,
            adjustments: vec![],
        };
        snapshot.cash = -1.0;
        assert!(validate(&snapshot).is_err());
    }
}
