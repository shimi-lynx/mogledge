use crate::{core::Core, knowledge::TreeNode};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    hash::{DefaultHasher, Hash, Hasher},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_BYTES: usize = 1024 * 1024;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Order {
    pub parents: BTreeMap<String, Vec<String>>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u8,
    root: PathBuf,
    order: Order,
}

fn path(core: &Core, root: &Path) -> Result<PathBuf, String> {
    let parent = core
        .settings_path
        .get()
        .and_then(|path| path.parent())
        .ok_or("順序の保存先が未初期化です")?;
    let mut hash = DefaultHasher::new();
    root.hash(&mut hash);
    Ok(parent
        .join("tree-order")
        .join(format!("{:016x}.json", hash.finish())))
}
pub fn load(core: &Core, root: &Path) -> Result<Order, String> {
    // Core-only fixtures can use the default order without a settings directory.
    if core.settings_path.get().is_none() {
        return Ok(Order::default());
    }
    let path = path(core, root)?;
    #[cfg(unix)]
    let opened = rustix::fs::open(
        &path,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::NONBLOCK
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )
    .map(std::fs::File::from)
    .map_err(std::io::Error::from);
    #[cfg(windows)]
    let opened = {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(windows::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(&path)
    };
    let file = match opened {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Order::default()),
        Err(_) => return Err("順序を読み取れません。既定順で表示します".into()),
    };
    let metadata = file.metadata().map_err(|_| "順序を読み取れません")?;
    if crate::write_fs::rejected_link(&metadata) || !metadata.is_file() {
        return Err("順序の保存先が通常ファイルではありません".into());
    }
    let mut data = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| "順序を読み取れません")?;
    if data.len() > MAX_BYTES {
        return Err("順序JSONが大きすぎます。既定順で表示します".into());
    }
    let stored: Stored =
        serde_json::from_slice(&data).map_err(|_| "順序JSONが壊れています。既定順で表示します")?;
    if stored.version != 1
        || stored.root != root
        || stored.order.parents.iter().any(|(parent, names)| {
            (!parent.is_empty() && crate::knowledge::validate_relative(parent).is_err())
                || names.len() > 20000
                || names
                    .iter()
                    .any(|name| name.contains('/') || name.is_empty())
        })
    {
        return Err("順序JSONの形式が無効です。既定順で表示します".into());
    }
    Ok(stored.order)
}
pub fn save(core: &Core, root: &Path, order: &Order) -> Result<(), String> {
    let path = path(core, root)?;
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent).map_err(|_| "順序の保存先を作成できません")?;
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if crate::write_fs::rejected_link(&meta) || !meta.is_file() {
            return Err("順序の保存先が通常ファイルではありません".into());
        }
    }
    let json = serde_json::to_vec(&Stored {
        version: 1,
        root: root.into(),
        order: order.clone(),
    })
    .map_err(|_| "順序を作成できません")?;
    if json.len() > MAX_BYTES {
        return Err("順序情報は1MiB以下にしてください".into());
    }
    let temporary = parent.join(format!(".order-{}.tmp", crate::core::random_token()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "順序を保存できません")?;
        file.write_all(&json)
            .and_then(|_| file.sync_all())
            .map_err(|_| "順序を保存できません")?;
        drop(file);
        // This replaces only this application's sidecar, never a knowledge file.
        std::fs::rename(&temporary, &path).map_err(|_| "順序を保存できません")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
/// Cloud moves persist the same Stored representation through a dedicated
/// ordinary-directory, retained-handle publisher; the ordinary writer is intact.
#[cfg(windows)]
pub(crate) fn save_cloud_move(core: &Core, root: &Path, order: &Order) -> Result<(), String> {
    let path = path(core, root)?;
    let profile = path.parent().unwrap().parent().unwrap();
    let (profile_root, original) = crate::knowledge::open_root(profile)?;
    let parent = crate::write_fs::LockedDir::open(&original, "")?;
    match std::fs::symlink_metadata(profile.join("tree-order")) {
        Ok(metadata) if metadata.is_dir() && !crate::write_fs::rejected_link(&metadata) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            crate::write_fs::mkdir(parent.dir(), "tree-order")
                .map_err(|_| "順序の保存先を作成できません")?;
        }
        _ => return Err("順序の保存先が通常フォルダーではありません".into()),
    }
    parent.revalidate(&profile_root, &original)?;
    let locked = crate::write_fs::LockedDir::open(&original, "tree-order")?;
    let json = serde_json::to_vec(&Stored {
        version: 1,
        root: root.into(),
        order: order.clone(),
    })
    .map_err(|_| "順序を作成できません")?;
    if json.len() > MAX_BYTES {
        return Err("順序情報は1MiB以下にしてください".into());
    }
    let (temporary, mut file) =
        crate::write_fs::create_temporary(locked.dir()).map_err(|_| "順序を保存できません")?;
    file.write_all(&json)
        .and_then(|_| file.sync_all())
        .map_err(|_| "順序を保存できません")?;
    locked.revalidate(&profile_root, &original)?;
    crate::write_fs::replace_tree_order(
        &locked,
        &temporary,
        &file,
        path.file_name().unwrap().to_str().unwrap(),
    )
    .map_err(|_| "順序の保存を確認できません。ファイルを保持し、自動再試行しません")?;
    locked.revalidate(&profile_root, &original)
}
pub fn children<'a>(nodes: &'a [TreeNode], parent: &str) -> Option<&'a [TreeNode]> {
    if parent.is_empty() {
        return Some(nodes);
    }
    for node in nodes {
        if node.kind == "folder" && node.relative_path == parent {
            return Some(&node.children);
        }
        if let Some(found) = children(&node.children, parent) {
            return Some(found);
        }
    }
    None
}
pub fn apply(nodes: &mut [TreeNode], order: &Order) {
    fn walk(nodes: &mut [TreeNode], parent: &str, order: &Order) {
        if let Some(names) = order.parents.get(parent) {
            let positions: std::collections::HashMap<_, _> = names
                .iter()
                .enumerate()
                .map(|(i, n)| (n.as_str(), i))
                .collect();
            nodes.sort_by_key(|node| {
                positions
                    .get(node.name.as_str())
                    .copied()
                    .unwrap_or(usize::MAX)
            });
        }
        for node in nodes {
            if node.kind == "folder" {
                walk(&mut node.children, &node.relative_path, order);
            }
        }
    }
    walk(nodes, "", order)
}
pub fn remap(order: &mut Order, from: &str, to: &str) {
    let remap = |path: &str| {
        if path == from {
            to.into()
        } else if let Some(tail) = path.strip_prefix(&format!("{from}/")) {
            format!("{to}/{tail}")
        } else {
            path.into()
        }
    };
    let previous = std::mem::take(&mut order.parents);
    order.parents = previous
        .into_iter()
        .filter(|(parent, _)| parent != to && !parent.starts_with(&format!("{to}/")))
        .map(|(parent, names)| (remap(&parent), names))
        .collect();
    let (parent, name) = crate::tree_mutations::split(from);
    if let Some(names) = order.parents.get_mut(parent) {
        names.retain(|n| n != name);
    }
}
pub fn reordered(
    order: &Order,
    nodes: &[TreeNode],
    source: &str,
    anchor: &str,
    after: bool,
) -> Result<Order, String> {
    let (parent, name) = crate::tree_mutations::split(source);
    let (other, target) = crate::tree_mutations::split(anchor);
    if parent != other || source == anchor {
        return Err("同じ親の別の項目を指定してください".into());
    }
    let children = children(nodes, parent).ok_or("親フォルダーが見つかりません")?;
    let mut names: Vec<_> = children.iter().map(|node| node.name.clone()).collect();
    if !names.iter().any(|n| n == name) || !names.iter().any(|n| n == target) {
        return Err("項目が見つかりません".into());
    }
    names.retain(|n| n != name);
    let at = names.iter().position(|n| n == target).unwrap() + usize::from(after);
    names.insert(at, name.into());
    let mut seen = HashSet::new();
    if names.iter().any(|name| !seen.insert(name)) {
        return Err("順序の項目が重複しています".into());
    }
    let mut next = order.clone();
    next.parents.insert(parent.into(), names);
    Ok(next)
}
