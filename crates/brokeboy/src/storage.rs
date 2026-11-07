use brokeboy_core::{
    Result,
    records::{Row, Table},
};
use std::{future::Future, pin::Pin};

pub type BillingFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

pub async fn atomic<F>(storage: &dyn Storage, scope: &str, action: F) -> Result<serde_json::Value>
where
    F: for<'a> FnOnce(&'a mut dyn Transaction) -> BillingFuture<'a, serde_json::Value> + Send,
{
    let mut tx = storage.begin(scope).await?;
    match action(tx.as_mut()).await {
        Ok(v) => {
            tx.commit().await?;
            Ok(v)
        }
        Err(e) => {
            tx.rollback().await?;
            Err(e)
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PageQuery {
    pub after: Option<String>,
    pub limit: u32,
    pub state: Option<String>,
    pub due_before: Option<i64>,
}

/// A customer-scoped transaction. Dropping it must roll back, never commit.
/// Engine operations own this handle; providers and application callbacks run
/// only after it has been committed or rolled back.
pub trait Transaction: Send {
    fn list(&mut self, table: Table, state: Option<&str>) -> BillingFuture<'_, Vec<Row>> {
        let state = state.map(str::to_owned);
        Box::pin(async move {
            let mut result = Vec::new();
            let mut after = None;
            loop {
                let rows = self
                    .page(
                        table,
                        PageQuery {
                            after,
                            limit: 1000,
                            state: state.clone(),
                            due_before: None,
                        },
                    )
                    .await?;
                let done = rows.len() < 1000;
                after = rows.last().map(|r| r.id.clone());
                result.extend(rows);
                if done {
                    return Ok(result);
                }
            }
        })
    }
    fn get(&mut self, table: Table, id: &str) -> BillingFuture<'_, Option<Row>>;
    fn page(&mut self, table: Table, query: PageQuery) -> BillingFuture<'_, Vec<Row>>;
    fn put(&mut self, table: Table, row: Row) -> BillingFuture<'_, ()>;
    fn commit(self: Box<Self>) -> BillingFuture<'static, ()>;
    fn rollback(self: Box<Self>) -> BillingFuture<'static, ()>;
}

/// Serialization and transaction ownership belong to the adapter, not callers.
pub trait Storage: Send + Sync {
    fn begin(&self, scope: &str) -> BillingFuture<'_, Box<dyn Transaction>>;
    fn scopes(
        &self,
        after: Option<&str>,
        limit: u32,
        prefix: &str,
    ) -> BillingFuture<'_, Vec<String>>;
    fn close(&self) -> BillingFuture<'_, ()>;
}

pub trait Clock: Send + Sync {
    fn now(&self) -> i64;
}
pub trait Identifiers: Send + Sync {
    fn next(&self) -> String;
}
pub trait EventDelivery: Send + Sync {
    fn deliver(&self, event: serde_json::Value) -> BillingFuture<'_, ()>;
    fn close(&self) -> BillingFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}
