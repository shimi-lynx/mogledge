//! Main-host-only live transfer. Uses the existing Core gate and DB connection;
//! it never opens a stopped-profile session or trusts a document storage token.
use super::{
    failure, files, format, format_error, product_version, sql_error, StateRecord, TransferError,
};
use crate::{core::Core, knowledge, state_inspection::recovery_store};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const MAX_FILES: usize = 16;
const MAX_PENDING: usize = 8;
const MAX_OPERATIONS: usize = 64;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Import,
    Export,
    Backup,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub workspace_id: String,
    pub view_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    pub context: Context,
    pub relative_path: String,
    pub file_id: String,
    pub backup_file_id: Option<String>,
    // The bundled host supplies its active column IDs. Native does not infer
    // unflushed input from dirty/tree freshness or from a saved DB revision.
    pub active_tab_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Confirmation {
    pub context: Context,
    pub plan_id: String,
    pub confirmation: String,
    pub replace_confirmation: Option<String>,
    pub stop_reload_confirmation: Option<String>,
}

struct SelectedFile {
    context: Context,
    kind: FileKind,
    location: files::Location,
    expires: Instant,
}

#[derive(Clone, PartialEq, Eq)]
struct Grant {
    id: String,
    entry: String,
    browser: bool,
    request: u64,
    revocation: u64,
    token: Option<String>,
    document_identity: Option<String>,
}
struct Target {
    root_identity: String,
    identity: String,
    workspace_revision: u64,
    grants: Vec<Grant>,
}
enum Action {
    Export {
        output: Arc<SelectedFile>,
    },
    Import {
        input: Arc<SelectedFile>,
        file_identity: (u64, u128),
        hash: String,
        backup: Option<Arc<SelectedFile>>,
    },
}
enum Phase {
    Pending,
    Failed(Value),
    Cancelled,
    Completed(Value),
}
struct Plan {
    context: Context,
    path: String,
    identity: String,
    root_identity: String,
    workspace_revision: u64,
    revision: i64,
    generation: i64,
    grants: Vec<Grant>,
    expires: Instant,
    action: Action,
    cancelled: AtomicBool,
    phase: Mutex<Phase>,
}

#[derive(Default)]
pub(crate) struct Service {
    files: Mutex<BTreeMap<String, Arc<SelectedFile>>>,
    plans: Mutex<BTreeMap<String, Arc<Plan>>>,
    // Must live until after Core.document_state is dropped. Closing even a
    // rejected DB hardlink alias can release another fd's POSIX SQLite locks.
    input_files: Mutex<Vec<std::fs::File>>,
}

fn check_context(core: &Core, context: &Context) -> Result<(), TransferError> {
    let workspace = core
        .workspace
        .lock()
        .map_err(|_| failure("state_unavailable"))?;
    if workspace.snapshot.workspace_id.as_deref() != Some(&context.workspace_id)
        || workspace.snapshot.view_id != context.view_id
    {
        return Err(failure("context_changed"));
    }
    Ok(())
}

// Caller holds Core.gate. The physical match also finds aliases and session-less
// tabs whose initial read is still running outside the gate.
fn target(core: &Core, context: &Context, path: &str) -> Result<Target, TransferError> {
    check_context(core, context)?;
    if !knowledge::is_html(path) {
        return Err(failure("invalid_html_target"));
    }
    let workspace = core
        .workspace
        .lock()
        .map_err(|_| failure("state_unavailable"))?;
    if !knowledge::contains(&workspace.snapshot.nodes, path) {
        return Err(failure("target_unavailable"));
    }
    let root = workspace
        .root
        .clone()
        .ok_or_else(|| failure("context_changed"))?;
    let dir = workspace
        .dir
        .clone()
        .ok_or_else(|| failure("context_changed"))?;
    let identity = knowledge::storage_identity(&root, &dir, path)
        .map_err(|_| failure("target_unavailable"))?;
    let root_identity =
        knowledge::storage_root_identity(&dir).map_err(|_| failure("context_changed"))?;
    let mut grants = Vec::new();
    for (id, tab) in &workspace.tabs {
        if tab.entry == path
            || tab
                .session
                .as_ref()
                .and_then(|s| s.storage_identity.as_ref())
                == Some(&identity)
            || knowledge::storage_identity(&root, &dir, &tab.entry)
                .ok()
                .as_ref()
                == Some(&identity)
        {
            grants.push(Grant {
                id: id.clone(),
                entry: tab.entry.clone(),
                browser: tab.browser,
                request: tab.latest_request,
                revocation: tab.revocation,
                token: tab.session.as_ref().map(|s| s.token.clone()),
                document_identity: tab
                    .session
                    .as_ref()
                    .and_then(|s| s.storage_identity.clone()),
            });
        }
    }
    grants.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Target {
        root_identity,
        identity,
        workspace_revision: workspace.snapshot.revision,
        grants,
    })
}

fn record(connection: &Connection, id: &str) -> Result<Option<StateRecord>, TransferError> {
    if recovery_store::is_quarantined(connection, id).map_err(|_| failure("state_corrupt"))? {
        return Err(failure("target_quarantined_hold"));
    }
    connection
        .query_row(
            "SELECT data,bytes,revision,generation,root,path FROM documents WHERE id=?1",
            [id],
            |row| {
                Ok(StateRecord {
                    data: crate::document_state::raw_json::copy_sql(row, 0)?,
                    bytes: row.get(1)?,
                    revision: row.get(2)?,
                    generation: row.get(3)?,
                    root: row.get(4)?,
                    path: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(sql_error)
}
fn portable(
    id: &str,
    old: &StateRecord,
    target: &Target,
    path: &str,
) -> Result<format::ValidatedTransfer, TransferError> {
    if old.bytes != old.data.len() as i64 || old.root != target.root_identity {
        return Err(failure("state_corrupt"));
    }
    format::from_state(
        &product_version()?,
        format::Source {
            root_identity: target.root_identity.clone(),
            document_identity: id.to_owned(),
            relative_path: path.to_owned(),
            revision: old.revision,
            generation: old.generation,
        },
        &old.data,
    )
    .map_err(format_error)
}
fn quota(
    connection: &Connection,
    old: Option<&StateRecord>,
    incoming: i64,
) -> Result<(i64, i64, i64), TransferError> {
    let (bytes, count, generation): (i64, i64, i64) = connection
        .query_row(
            "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(sql_error)?;
    let limits = crate::storage_limits::read(connection)
        .map_err(|error| failure(crate::state_inspection::backend_error(error).code))?;
    if !(0..=limits.total_bytes).contains(&bytes)
        || !(0..=super::MAX_DOCUMENTS).contains(&count)
        || generation < 0
    {
        return Err(failure("state_corrupt"));
    }
    if incoming > limits.document_bytes as i64 {
        return Err(failure("quota_exceeded"));
    }
    let bytes = bytes
        .checked_sub(old.map_or(0, |v| v.bytes))
        .and_then(|v| v.checked_add(incoming))
        .filter(|v| (0..=limits.total_bytes).contains(v))
        .ok_or_else(|| failure("quota_exceeded"))?;
    let count = count
        .checked_add(i64::from(old.is_none()))
        .filter(|v| (0..=super::MAX_DOCUMENTS).contains(v))
        .ok_or_else(|| failure("quota_exceeded"))?;
    let generation = generation
        .checked_add(1)
        .ok_or_else(|| failure("revision_limit"))?;
    Ok((bytes, count, generation))
}

struct SqlBudget<'a>(&'a Connection);
// Drop paths must disable interruption before rollback too, including errors
// that occur before the explicit final transaction decision.
struct LiveTransaction<'a>(Option<rusqlite::Transaction<'a>>);
impl<'a> LiveTransaction<'a> {
    fn begin(connection: &'a Connection) -> Result<Self, TransferError> {
        recovery_store::begin_atomic(connection)
            .map(|t| Self(Some(t)))
            .map_err(sql_error)
    }
    fn finish(mut self) -> Result<(), TransferError> {
        self.progress_handler(0, None::<fn() -> bool>)
            .map_err(sql_error)?;
        self.0.take().unwrap().finish().map_err(sql_error)
    }
    fn commit(mut self) -> Result<(), TransferError> {
        self.progress_handler(0, None::<fn() -> bool>)
            .map_err(sql_error)?;
        self.0.take().unwrap().commit().map_err(sql_error)
    }
}
impl std::ops::Deref for LiveTransaction<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0.as_ref().unwrap()
    }
}
impl Drop for LiveTransaction<'_> {
    fn drop(&mut self) {
        if let Some(transaction) = self.0.take() {
            let _ = transaction.progress_handler(0, None::<fn() -> bool>);
            let _ = transaction.finish();
        }
    }
}
impl<'a> SqlBudget<'a> {
    fn new(
        connection: &'a Connection,
        cancelled: Option<Arc<Plan>>,
    ) -> Result<Self, TransferError> {
        let deadline = Instant::now() + Duration::from_secs(2);
        connection
            .progress_handler(
                1000,
                Some(move || {
                    Instant::now() >= deadline
                        || cancelled
                            .as_ref()
                            .is_some_and(|p| p.cancelled.load(Ordering::Acquire))
                }),
            )
            .map_err(sql_error)?;
        Ok(Self(connection))
    }
}
impl Drop for SqlBudget<'_> {
    fn drop(&mut self) {
        let _ = self.0.progress_handler(0, None::<fn() -> bool>);
    }
}

fn selected(core: &Core, context: &Context, id: &str) -> Result<Arc<SelectedFile>, TransferError> {
    let files = core
        .live_transfer
        .files
        .lock()
        .map_err(|_| failure("state_unavailable"))?;
    let file = files
        .get(id)
        .cloned()
        .ok_or_else(|| failure("selected_file_required"))?;
    if file.context.workspace_id != context.workspace_id
        || file.context.view_id != context.view_id
        || Instant::now() >= file.expires
    {
        return Err(failure("selected_file_changed"));
    }
    file.location.verify()?;
    Ok(file)
}

// Only the Native picker calls this in production. IDs, not arbitrary paths,
// cross prepare/confirm IPC. The selected physical parent stays held by Location.
pub fn select_file(
    core: &Core,
    context: Context,
    kind: FileKind,
    path: &Path,
) -> Result<Value, TransferError> {
    let _gate = core.gate.lock().map_err(|_| failure("state_unavailable"))?;
    check_context(core, &context)?;
    let state = core
        .document_state
        .get()
        .ok_or_else(|| failure("state_unavailable"))?;
    state.transfer_connection(|_, profile| {
        let profile = crate::identifier_migration::directory(profile, false).map_err(|_| failure("unsafe_profile"))?.ok_or_else(|| failure("unsafe_profile"))?;
        let location = files::Location::open(path, &profile)?;
        if kind != FileKind::Import { location.absent()?; }
        let mut choices = core.live_transfer.files.lock().map_err(|_| failure("state_unavailable"))?;
        choices.retain(|_, f| Instant::now() < f.expires);
        if choices.len() >= MAX_FILES { return Err(failure("selected_file_limit")); }
        let id = crate::core::random_token();
        choices.insert(id.clone(), Arc::new(SelectedFile { context, kind, location, expires: Instant::now()+Duration::from_secs(300) }));
        Ok(json!({"fileId":id,"kind":kind,"name":path.file_name().and_then(|n| n.to_str()).ok_or_else(|| failure("unsafe_transfer_path"))?}))
    })
}

pub fn prepare(core: &Core, request: PrepareRequest) -> Result<Value, TransferError> {
    let _gate = core.gate.lock().map_err(|_| failure("state_unavailable"))?;
    let target = target(core, &request.context, &request.relative_path)?;
    if request.active_tab_ids.len() > 2 {
        return Err(failure("invalid_active_views"));
    }
    {
        let workspace = core
            .workspace
            .lock()
            .map_err(|_| failure("state_unavailable"))?;
        if request
            .active_tab_ids
            .iter()
            .any(|id| !workspace.tabs.get(id).is_some_and(|t| !t.browser))
        {
            return Err(failure("invalid_active_views"));
        }
    }
    let file = selected(core, &request.context, &request.file_id)?;
    let backup = request
        .backup_file_id
        .as_deref()
        .map(|id| selected(core, &request.context, id))
        .transpose()?;
    let state = core
        .document_state
        .get()
        .ok_or_else(|| failure("state_unavailable"))?;
    state.transfer_connection(|connection, _| {
        let _budget = SqlBudget::new(connection,None)?;
        let transaction = LiveTransaction::begin(connection)?;
        if !crate::storage_identity_transition::document_confirmed(&transaction, &target.root_identity, &target.identity).map_err(|_|failure("state_corrupt"))? { return Err(failure("target_identity_confirmation_required")); }
        let old = record(&transaction,&target.identity)?;
        let generation: i64 = transaction.query_row("SELECT generation FROM quota WHERE singleton=1", [], |r| r.get(0)).map_err(sql_error)?;
        let mut preview;
        let action = match file.kind {
            FileKind::Export => {
                if backup.is_some() { return Err(failure("unexpected_backup")); }
                let old = old.as_ref().ok_or_else(|| failure("saved_state_unavailable"))?;
                let outgoing = portable(&target.identity,old,&target,&request.relative_path)?;
                file.location.absent()?;
                preview = json!({"operation":"export","logicalBytes":outgoing.bytes,"incomingApps":super::schemas(&outgoing.file.apps),"replacesExisting":false,"backupRequired":false});
                Action::Export { output:file }
            }
            FileKind::Import => {
                let (bytes,file_identity) = file.location.read(&mut *core.live_transfer.input_files.lock().map_err(|_| failure("state_unavailable"))?)?;
                let incoming = format::parse(&bytes).map_err(format_error)?;
                quota(&transaction,old.as_ref(),incoming.bytes)?;
                if let Some(old) = &old {
                    portable(&target.identity,old,&target,&request.relative_path)?;
                    format::check_schema_compatibility(&incoming.file.apps,&old.data).map_err(format_error)?;
                    if !backup.as_ref().is_some_and(|b| b.kind == FileKind::Backup) { return Err(failure("explicit_backup_required")); }
                } else if backup.is_some() { return Err(failure("unexpected_backup")); }
                if let Some(backup) = &backup { backup.location.absent()?; }
                let previous = old.as_ref().map(|old| portable(&target.identity,old,&target,&request.relative_path)).transpose()?;
                preview = json!({"operation":"import","logicalBytes":incoming.bytes,"incomingApps":super::schemas(&incoming.file.apps),"previousApps":previous.as_ref().map(|p| super::schemas(&p.file.apps)),"source":incoming.file.source,"replacesExisting":old.is_some(),"backupRequired":old.is_some(),"replacementScope":"all_app_ids"});
                Action::Import { input:file,file_identity,hash:recovery_store::payload_hash(std::str::from_utf8(&bytes).map_err(|_| failure("invalid_format"))?),backup }
            }
            FileKind::Backup => return Err(failure("invalid_selected_file_kind")),
        };
        transaction.finish()?;
        // Recheck after filesystem work, before exposing a confirmable plan.
        let current = self::target(core,&request.context,&request.relative_path)?;
        if target.identity != current.identity || target.root_identity != current.root_identity || target.grants != current.grants { return Err(failure("target_changed")); }
        let import = matches!(action, Action::Import {..});
        let id = crate::core::random_token();
        let views: Vec<Value> = target.grants.iter().filter(|g| !g.browser && g.token.is_some()).map(|g| json!({"tabId":g.id,"documentIdentity":g.document_identity,"matchesTargetIdentity":g.document_identity.as_ref()==Some(&target.identity),"visibility":if request.active_tab_ids.contains(&g.id) {"active"} else {"hidden"},"saveAcknowledgement":"unknown"})).collect();
        let browser_grants = target.grants.iter().filter(|g| g.browser && g.token.is_some()).count();
        let opening = target.grants.iter().filter(|g| g.token.is_none() && g.request > 0).count();
        preview["planId"] = json!(id);
        preview["context"] = json!(request.context);
        preview["documentIdentity"] = json!(target.identity);
        preview["rootIdentity"] = json!(target.root_identity);
        preview["targetRevision"] = json!(old.as_ref().map_or(0,|v| v.revision));
        preview["databaseGeneration"] = json!(generation);
        preview["affectedViews"] = json!(views);
        preview["browserGrants"] = json!(browser_grants);
        preview["openingRequests"] = json!(opening);
        preview["stopReloadRequired"] = json!(import && target.grants.iter().any(|g| g.token.is_some() || g.request > 0));
        preview["unflushedInput"] = json!("unknown");
        preview["committedStateOnly"] = json!(true);
        preview["plaintextFile"] = json!(true);
        preview["expiresInSeconds"] = json!(300);
        let plan = Arc::new(Plan { context:request.context,path:request.relative_path,identity:target.identity,root_identity:target.root_identity,workspace_revision:target.workspace_revision,revision:old.as_ref().map_or(0,|v| v.revision),generation,grants:target.grants,expires:Instant::now()+Duration::from_secs(300),action,cancelled:AtomicBool::new(false),phase:Mutex::new(Phase::Pending) });
        let mut plans = core.live_transfer.plans.lock().map_err(|_| failure("state_unavailable"))?;
        plans.retain(|_,p| Instant::now() < p.expires || p.phase.try_lock().is_err());
        let pending = plans.values().filter(|p| matches!(p.phase.try_lock().as_deref(),Ok(Phase::Pending)|Err(_)) && Instant::now() < p.expires && !p.cancelled.load(Ordering::Acquire)).count();
        if pending >= MAX_PENDING || plans.len() >= MAX_OPERATIONS { return Err(failure("plan_limit")); }
        plans.insert(id,plan);
        Ok(preview)
    })
}

fn find_plan(core: &Core, context: &Context, id: &str) -> Result<Arc<Plan>, TransferError> {
    let plan = core
        .live_transfer
        .plans
        .lock()
        .map_err(|_| failure("state_unavailable"))?
        .get(id)
        .cloned()
        .ok_or_else(|| failure("unknown_plan"))?;
    if plan.context.workspace_id != context.workspace_id || plan.context.view_id != context.view_id
    {
        return Err(failure("context_changed"));
    }
    Ok(plan)
}

fn check_live(core: &Core, plan: &Plan) -> Result<Target, TransferError> {
    if plan.cancelled.load(Ordering::Acquire) {
        return Err(failure("operation_cancelled"));
    }
    if Instant::now() >= plan.expires {
        return Err(failure("expired_plan"));
    }
    let current = target(core, &plan.context, &plan.path)?;
    if current.identity != plan.identity
        || current.root_identity != plan.root_identity
        || current.workspace_revision != plan.workspace_revision
    {
        return Err(failure("target_changed"));
    }
    Ok(current)
}
fn check_saved(connection: &Connection, plan: &Plan) -> Result<Option<StateRecord>, TransferError> {
    let old = record(connection, &plan.identity)?;
    let generation: i64 = connection
        .query_row("SELECT generation FROM quota WHERE singleton=1", [], |r| {
            r.get(0)
        })
        .map_err(sql_error)?;
    if old.as_ref().map_or(0, |v| v.revision) != plan.revision || generation != plan.generation {
        return Err(failure("state_changed"));
    }
    Ok(old)
}

pub fn confirm(core: &Core, confirmation: Confirmation) -> Result<Value, TransferError> {
    let plan = find_plan(core, &confirmation.context, &confirmation.plan_id)?;
    if confirmation.confirmation != confirmation.plan_id {
        return Err(failure("explicit_confirmation_required"));
    }
    let mut phase = plan
        .phase
        .try_lock()
        .map_err(|_| failure("transfer_busy"))?;
    match &*phase {
        Phase::Completed(receipt) => return Ok(receipt.clone()),
        Phase::Pending => (),
        _ => return Err(failure("plan_not_pending")),
    }
    let import = matches!(plan.action, Action::Import { .. });
    if import
        && plan.revision > 0
        && confirmation.replace_confirmation.as_deref() != Some(&confirmation.plan_id)
    {
        return Err(failure("explicit_replace_confirmation_required"));
    }
    if import
        && plan
            .grants
            .iter()
            .any(|g| g.token.is_some() || g.request > 0)
        && confirmation.stop_reload_confirmation.as_deref() != Some(&confirmation.plan_id)
    {
        return Err(failure("explicit_stop_reload_confirmation_required"));
    }
    let _gate = core.gate.lock().map_err(|_| failure("state_unavailable"))?;
    let mut revoked = false;
    let mut backup_published = false;
    let mut export_published = false;
    let result = (|| {
        let current = check_live(core, &plan)?;
        if current.grants != plan.grants {
            return Err(failure("views_changed"));
        }
        let state = core
            .document_state
            .get()
            .ok_or_else(|| failure("state_unavailable"))?;
        state.transfer_connection(|connection,_| {
            let _budget = SqlBudget::new(connection,Some(plan.clone()))?;
            // The existing DB mutex + immediate transaction fences Native and
            // external writers before any grants are revoked or backup published.
            let transaction = LiveTransaction::begin(connection)?;
            let operation = (|| {
                let old = check_saved(&transaction,&plan)?;
                let current = check_live(core,&plan)?;
                if current.grants != plan.grants { return Err(failure("views_changed")); }
                match &plan.action {
                    Action::Export { output } => {
                        let old = old.as_ref().ok_or_else(|| failure("saved_state_unavailable"))?;
                        let outgoing = portable(&plan.identity,old,&current,&plan.path)?;
                        output.location.write_new_tracked(&format::encode(&outgoing.file).map_err(format_error)?,|| {
                            check_live(core,&plan)?;
                            check_saved(&transaction,&plan)?;
                            Ok(())
                        }, &mut export_published)?;
                        Ok(json!({"operationId":confirmation.plan_id,"operation":"export","documentIdentity":plan.identity,"revision":old.revision,"fileFlushed":true,"directoryFlushVerified":cfg!(unix),"committedStateOnly":true,"reloadTabIds":[],"revokedBrowserGrants":0}))
                    }
                    Action::Import { input, file_identity, hash, backup } => {
                        let (bytes,identity) = input.location.read(&mut *core.live_transfer.input_files.lock().map_err(|_| failure("state_unavailable"))?)?;
                        if identity != *file_identity || recovery_store::payload_hash(std::str::from_utf8(&bytes).map_err(|_| failure("invalid_format"))?) != *hash { return Err(failure("transfer_file_changed")); }
                        let incoming = format::parse(&bytes).map_err(format_error)?;
                        let (bytes,count,generation) = quota(&transaction,old.as_ref(),incoming.bytes)?;
                        let revision = plan.revision.checked_add(1).ok_or_else(|| failure("revision_limit"))?;
                        if let Some(old) = &old { format::check_schema_compatibility(&incoming.file.apps,&old.data).map_err(format_error)?; }
                        check_live(core,&plan)?;
                        // All target sessions, including external browser and
                        // in-flight opens, are invalidated. No tab/DOM is closed.
                        let mut workspace = core.workspace.lock().map_err(|_| failure("state_unavailable"))?;
                        for grant in &plan.grants {
                            let tab = workspace.tabs.get(&grant.id).ok_or_else(|| failure("views_changed"))?;
                            if tab.revocation == u64::MAX { return Err(failure("revision_limit")); }
                        }
                        for grant in &plan.grants {
                            let tab = workspace.tabs.get_mut(&grant.id).unwrap();
                            tab.session = None;
                            tab.revocation += 1;
                        }
                        drop(workspace);
                        revoked = true;
                        // Revalidate after revocation, before publishing backup
                        // and again at the atomic decision. Never revive tokens.
                        let current = check_live(core,&plan)?;
                        check_saved(&transaction,&plan)?;
                        if let Some(old) = &old {
                            let outgoing = portable(&plan.identity,old,&current,&plan.path)?;
                            backup.as_ref().ok_or_else(|| failure("explicit_backup_required"))?.location.write_new_tracked(&format::encode(&outgoing.file).map_err(format_error)?,|| {
                                check_live(core,&plan)?;
                                check_saved(&transaction,&plan)?;
                                Ok(())
                            }, &mut backup_published)?;
                        }
                        check_live(core,&plan)?;
                        check_saved(&transaction,&plan)?;
                        if !crate::storage_identity_transition::document_confirmed(&transaction, &plan.root_identity, &plan.identity).map_err(|_|failure("state_corrupt"))? { return Err(failure("target_identity_confirmation_required")); }
                        transaction.execute("INSERT INTO documents VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET data=excluded.data,bytes=excluded.bytes,revision=excluded.revision,root=excluded.root,path=excluded.path,generation=excluded.generation",params![plan.identity,incoming.canonical_state,incoming.bytes,revision,plan.root_identity,plan.path,generation]).map_err(sql_error)?;
                        transaction.execute("UPDATE quota SET bytes=?1,documents=?2,generation=?3 WHERE singleton=1",params![bytes,count,generation]).map_err(sql_error)?;
                        let version: i64 = transaction.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(sql_error)?;
                        if version >= 2 { recovery_store::validate_metadata(&transaction).map_err(|_| failure("state_corrupt"))?; }
                        else if version != 1 { return Err(failure("state_corrupt")); }
                        check_live(core,&plan)?;
                        let reload: Vec<&str> = plan.grants.iter().filter(|g| !g.browser && g.token.is_some() && g.document_identity.as_ref()==Some(&plan.identity)).map(|g| g.id.as_str()).collect();
                        Ok(json!({"operationId":confirmation.plan_id,"operation":"import","context":plan.context,"documentIdentity":plan.identity,"revision":revision,"databaseGeneration":generation,"previousStateBackedUp":backup_published,"backupFileFlushed":backup_published,"backupDirectoryFlushVerified":backup_published&&cfg!(unix),"reloadTabIds":reload,"revokedBrowserGrants":plan.grants.iter().filter(|g|g.browser&&g.token.is_some()).count(),"unflushedInput":"unknown","permanentDeletion":false}))
                    }
                }
            })();
            // COMMIT/ROLLBACK must not be interrupted by the cancel handler,
            // and no budget/query_only setting leaks into ordinary saves.
            transaction.progress_handler(0,None::<fn()->bool>).map_err(sql_error)?;
            match operation {
                Ok(receipt) => { transaction.commit()?; Ok(receipt) }
                Err(error) => { transaction.finish()?; Err(error) }
            }
        })
    })();
    match result {
        Ok(receipt) => {
            *phase = Phase::Completed(receipt.clone());
            Ok(receipt)
        }
        Err(error) => {
            *phase = Phase::Failed(
                json!({"status":"failed","code":error.code,"grantsRevoked":revoked,"backupPublished":backup_published,"exportPublished":export_published,"reloadTabIds":[],"documentIdentity":plan.identity}),
            );
            Err(error)
        }
    }
}

// This deliberately does not take Core.gate/DB locks: an in-flight confirm can
// observe cancellation. Past the final check, commit is an atomic decision;
// callers reconcile via verify instead of claiming cancel undid a commit.
pub fn cancel(core: &Core, context: &Context, id: &str) -> Result<Value, TransferError> {
    let plan = find_plan(core, context, id)?;
    plan.cancelled.store(true, Ordering::Release);
    let Ok(mut phase) = plan.phase.try_lock() else {
        return Ok(json!({"status":"cancel_requested","verifyRequired":true}));
    };
    match &*phase {
        Phase::Completed(receipt) => Ok(json!({"status":"completed","receipt":receipt})),
        Phase::Failed(result) => Ok(result.clone()),
        _ => {
            *phase = Phase::Cancelled;
            Ok(json!({"status":"cancelled","viewsClosed":false}))
        }
    }
}

pub fn verify_operation(core: &Core, context: &Context, id: &str) -> Result<Value, TransferError> {
    let plan = find_plan(core, context, id)?;
    let Ok(phase) = plan.phase.try_lock() else {
        return Ok(json!({"status":"processing","verifyRequired":true}));
    };
    Ok(match &*phase {
        Phase::Pending => {
            json!({"status":if plan.cancelled.load(Ordering::Acquire) {"cancel_requested"} else if Instant::now() >= plan.expires {"expired"} else {"pending"}})
        }
        Phase::Cancelled => json!({"status":"cancelled","viewsClosed":false}),
        Phase::Failed(result) => result.clone(),
        Phase::Completed(receipt) => json!({"status":"completed","receipt":receipt}),
    })
}

// Explicit reconciliation after restart/expired receipt. A match proves only
// present values, not that a particular earlier operation committed.
pub fn verify_import(
    core: &Core,
    context: &Context,
    path: &str,
    expected_identity: &str,
    file_id: &str,
) -> Result<Value, TransferError> {
    let _gate = core.gate.lock().map_err(|_| failure("state_unavailable"))?;
    let target = target(core, context, path)?;
    if target.identity != expected_identity {
        return Err(failure("target_identity_changed"));
    }
    let input = selected(core, context, file_id)?;
    if input.kind != FileKind::Import {
        return Err(failure("invalid_selected_file_kind"));
    }
    core.document_state.get().ok_or_else(|| failure("state_unavailable"))?.transfer_connection(|connection,_| {
        let _budget = SqlBudget::new(connection,None)?;
        let transaction = LiveTransaction::begin(connection)?;
        let (bytes,_) = input.location.read(&mut *core.live_transfer.input_files.lock().map_err(|_| failure("state_unavailable"))?)?;
        let incoming = format::parse(&bytes).map_err(format_error)?;
        let old = record(&transaction,&target.identity)?;
        let current = old.as_ref().map(|old| portable(&target.identity,old,&target,path)).transpose()?;
        let current_target = self::target(core,context,path)?;
        if current_target.identity != target.identity || current_target.root_identity != target.root_identity { return Err(failure("target_identity_changed")); }
        let value = json!({"status":"verified_current_values","matches":current.as_ref().is_some_and(|v|v.canonical_state==incoming.canonical_state),"revision":old.as_ref().map_or(0,|v|v.revision),"documentIdentity":target.identity,"provesPastOperation":false});
        transaction.progress_handler(0,None::<fn()->bool>).map_err(sql_error)?;
        transaction.finish()?;
        Ok(value)
    })
}

#[cfg(test)]
#[path = "live_tests.rs"]
mod tests;
