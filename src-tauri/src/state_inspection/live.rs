//! On-demand main-host management using the live gate and SQLite connection.
//! Every registered target view, including an unfinished open, is held in use.
use super::{
    backend_error,
    collector::{Availability, ConnectedRoot, Observation},
    error,
    management::{self, Record},
    recovery_store, report, InspectionError,
};
use crate::{core::Core, knowledge};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const MAX_PAGE: usize = 20;
const MAX_PENDING: usize = 8;
const MAX_OPERATIONS: usize = 64;
const LIFETIME: Duration = Duration::from_secs(300);

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub view_id: String,
    pub workspace_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRequest {
    pub context: Context,
    pub offset: usize,
    pub limit: usize,
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Upgrade,
    Quarantine,
    Restore,
}
impl Operation {
    fn name(self) -> &'static str {
        match self {
            Self::Upgrade => "upgrade",
            Self::Quarantine => "quarantine",
            Self::Restore => "restore",
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    pub context: Context,
    pub operation: Operation,
    pub candidate_id: Option<String>,
    #[serde(default)]
    pub candidate_ids: Option<Vec<String>>,
    pub snapshot_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Confirmation {
    pub context: Context,
    pub plan_id: String,
    pub confirmation: String,
}

enum Phase {
    Pending,
    Cancelled,
    Failed(&'static str),
    Completed(Value),
}
struct RecordMetadata {
    id: String,
    root: String,
    path: String,
    revision: i64,
    generation: i64,
    bytes: i64,
    hash: String,
}
impl From<&Record> for RecordMetadata {
    fn from(r: &Record) -> Self {
        Self {
            id: r.id.clone(),
            root: r.root.clone(),
            path: r.path.clone(),
            revision: r.revision,
            generation: r.generation,
            bytes: r.bytes,
            hash: recovery_store::payload_hash(&r.data),
        }
    }
}
struct Plan {
    context: Context,
    operation: Operation,
    snapshot_id: String,
    database_id: String,
    root_identity: Option<String>,
    workspace_revision: u64,
    selections: Vec<Selection>,
    issued: Instant,
    cancelled: AtomicBool,
    phase: Mutex<Phase>,
}
struct Selection {
    candidate_id: String,
    operation_id: String,
    record: RecordMetadata,
    path: String,
    app_count: usize,
}
#[derive(Default)]
pub(crate) struct Service {
    plans: Mutex<BTreeMap<String, Arc<Plan>>>,
}
pub(crate) fn fail(code: &'static str) -> InspectionError {
    let message = match code {
        "in_use_hold" => "This document is open or opening. Close all its views, including browser views, and inspect again.",
        "source_unavailable_hold" => "The same physical source could not be confirmed. Missing, moved, offline or incomplete observations are held.",
        "explicit_upgrade_required" => "Recovery requires an explicitly confirmed schema v2 upgrade. Older apps cannot use schema v2.",
        "restore_conflict_or_quota" => "An existing value or the active quota prevents restoration. No value was overwritten.",
        "explicit_confirmation_required" => "Confirm this exact preview before applying it.",
        "state_changed" | "context_changed" => "The saved state, root or view changed. Inspect and explicitly select again.",
        "expired_plan" => "The preview expired. Inspect and explicitly select again.",
        "cancelled" => "The operation was cancelled before its atomic decision.",
        "management_busy" => "Saved-state management is busy. Wait for the current operation.",
        _ => "Saved-state management stopped this operation. Existing data was retained; inspect and select again.",
    };
    error(code, message)
}
fn sql(error: rusqlite::Error) -> InspectionError {
    backend_error(super::sql_error(error))
}
fn check_context(core: &Core, context: &Context) -> Result<u64, InspectionError> {
    let state = core
        .workspace
        .lock()
        .map_err(|_| fail("state_unavailable"))?;
    if state.snapshot.view_id != context.view_id
        || state.snapshot.workspace_id != context.workspace_id
    {
        return Err(fail("context_changed"));
    }
    Ok(state.snapshot.revision)
}
fn connected(core: &Core, profile: &std::path::Path) -> Option<ConnectedRoot> {
    let state = core.workspace.lock().ok()?;
    if state.snapshot.watch_error.is_some() {
        return None;
    }
    let root = state.root.as_ref()?;
    let dir = state.dir.as_ref()?;
    let connected = ConnectedRoot::open(root, profile).ok()?;
    (knowledge::storage_root_identity(dir).ok().as_ref() == Some(&connected.identity))
        .then_some(connected)
}
fn availability(
    root: Option<&ConnectedRoot>,
    observation: Option<&Observation>,
    id: &str,
    root_id: &str,
    path: &str,
) -> (Availability, Option<String>) {
    match (root, observation) {
        (Some(root), Some(observation)) if root.identity == root_id && observation.complete => {
            root.locate(observation, id, path)
        }
        _ => (Availability::Unavailable, None),
    }
}
fn in_use(core: &Core, id: &str, paths: &[&str]) -> bool {
    let Ok(state) = core.workspace.lock() else {
        return true;
    };
    state.tabs.values().any(|tab| {
        paths.contains(&tab.entry.as_str())
            || tab.expected_identity.as_deref() == Some(id)
            || tab
                .session
                .as_ref()
                .and_then(|session| session.storage_identity.as_deref())
                == Some(id)
            || match (&state.root, &state.dir) {
                (Some(root), Some(dir)) => {
                    knowledge::storage_identity(root, dir, &tab.entry)
                        .ok()
                        .as_deref()
                        == Some(id)
                }
                _ => false,
            }
    })
}
fn source_name(value: Availability) -> &'static str {
    match value {
        Availability::SameIdentity => "same_identity_present",
        Availability::RelocatedIdentity => "same_identity_relocated",
        Availability::DifferentIdentityAtPath => "different_identity_recovery_history",
        Availability::NotFoundInCompleteScan => "not_found_single_scan",
        Availability::Unavailable => "unavailable",
    }
}
fn target(
    core: &Core,
    root: Option<&ConnectedRoot>,
    observation: Option<&Observation>,
    record: &Record,
) -> Result<String, InspectionError> {
    let (source, path) = availability(root, observation, &record.id, &record.root, &record.path);
    if !matches!(source, Availability::SameIdentity) {
        return Err(fail("source_unavailable_hold"));
    }
    let path = path.ok_or_else(|| fail("source_unavailable_hold"))?;
    if in_use(core, &record.id, &[&record.path, &path]) {
        return Err(fail("in_use_hold"));
    }
    Ok(path)
}
struct Budget<'a> {
    connection: &'a Connection,
    deadline: Instant,
}
impl<'a> Budget<'a> {
    fn new(connection: &'a Connection, plan: Option<Arc<Plan>>) -> Result<Self, InspectionError> {
        let deadline = Instant::now() + Duration::from_secs(2);
        connection
            .progress_handler(
                1000,
                Some(move || {
                    Instant::now() >= deadline
                        || plan.as_ref().is_some_and(|p| {
                            p.cancelled.load(Ordering::Acquire) || p.issued.elapsed() >= LIFETIME
                        })
                }),
            )
            .map_err(sql)?;
        Ok(Self {
            connection,
            deadline,
        })
    }
    fn check(&self) -> Result<(), InspectionError> {
        if Instant::now() >= self.deadline {
            Err(fail("inspection_limit"))
        } else {
            Ok(())
        }
    }
}
impl Drop for Budget<'_> {
    fn drop(&mut self) {
        let _ = self.connection.progress_handler(0, None::<fn() -> bool>);
    }
}
struct Transaction<'a>(Option<rusqlite::Transaction<'a>>);
impl<'a> Transaction<'a> {
    fn begin(connection: &'a Connection) -> Result<Self, InspectionError> {
        recovery_store::begin_atomic(connection)
            .map(|t| Self(Some(t)))
            .map_err(sql)
    }
    fn commit(mut self) -> Result<(), InspectionError> {
        self.progress_handler(0, None::<fn() -> bool>)
            .map_err(sql)?;
        self.0.take().unwrap().commit().map_err(sql)
    }
}
impl std::ops::Deref for Transaction<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0.as_ref().unwrap()
    }
}
impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if let Some(t) = self.0.take() {
            let _ = t.progress_handler(0, None::<fn() -> bool>);
            let _ = t.finish();
        }
    }
}
fn snapshot(
    connection: &Connection,
    bytes: u64,
    database_id: &str,
    limit: usize,
    offset: usize,
    expected: Option<&str>,
) -> Result<super::Report, InspectionError> {
    crate::identifier_migration::validate_schema(connection).map_err(backend_error)?;
    if bytes
        > crate::identifier_migration::database_size_limit(connection).map_err(backend_error)?
    {
        return Err(backend_error(
            crate::identifier_migration::MigrationError::Corrupt,
        ));
    }
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(sql)?;
    if version >= 2 {
        recovery_store::validate_metadata(connection).map_err(backend_error)?;
    }
    report(connection, bytes, database_id, limit, offset, expected).map_err(backend_error)
}
fn usage(report: &super::Report) -> Value {
    json!({"logicalBytes":report.usage.logical_bytes,"records":report.usage.records,"recoveryLogicalBytes":report.recovery_logical_bytes,"recoveryRecords":report.recovery_records,"databaseBytes":report.database_bytes,"journalBytes":report.journal_bytes,"freeDatabasePageBytes":report.free_database_page_bytes})
}

pub fn inspect(
    core: &Core,
    request: PageRequest,
    recovery: bool,
) -> Result<Value, InspectionError> {
    let query = request.query.as_deref().unwrap_or("").trim();
    if !(1..=MAX_PAGE).contains(&request.limit)
        || request.offset > 4096
        || query.len() > 1024
        || query.chars().any(char::is_control)
    {
        return Err(fail("invalid_arguments"));
    }
    let _gate = core.gate.lock().map_err(|_| fail("state_unavailable"))?;
    check_context(core, &request.context)?;
    core.document_state.get().ok_or_else(||fail("state_unavailable"))?.management_connection(|connection,profile,database_id,bytes| {
        let _budget=Budget::new(connection,None)?;
        let transaction=Transaction::begin(connection)?;
        let report=snapshot(&transaction,bytes,database_id,request.limit,request.offset,request.snapshot_id.as_deref())?;
        let root=connected(core,profile); let observation=root.as_ref().map(ConnectedRoot::scan);
        let mut entries=Vec::new();
        if recovery && report.database_schema_version>=2 {
            let mut statement=transaction.prepare("SELECT operation_id,document_id,root,path,revision,bytes,status,restored_revision FROM recovery_records WHERE instr(lower(path),lower(?1))>0 ORDER BY operation_id LIMIT ?2 OFFSET ?3").map_err(sql)?;
            let rows=statement.query_map(rusqlite::params![query,request.limit as i64,request.offset as i64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,String>(6)?,r.get::<_,Option<i64>>(7)?))).map_err(sql)?;
            for row in rows {
                let (recovery_id,id,root_id,path,revision,bytes,status,restored_revision)=row.map_err(sql)?;
                let (source,current_path)=availability(root.as_ref(),observation.as_ref(),&id,&root_id,&path);
                let exists:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1)",[&id],|r|r.get(0)).map_err(sql)?;
                let hold=if status!="quarantined"||exists {Some("restore_conflict_or_quota")} else if !matches!(source,Availability::SameIdentity) {Some("source_unavailable_hold")} else if in_use(core,&id,&[&path,current_path.as_deref().unwrap_or(&path)]) {Some("in_use_hold")} else {None};
                entries.push(json!({"recoveryId":recovery_id,"documentIdentity":id,"rootIdentity":root_id,"relativePath":path,"sourceRevision":revision,"logicalBytes":bytes,"status":status,"restoredRevision":restored_revision,"sourceAvailability":source_name(source),"restorable":hold.is_none(),"holdReason":hold}));
            }
        } else if !recovery {
            // The global snapshot validates all bounded metadata. Filter the
            // complete metadata set before paging; never select saved payloads.
            let mut statement=transaction.prepare("SELECT id,root,path,bytes,revision FROM documents WHERE instr(lower(path),lower(?1))>0 ORDER BY id LIMIT ?2 OFFSET ?3").map_err(sql)?;
            let rows=statement.query_map(rusqlite::params![query,request.limit as i64,request.offset as i64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?))).map_err(sql)?;
            for row in rows {
                let (id,root_id,path,bytes,revision)=row.map_err(sql)?;
                let (source,current_path)=availability(root.as_ref(),observation.as_ref(),&id,&root_id,&path);
                let hold=if !matches!(source,Availability::SameIdentity) {Some("source_unavailable_hold")} else if in_use(core,&id,&[&path,current_path.as_deref().unwrap_or(&path)]) {Some("in_use_hold")} else if !matches!(report.database_schema_version,2|3) {Some("explicit_upgrade_required")} else {None};
                entries.push(json!({"documentIdentity":id,"rootIdentity":root_id,"relativePath":path,"logicalBytes":bytes,"revision":revision,"sourceAvailability":source_name(source),"lastViewedAt":null,"eligible":hold.is_none(),"holdReason":hold}));
            }
        }
        let total:i64=if recovery && report.database_schema_version<2 {0}else {
            let table=if recovery {"recovery_records"}else{"documents"};
            transaction.query_row(&format!("SELECT count(*) FROM {table} WHERE instr(lower(path),lower(?1))>0"),[query],|r|r.get(0)).map_err(sql)?
        };
        let value=json!({"snapshotId":report.snapshot_id,"databaseSchemaVersion":report.database_schema_version,"usage":usage(&report),"entries":entries,"offset":request.offset,"limit":request.limit,"matchedRecords":total,"hasMore":request.offset.saturating_add(request.limit)<total as usize});
        Ok(value)
    })
}

pub fn prepare(core: &Core, request: PrepareRequest) -> Result<Value, InspectionError> {
    let candidate_ids = match &request.candidate_ids {
        Some(ids) => {
            if request.operation != Operation::Quarantine
                || request.candidate_id.is_some()
                || !(1..=MAX_PAGE).contains(&ids.len())
                || ids.iter().any(|id| !super::digest_id(id))
                || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
            {
                return Err(fail("invalid_arguments"));
            }
            ids.clone()
        }
        None => request.candidate_id.clone().into_iter().collect(),
    };
    let _gate = core.gate.lock().map_err(|_| fail("state_unavailable"))?;
    let workspace_revision = check_context(core, &request.context)?;
    let mut plans = core
        .live_management
        .plans
        .lock()
        .map_err(|_| fail("state_unavailable"))?;
    plans.retain(|_, p| p.issued.elapsed() < LIFETIME);
    if plans.len() >= MAX_OPERATIONS
        || plans
            .values()
            .filter(|p| {
                p.phase
                    .try_lock()
                    .map_or(true, |v| matches!(*v, Phase::Pending))
            })
            .count()
            >= MAX_PENDING
    {
        return Err(fail("plan_limit"));
    }
    let (plan,preview)=core.document_state.get().ok_or_else(||fail("state_unavailable"))?.management_connection(|connection,profile,database_id,bytes| {
        let budget=Budget::new(connection,None)?;let transaction=Transaction::begin(connection)?;
        let report=snapshot(&transaction,bytes,database_id,1,0,Some(&request.snapshot_id))?;
        let root=connected(core,profile);
        let candidate_id=request.candidate_id.clone().unwrap_or_default();
        let plan_id=crate::core::random_token();
        let mut selections=Vec::new();
        let mut entries=Vec::new();
        let mut logical_bytes=0i64;
        let mut app_count=0usize;
        if request.operation==Operation::Upgrade {
            if report.database_schema_version!=1||!candidate_id.is_empty() {return Err(fail("upgrade_not_needed"));}
        } else {
            if !matches!(report.database_schema_version,2|3) {return Err(fail("explicit_upgrade_required"));}
            if candidate_ids.is_empty() {return Err(fail("invalid_arguments"));}
            let observation=root.as_ref().map(ConnectedRoot::scan);
            for id in &candidate_ids {
                budget.check()?;
                let record=management::read_record(&transaction,id,request.operation==Operation::Restore)?;
                let path=target(core,root.as_ref(),observation.as_ref(),&record)?;
                let count=recovery_store::validated_app_count(&record.data,record.bytes).map_err(backend_error)?;
                if request.operation==Operation::Restore {
                    let exists:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1)",[&record.id],|r|r.get(0)).map_err(sql)?;
                    super::assessment::check_restore_budget_with_limits(report.usage.logical_bytes,report.usage.records,record.bytes,count,exists,crate::storage_limits::read(&transaction).map_err(backend_error)?).map_err(|_|fail("restore_conflict_or_quota"))?;
                }
                logical_bytes=logical_bytes.checked_add(record.bytes).ok_or_else(||fail("inspection_limit"))?;
                app_count=app_count.checked_add(count).ok_or_else(||fail("inspection_limit"))?;
                entries.push(json!({"documentIdentity":record.id,"relativePath":path,"logicalBytes":record.bytes,"appCount":count}));
                selections.push(Selection{candidate_id:id.clone(),operation_id:if candidate_ids.len()==1 {plan_id.clone()}else{crate::core::random_token()},record:RecordMetadata::from(&record),path,app_count:count});
            }
        }
        if request.operation==Operation::Quarantine {
            check_archive_budget(&transaction,logical_bytes,selections.len())?;
        }
        budget.check()?;
        let single=if selections.len()==1 {selections.first()}else{None};
        let preview=json!({"planId":plan_id,"operation":request.operation.name(),"snapshotId":report.snapshot_id,"candidateId":candidate_id,"documentIdentity":single.map(|s|&s.record.id),"relativePath":single.map(|s|&s.path),"logicalBytes":logical_bytes,"appCount":app_count,"documentCount":selections.len(),"entries":entries,"canConfirm":true,"blockedReason":null,"expiresInMs":300000});
        let plan=Plan{context:request.context.clone(),operation:request.operation,snapshot_id:report.snapshot_id,database_id:report.database_id,root_identity:root.map(|r|r.identity),workspace_revision,selections,issued:Instant::now(),cancelled:AtomicBool::new(false),phase:Mutex::new(Phase::Pending)};
        Ok((Arc::new(plan),preview))
    })?;
    plans.insert(preview["planId"].as_str().unwrap().to_owned(), plan);
    Ok(preview)
}
fn check_archive_budget(
    connection: &Connection,
    bytes: i64,
    count: usize,
) -> Result<(), InspectionError> {
    let (archive_bytes, archive_count): (i64, i64) = connection
        .query_row(
            "SELECT coalesce(sum(bytes),0),count(*) FROM recovery_records",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql)?;
    if archive_bytes
        .checked_add(bytes)
        .is_none_or(|total| total > recovery_store::MAX_ARCHIVE_BYTES)
        || archive_count
            .checked_add(count as i64)
            .is_none_or(|total| total > recovery_store::MAX_ARCHIVE_RECORDS)
    {
        return Err(fail("recovery_capacity_reached"));
    }
    Ok(())
}
fn find(core: &Core, context: &Context, id: &str) -> Result<Arc<Plan>, InspectionError> {
    if !super::digest_id(id) {
        return Err(fail("invalid_arguments"));
    }
    let plan = core
        .live_management
        .plans
        .lock()
        .map_err(|_| fail("state_unavailable"))?
        .get(id)
        .cloned()
        .ok_or_else(|| fail("unknown_or_consumed_plan"))?;
    if &plan.context != context {
        return Err(fail("context_changed"));
    }
    Ok(plan)
}
fn check_plan(core: &Core, plan: &Plan) -> Result<(), InspectionError> {
    if plan.cancelled.load(Ordering::Acquire) {
        return Err(fail("cancelled"));
    }
    if plan.issued.elapsed() >= LIFETIME {
        return Err(fail("expired_plan"));
    }
    if check_context(core, &plan.context)? != plan.workspace_revision {
        return Err(fail("context_changed"));
    }
    Ok(())
}
pub fn confirm(core: &Core, confirmation: Confirmation) -> Result<Value, InspectionError> {
    if confirmation.plan_id != confirmation.confirmation {
        return Err(fail("explicit_confirmation_required"));
    }
    let plan = find(core, &confirmation.context, &confirmation.plan_id)?;
    let mut phase = plan.phase.try_lock().map_err(|_| fail("management_busy"))?;
    match &*phase {
        Phase::Completed(receipt) => return Ok(receipt.clone()),
        Phase::Pending => (),
        _ => return Err(fail("plan_not_pending")),
    }
    let _gate = core.gate.lock().map_err(|_| fail("state_unavailable"))?;
    let result = (|| {
        check_plan(core, &plan)?;
        core.document_state.get().ok_or_else(||fail("state_unavailable"))?.management_connection(|connection,profile,database_id,bytes| {
            let budget=Budget::new(connection,Some(plan.clone()))?;
            let transaction=Transaction::begin(connection)?;
            let report=snapshot(&transaction,bytes,database_id,1,0,Some(&plan.snapshot_id))?;
            if report.database_id!=plan.database_id {return Err(fail("state_changed"));}
            let root=connected(core,profile);
            if root.as_ref().map(|r|&r.identity)!=plan.root_identity.as_ref() {return Err(fail("source_unavailable_hold"));}
            let receipt=if plan.operation==Operation::Upgrade {
                if report.database_schema_version!=1 {return Err(fail("upgrade_not_needed"));}
                // Explicit upgrade uses the CLI's value/schema validation too;
                // inspection alone only validates bounded metadata.
                crate::identifier_migration::validate_db(&transaction).map_err(backend_error)?;
                transaction.execute_batch(&format!("{}; {}; PRAGMA user_version=2;",recovery_store::RECORDS_DDL,recovery_store::TOMBSTONES_DDL)).map_err(sql)?;
                recovery_store::validate(&transaction).map_err(backend_error)?;
                json!({"operationId":confirmation.plan_id,"operation":"upgrade","schemaVersion":2,"recoverable":true,"permanentDeletion":false})
            } else {
                let observation=root.as_ref().map(ConnectedRoot::scan);
                // Validate every selection before any mutation; only metadata
                // and hashes survive between reads, keeping payload memory bounded.
                for selection in &plan.selections {
                    budget.check()?;
                    check_plan(core,&plan)?;
                    let record=management::read_record(&transaction,&selection.candidate_id,plan.operation==Operation::Restore)?;
                    let expected=&selection.record;
                    if record.id!=expected.id||record.root!=expected.root||record.path!=expected.path||record.revision!=expected.revision||record.generation!=expected.generation||record.bytes!=expected.bytes||recovery_store::payload_hash(&record.data)!=expected.hash {return Err(fail("state_changed"));}
                    let path=target(core,root.as_ref(),observation.as_ref(),&record)?;
                    if path!=selection.path {return Err(fail("source_changed"));}
                }
                if plan.operation==Operation::Quarantine {
                    check_archive_budget(&transaction,plan.selections.iter().map(|s|s.record.bytes).sum(),plan.selections.len())?;
                }
                let mut entries=Vec::new();
                for selection in &plan.selections {
                    budget.check()?;
                    check_plan(core,&plan)?;
                    let record=management::read_record(&transaction,&selection.candidate_id,plan.operation==Operation::Restore)?;
                    let (revision,generation)=management::apply_record(&transaction,&record,&selection.path,&selection.operation_id,&selection.candidate_id,selection.app_count,plan.operation==Operation::Restore)?;
                    entries.push(json!({"documentIdentity":record.id,"relativePath":selection.path,"logicalBytes":record.bytes,"appCount":selection.app_count,"revision":revision,"databaseGeneration":generation,"recoveryId":if plan.operation==Operation::Restore {&selection.candidate_id}else{&selection.operation_id}}));
                }
                recovery_store::validate_metadata(&transaction).map_err(backend_error)?;
                for selection in &plan.selections {
                    if root.as_ref().and_then(|r|r.identity_at(&selection.path).ok()).as_deref()!=Some(&selection.record.id)||in_use(core,&selection.record.id,&[&selection.record.path,&selection.path]) {return Err(fail("source_unavailable_hold"));}
                }
                let mut receipt=json!({"operationId":confirmation.plan_id,"operation":plan.operation.name(),"documentCount":entries.len(),"logicalBytes":plan.selections.iter().map(|s|s.record.bytes).sum::<i64>(),"appCount":plan.selections.iter().map(|s|s.app_count).sum::<usize>(),"entries":entries,"recoverable":true,"permanentDeletion":false});
                if entries.len()==1 {
                    for key in ["documentIdentity","revision","databaseGeneration","recoveryId"] {receipt[key]=entries[0][key].clone();}
                }
                receipt
            };
            budget.check()?;
            check_plan(core,&plan)?;
            core.document_state.get().ok_or_else(||fail("state_unavailable"))?.verify_management()?;
            transaction.commit()?;Ok(receipt)
        })
    })();
    match result {
        Ok(receipt) => {
            *phase = Phase::Completed(receipt.clone());
            Ok(receipt)
        }
        Err(error) => {
            *phase = Phase::Failed(error.code);
            Err(error)
        }
    }
}
pub fn cancel(core: &Core, context: &Context, id: &str) -> Result<Value, InspectionError> {
    let plan = find(core, context, id)?;
    plan.cancelled.store(true, Ordering::Release);
    let result = match plan.phase.try_lock() {
        Ok(mut phase) => match &*phase {
            Phase::Completed(receipt) => {
                Ok(json!({"status":"completed","receipt":receipt,"verifyRequired":true}))
            }
            Phase::Pending => {
                *phase = Phase::Cancelled;
                Ok(json!({"status":"cancelled","verifyRequired":true}))
            }
            Phase::Cancelled => Ok(json!({"status":"cancelled","verifyRequired":true})),
            Phase::Failed(code) => Ok(json!({"status":"failed","code":code,"verifyRequired":true})),
        },
        Err(_) => Ok(json!({"status":"cancel_requested","verifyRequired":true})),
    };
    result
}
pub fn verify(core: &Core, context: &Context, id: &str) -> Result<Value, InspectionError> {
    let mut failed_code = None;
    let mut failed_upgrade = false;
    let mut failed_bulk = None;
    if let Ok(plan) = find(core, context, id) {
        match plan.phase.try_lock() {
            Ok(phase) => match &*phase {
                Phase::Pending => return Ok(json!({"status":"pending"})),
                Phase::Cancelled => return Ok(json!({"status":"cancelled"})),
                // A failed response after COMMIT must be reconciled with the
                // durable operation ID before claiming failure/rollback.
                Phase::Failed(code) => {
                    failed_code = Some(*code);
                    failed_upgrade = plan.operation == Operation::Upgrade;
                    if plan.selections.len() > 1 {
                        failed_bulk = Some(plan.clone());
                    }
                }
                Phase::Completed(receipt) => {
                    return Ok(json!({"status":"completed","receipt":receipt}))
                }
            },
            Err(_) => return Ok(json!({"status":"pending"})),
        };
    }
    if !super::digest_id(id) {
        return Err(fail("invalid_arguments"));
    }
    let _gate = core.gate.lock().map_err(|_| fail("state_unavailable"))?;
    check_context(core, context)?;
    core.document_state.get().ok_or_else(||fail("state_unavailable"))?.management_connection(|connection,_,_,_| {
        let _budget=Budget::new(connection,None)?;
        let version:i64=connection.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(sql)?;
        // Upgrade has no durable operation-ID row. A current schema alone
        // cannot prove which request committed after a lost response.
        if failed_upgrade {return Ok(json!({"status":"unknown","currentSchemaVersion":version}));}
        if !matches!(version,2|3) {return Ok(json!({"status":"unknown"}));}
        recovery_store::validate_metadata(connection).map_err(backend_error)?;
        if let Some(plan)=&failed_bulk {
            // Every child ID must match its bound metadata. A surviving plan
            // can reconcile a lost COMMIT response, never just one archive row.
            // Without that plan the main bulk ID has no durable row, so the
            // fallback below honestly returns unknown instead of partial success.
            let mut entries=Vec::new();
            for selection in &plan.selections {
                let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM recovery_records WHERE operation_id=?1 AND document_id=?2 AND revision=?3 AND bytes=?4 AND payload_hash=?5 AND root=?6 AND path=?7)",rusqlite::params![selection.operation_id,selection.record.id,selection.record.revision,selection.record.bytes,selection.record.hash,selection.record.root,selection.path],|r|r.get(0)).map_err(sql)?;
                if exists {entries.push(json!({"documentIdentity":selection.record.id,"relativePath":selection.path,"logicalBytes":selection.record.bytes,"appCount":selection.app_count,"revision":selection.record.revision,"recoveryId":selection.operation_id}));}
            }
            return Ok(if entries.len()==plan.selections.len() {
                json!({"status":"completed","receipt":{"operationId":id,"operation":"quarantine","documentCount":entries.len(),"logicalBytes":plan.selections.iter().map(|s|s.record.bytes).sum::<i64>(),"appCount":plan.selections.iter().map(|s|s.app_count).sum::<usize>(),"entries":entries,"recoverable":true,"permanentDeletion":false}})
            } else if entries.is_empty() {
                json!({"status":"failed","code":failed_code})
            } else {json!({"status":"unknown"})});
        }
        let receipt=connection.query_row("SELECT operation_id,document_id,revision,restore_operation_id,restored_revision FROM recovery_records WHERE operation_id=?1 OR restore_operation_id=?1",[id],|r|{
            let recovery_id:String=r.get(0)?;let restore_id:Option<String>=r.get(3)?;let restore=restore_id.as_deref()==Some(id);
            Ok(json!({"operationId":id,"operation":if restore {"restore"}else{"quarantine"},"documentIdentity":r.get::<_,String>(1)?,"revision":if restore {r.get::<_,Option<i64>>(4)?.unwrap_or(0)}else{r.get::<_,i64>(2)?},"recoveryId":recovery_id,"recoverable":true,"permanentDeletion":false}))
        }).optional().map_err(sql)?;
        Ok(match receipt {Some(receipt)=>json!({"status":"completed","receipt":receipt}),None=>if let Some(code)=failed_code {json!({"status":"failed","code":code})}else{json!({"status":"unknown"})}})
    })
}

#[cfg(test)]
#[path = "live_tests.rs"]
mod tests;
