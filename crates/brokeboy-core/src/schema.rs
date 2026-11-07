//! Explicit schema generation. Connecting an engine never executes these statements.
use crate::records::Table;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
}
pub fn migration_sql(dialect: Dialect) -> Vec<String> {
    let mysql = dialect == Dialect::Mysql;
    let index_type = if mysql {
        "VARCHAR(191) COLLATE utf8mb4_bin"
    } else {
        "VARCHAR(191)"
    };
    let mut result = vec![format!(
        "CREATE TABLE IF NOT EXISTS brokeboy_locks (scope {index_type} PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, token VARCHAR(64))"
    )];
    for table in Table::ALL {
        let name = format!("brokeboy_{}", table.name());
        let work = table == Table::Work;
        result.push(format!("CREATE TABLE IF NOT EXISTS {name} (scope {index_type} NOT NULL, id {index_type} NOT NULL, state VARCHAR(32) NOT NULL, data {} NOT NULL{}, PRIMARY KEY (scope,id){})",if mysql{"LONGTEXT"}else{"TEXT"},if work{", due BIGINT NOT NULL DEFAULT 0"}else{""},if mysql{format!(", INDEX state_idx (scope,state){}",if work{", INDEX due_idx (scope,state,due,id)"}else{""})}else{String::new()}));
        if !mysql {
            result.push(format!(
                "CREATE INDEX IF NOT EXISTS {name}_state ON {name} (scope,state)"
            ));
        }
    }
    if !mysql {
        result.push(
            "CREATE INDEX IF NOT EXISTS brokeboy_work_due ON brokeboy_work (scope,state,due,id)"
                .into(),
        );
    }
    result
}
