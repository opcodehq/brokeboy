use super::*;
use crate::catalog::{expand_catalog, normalize_plan, validate_catalog, validate_expanded_catalog};
use brokeboy_core::compatibility::{canonical_json_v1, hash_v1};
impl Billing {
    pub(crate) async fn plan(&self, id: &str, version: Option<&str>) -> Result<Value> {
        identifier(id)?;
        let scope = self.catalog_scope();
        let id = id.to_owned();
        let version = version.map(str::to_owned);
        self.atomic(&scope, move |tx| {
            Box::pin(async move {
                let target = if let Some(v) = version {
                    v
                } else {
                    let p = get(tx, Table::Catalog, &format!("plan:{id}"))
                        .await?
                        .ok_or_else(|| BillingError::new("plan_not_found"))?;
                    s(&p, "version")?.into()
                };
                let plan = get(tx, Table::Catalog, &target)
                    .await?
                    .ok_or_else(|| BillingError::new("plan_not_found"))?;
                require(opt(&plan, "id") == Some(id.as_str()), "plan_not_found")?;
                Ok(plan)
            })
        })
        .await
    }
    pub(crate) async fn catalog_call(&self, method: &str, input: Value) -> Result<Value> {
        match method {
            "catalog.validate" => {
                validate_catalog(&input)?;
                Ok(Value::Null)
            }
            "catalog.get" => self.plan(s(&input, "id")?, opt(&input, "version")).await,
            "catalog.export" => self.catalog_export().await,
            "catalog.publish" => self.catalog_publish(input).await,
            "catalog.custom" => {
                let current = self.catalog_export().await?;
                let mut plan = input["plan"].clone();
                plan["public"] = json!(false);
                self.catalog_publish(json!({"catalog":{"features":current["features"],"plans":[plan]},"expectedRevision":input["expectedRevision"]})).await
            }
            "catalog.diff" => {
                validate_catalog(&input)?;
                let input = expand_catalog(&input)?;
                let current = self.catalog_export().await?;
                let mut changes = Vec::new();
                for plan in arr(&input, "plans")? {
                    let mut previous: Vec<_> = arr(&current, "plans")?
                        .iter()
                        .filter(|p| p["id"] == plan["id"])
                        .collect();
                    previous
                        .sort_by_key(|p| std::cmp::Reverse(p["revision"].as_i64().unwrap_or(0)));
                    let mut old = previous.first().map_or_else(|| json!({}), |p| (*p).clone());
                    old.as_object_mut().unwrap().remove("version");
                    old.as_object_mut().unwrap().remove("revision");
                    let mut normalized = normalize_plan(plan, arr(&input, "features")?)?;
                    normalized.as_object_mut().unwrap().remove("variants");
                    if canonical_json_v1(&old)? != canonical_json_v1(&normalized)? {
                        changes.push(json!({"planId":plan["id"],"action":if previous.is_empty(){"create"}else{"version"}}));
                    }
                }
                Ok(json!({"expectedRevision":current["revision"],"changes":changes}))
            }
            _ => Err(BillingError::new("unknown_method")),
        }
    }
    pub(crate) async fn catalog_export(&self) -> Result<Value> {
        self.atomic(&self.catalog_scope(),|tx|Box::pin(async move{
            let versions=list(tx,Table::Catalog,Some("published")).await?;let pointers=list(tx,Table::Catalog,Some("pointer")).await?;
            let plans:Vec<_>=versions.iter().filter(|p|pointers.iter().any(|v|v["version"]==p["version"])).cloned().collect();let head=get(tx,Table::Catalog,"head").await?.unwrap_or(json!({"revision":0}));let features=get(tx,Table::Catalog,"features").await?.unwrap_or(json!([]));
            Ok(json!({"revision":head["revision"],"features":features,"plans":plans,"versions":versions}))
        })).await
    }
    pub(crate) async fn catalog_publish(&self, input: Value) -> Result<Value> {
        let expanded = expand_catalog(&input["catalog"])?;
        let catalog = &expanded;
        validate_expanded_catalog(catalog)?;
        let features = arr(catalog, "features")?.to_vec();
        let mut plans = Vec::new();
        for plan in arr(catalog, "plans")? {
            let mut normalized = normalize_plan(plan, &features)?;
            normalized.as_object_mut().unwrap().remove("variants");
            plans.push(normalized);
        }
        let mut normalized = catalog.clone();
        normalized["plans"] = json!(plans);
        let digest = hash_v1(&normalized)?;
        self.atomic(&self.catalog_scope(), move |tx| {
            Box::pin(async move {
                let head = get(tx, Table::Catalog, "head").await?;
                if head
                    .as_ref()
                    .is_some_and(|h| opt(h, "hash") == Some(digest.as_str()))
                {
                    return Ok(json!({"revision":head.unwrap()["revision"]}));
                }
                let expected = n(&input, "expectedRevision")?;
                require(
                    head.as_ref()
                        .and_then(|h| h["revision"].as_i64())
                        .unwrap_or(0)
                        == expected,
                    "catalog_conflict",
                )?;
                let revision = expected + 1;
                for mut plan in plans {
                    let version = hash_v1(&plan)?;
                    let id = s(&plan, "id")?.to_owned();
                    if get(tx, Table::Catalog, &version).await?.is_none() {
                        plan["version"] = json!(version);
                        plan["revision"] = json!(revision);
                        put(tx, Table::Catalog, &version, plan, "published").await?;
                    }
                    put(
                        tx,
                        Table::Catalog,
                        &format!("plan:{id}"),
                        json!({"version":version}),
                        "pointer",
                    )
                    .await?;
                }
                put(tx, Table::Catalog, "features", json!(features), "features").await?;
                put(
                    tx,
                    Table::Catalog,
                    "head",
                    json!({"revision":revision,"hash":digest}),
                    "head",
                )
                .await?;
                Ok(json!({"revision":revision}))
            })
        })
        .await
    }
}
