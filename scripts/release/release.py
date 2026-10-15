"""Reviewed release tooling; downloaded application archives remain opaque."""

import base64
import datetime as dt
import io
import json
import os
from pathlib import Path
import re
import resource
import shutil
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "signing"))
import control as signing

require = signing.require
REPOSITORY = "shimi-lynx/mogledge"
REPOSITORY_ID = 1416386985
PLATFORMS = {
    "windows-x64": ("x86_64-pc-windows-msvc", "unsigned", "windows-x86_64"),
    "macos-x64": ("x86_64-apple-darwin", "adhoc", "darwin-x86_64"),
    "macos-arm64": ("aarch64-apple-darwin", "adhoc", "darwin-aarch64"),
}


def policy():
    return signing.read_json((ROOT / "policy.json").read_bytes())


def source_context(workflow):
    env = os.environ
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY, "Unexpected release repository")
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual workflow only")
    require(env.get("GITHUB_REF") == "refs/heads/main", "Release tooling must run from main")
    require(env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/.github/workflows/{workflow}@refs/heads/main", "Unexpected release workflow")
    expected = env.get("EXPECTED_WORKFLOW_SHA", "")
    require(re.fullmatch(r"[0-9a-f]{40}", expected) is not None, "Full reviewed tooling SHA required")
    require(expected == env.get("GITHUB_SHA") == env.get("GITHUB_WORKFLOW_SHA"), "Reviewed release tooling SHA mismatch")


def candidate_policy(config):
    require(config["schema"] == 1 and config["version"] == "0.9.0", "Unexpected release version/schema")
    require(config["approval"]["enabled"] is True, "Production signing disabled pending reviewed candidate pins")
    source = config["source_sha"]
    require(isinstance(source, str) and re.fullmatch(r"[0-9a-f]{40}", source) is not None, "Pinned binary source SHA required")
    candidates = config["candidates"]
    require(len(candidates) == 3 and {item["platform"] for item in candidates} == set(PLATFORMS), "Exactly three reviewed platform candidates required")
    for candidate in candidates:
        target, signature, _ = PLATFORMS[candidate["platform"]]
        require(candidate["repository"] == REPOSITORY and candidate["repository_id"] == REPOSITORY_ID, "Candidate repository mismatch")
        require(candidate["source_sha"] == source and candidate["version"] == config["version"], "Candidate source/version mismatch")
        require(candidate["target"] == target and candidate["signature"] == signature, "Candidate target/signature mismatch")
        require(candidate["architecture"] == ("arm64" if candidate["platform"] == "macos-arm64" else "x64"), "Candidate architecture mismatch")
        require(candidate["artifact_name"] == f"Mogledge-{candidate['platform']}-{source}", "Candidate artifact name mismatch")
        require(candidate["identifier"] == "com.shimilynx.myknowledge", "Candidate identifier mismatch")
        require(candidate["public_key"] == signing.policy()["candidate"]["public_key"], "Unexpected production public key")
        require(candidate["distribution_config_sha256"] == signing.policy()["candidate"]["distribution_config_sha256"], "Unexpected distribution overlay")
        require(candidate["workflow_path"] == ".github/workflows/binary-distribution.yml", "Unexpected candidate build workflow")
        for name in ("run_id", "artifact_id", "artifact_size"):
            require(type(candidate[name]) is int and candidate[name] > 0, "Positive candidate artifact/run pins required")
        require(re.fullmatch(r"[0-9a-f]{64}", candidate["artifact_sha256"]) is not None, "Pinned artifact digest required")
        prefix = f"Mogledge_{config['version']}_{candidate['platform']}_{signature}_updater_{source[:12]}"
        suffix = "-setup.exe" if candidate["platform"] == "windows-x64" else ".app.tar.gz"
        require(candidate["update_archive"] == prefix + suffix and candidate["initial_archive"] == prefix + ".zip", "Unexpected release archive name")
        signing.fresh(candidate)
    return candidates


def metadata(path, label):
    try:
        return signing.api(path)
    except urllib.error.HTTPError as error:
        error.close()
        raise signing.ValidationError(f"{label}: HTTP {error.code}") from None


def approval(config):
    policy = config["approval"]
    require(policy["enabled"] is True and policy.get("mode") == "protected-main", "Production signing disabled pending protected-main policy")
    ruleset_id = policy.get("main_ruleset_id")
    require(type(ruleset_id) is int and ruleset_id > 0, "Pinned main ruleset required")
    repository = metadata("", "Repository metadata")
    environment = metadata("environments/release", "Environment metadata")
    branches = metadata("environments/release/deployment-branch-policies", "Deployment branch metadata")
    ruleset = metadata(f"rulesets/{ruleset_id}", "Main ruleset metadata")
    protected_main_gate(policy, repository, environment, branches, ruleset)


def protected_main_gate(policy, repository, environment, branches, ruleset):
    # Removing the owner checkpoint must not broaden the eligible source refs.
    # The old trial deliberately keeps its separate required-reviewer gate.
    require(policy["enabled"] is True and policy.get("mode") == "protected-main", "Production signing disabled pending protected-main policy")
    require(repository["id"] == REPOSITORY_ID and repository.get("private") is False, "Unexpected production repository")
    require(type(policy["environment_id"]) is int and environment["id"] == policy["environment_id"] and environment["name"] == "release", "Release environment mismatch")
    require(environment.get("can_admins_bypass") is False, "Administrator environment bypass must remain disabled")
    require(not any(rule.get("type") == "required_reviewers" for rule in environment.get("protection_rules", [])), "Unexpected production reviewer gate")
    branch_policy = environment.get("deployment_branch_policy", {}) or {}
    require(branch_policy.get("custom_branch_policies") is True and branch_policy.get("protected_branches") is False, "Explicit deployment branch policy required")
    policies = branches.get("branch_policies", [])
    require(branches.get("total_count") == len(policies) == 1 and policies[0].get("name") == "main" and policies[0].get("type") == "branch", "Only main may use the release environment")
    require(type(policy.get("main_ruleset_id")) is int and ruleset.get("id") == policy["main_ruleset_id"] and ruleset.get("target") == "branch" and ruleset.get("enforcement") == "active", "Active pinned main ruleset required")
    require(ruleset.get("conditions", {}).get("ref_name") == {"include": ["refs/heads/main"], "exclude": []}, "Main protection scope changed")
    # GitHub hides bypass actors from read-only tokens. Pin the owner-reviewed
    # ruleset revision instead of granting the signing job administration access.
    expected_update = policy.get("main_ruleset_updated_at")
    actual_update = ruleset.get("updated_at")
    require(isinstance(expected_update, str) and isinstance(actual_update, str), "Pinned main ruleset revision required")
    require(dt.datetime.fromisoformat(actual_update.replace("Z", "+00:00")) == dt.datetime.fromisoformat(expected_update.replace("Z", "+00:00")), "Main ruleset changed since owner review")
    require("bypass_actors" not in ruleset or ruleset["bypass_actors"] == [], "Main ruleset bypass changed")
    require({"pull_request", "non_fast_forward", "deletion"} <= {rule.get("type") for rule in ruleset.get("rules", [])}, "Main PR, force-push and deletion protection required")


def prepare(destination):
    source_context("release-signing.yml")
    config = policy()
    candidates = candidate_policy(config)
    approval(config)
    destination.mkdir()
    for candidate in candidates:
        signing.metadata(candidate, metadata(f"actions/runs/{candidate['run_id']}", "Build run metadata"), metadata(f"actions/artifacts/{candidate['artifact_id']}", "Candidate artifact metadata"))
        raw = signing.download(f"https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{candidate['artifact_id']}/zip", signing.MAX_ARCHIVE, os.environ["GH_TOKEN"])
        signing.validated_archive(raw, candidate)
        folder = destination / candidate["platform"]
        folder.mkdir()
        (folder / "candidate.zip").write_bytes(raw)


def gate():
    source_context("release-signing.yml")
    config = policy()
    candidate_policy(config)
    approval(config)


def validated_inputs(source, config):
    candidates = candidate_policy(config)
    require({entry.name for entry in source.iterdir()} == set(PLATFORMS), "Unexpected candidate input folders")
    for candidate in candidates:
        folder = source / candidate["platform"]
        require(folder.is_dir() and not folder.is_symlink() and {entry.name for entry in folder.iterdir()} == {"candidate.zip"}, "Unexpected candidate input files")
        archive = folder / "candidate.zip"
        require(archive.is_file() and not archive.is_symlink(), "Unsafe candidate input")
        yield candidate, signing.validated_archive(archive.read_bytes(), candidate)


def sign(source, tool, destination):
    source_context("release-signing.yml")
    config = policy()
    # Input validation completes before the signing child receives production Secrets.
    inputs = list(validated_inputs(source, config))
    for name in ("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"):
        require(bool(os.environ.get(name)), "Required Environment signing secret missing")
    environment = {name: os.environ[name] for name in ("PATH", "HOME", "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD")}
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    destination.mkdir()
    for candidate, payload in inputs:
        archive = destination / candidate["update_archive"]
        archive.write_bytes(payload)
        result = subprocess.run([shutil.which("node"), str(tool / "node_modules/@tauri-apps/cli/tauri.js"), "signer", "sign", "--app-version", config["version"], str(archive.resolve())], cwd=destination, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False)
        require(result.returncode == 0, "Production signing failed; diagnostics suppressed")
        require(signing.sha256(archive.read_bytes()) == signing.sha256(payload), "Signer changed candidate bytes")
        signature = Path(str(archive) + ".sig")
        require(signature.is_file() and not signature.is_symlink() and 0 < signature.stat().st_size <= signing.MAX_METADATA, "Unsafe or missing production signature")
        archive.unlink()


def signature_check(verifier, archive, signature, candidate):
    result = subprocess.run([str(verifier.resolve()), str(archive.resolve()), str(signature.resolve()), candidate["public_key"], candidate["version"]], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False)
    require(result.returncode == 0, "Production signature or signed-version verification failed")


def feed(config, signatures, date):
    require(dt.datetime.fromisoformat(date.replace("Z", "+00:00")).utcoffset() == dt.timedelta(0), "UTC feed date required")
    platforms = {}
    for candidate in candidate_policy(config):
        key = PLATFORMS[candidate["platform"]][2]
        signature = signatures[candidate["update_archive"] + ".sig"]
        require(0 < len(signature) <= signing.MAX_METADATA, "Invalid feed signature size")
        base64.b64decode(signature, validate=True)
        platforms[key] = {"signature": signature.decode("ascii"), "url": f"https://github.com/{REPOSITORY}/releases/download/v{config['version']}/{candidate['update_archive']}"}
    return {"version": config["version"], "notes": config["publication"]["notes"], "pub_date": date, "platforms": platforms}


def verify(source, signatures, verifier, destination):
    source_context("release-signing.yml")
    config = policy()
    inputs = list(validated_inputs(source, config))
    require({entry.name for entry in signatures.iterdir()} == {item["update_archive"] + ".sig" for item, _ in inputs}, "Unexpected production signature files")
    destination.mkdir()
    signature_bytes, hashes = {}, {}
    for candidate, payload in inputs:
        archive = destination / candidate["update_archive"]
        archive.write_bytes(payload)
        signature = signatures / (archive.name + ".sig")
        require(signature.is_file() and not signature.is_symlink() and signature.stat().st_size <= signing.MAX_METADATA, "Unsafe production signature")
        signature_check(verifier, archive, signature, candidate)
        signature_bytes[signature.name] = signature.read_bytes()
        (destination / signature.name).write_bytes(signature_bytes[signature.name])
        with zipfile.ZipFile(source / candidate["platform"] / "candidate.zip") as zipped:
            (destination / candidate["initial_archive"]).write_bytes(zipped.read(candidate["initial_archive"]))
    document = feed(config, signature_bytes, dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"))
    (destination / "latest.json").write_text(json.dumps(document, indent=2) + "\n")
    for entry in destination.iterdir():
        hashes[entry.name] = signing.sha256(entry.read_bytes())
    receipt = {"status": "verified-production-candidate", "version": config["version"], "sourceSha": config["source_sha"], "toolingSha": os.environ["GITHUB_SHA"], "signingWorkflowRun": os.environ["GITHUB_RUN_ID"], "candidates": config["candidates"], "files": hashes, "published": False, "nativeUpdateTested": False}
    (destination / "verification.json").write_text(json.dumps(receipt, indent=2) + "\n")
    hashes["verification.json"] = signing.sha256((destination / "verification.json").read_bytes())
    (destination / "SHA256SUMS.txt").write_text("".join(f"{digest}  {name}\n" for name, digest in sorted(hashes.items())))


def publication_policy(config):
    candidate_policy(config)
    publication = config["publication"]
    require(publication["enabled"] is True, "Publication disabled pending reviewed verification artifact pins")
    require(publication["tag"] == "v0.9.0", "Unexpected release tag")
    require(type(publication["verification_run_id"]) is int and publication["verification_run_id"] > 0 and type(publication["artifact_id"]) is int and publication["artifact_id"] > 0 and type(publication["artifact_size"]) is int and 0 < publication["artifact_size"] <= signing.MAX_ARCHIVE, "Pinned verification run/artifact required")
    require(isinstance(publication["verification_tooling_sha"], str) and re.fullmatch(r"[0-9a-f]{40}", publication["verification_tooling_sha"]) is not None, "Pinned verification tooling SHA required")
    require(isinstance(publication["artifact_sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", publication["artifact_sha256"]) is not None, "Pinned verification digest required")
    signing.fresh(publication)
    return publication


def validate_publication(raw, config, verifier, destination):
    publication = publication_policy(config)
    require(len(raw) == publication["artifact_size"] and signing.sha256(raw) == publication["artifact_sha256"], "Verified output artifact digest mismatch")
    asset_names = {"latest.json", "verification.json", "SHA256SUMS.txt"}
    for candidate in config["candidates"]:
        asset_names.update((candidate["update_archive"], candidate["initial_archive"], candidate["update_archive"] + ".sig"))
    with zipfile.ZipFile(io.BytesIO(raw)) as zipped:
        entries = zipped.infolist()
        require(len(entries) == len(asset_names) and {entry.filename for entry in entries} == asset_names, "Unexpected publication files")
        require(sum(entry.file_size for entry in entries) <= signing.MAX_ARCHIVE, "Oversized publication contents")
        for entry in entries:
            require(not entry.is_dir() and not entry.flag_bits & 1 and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG) and entry.file_size <= signing.MAX_ARCHIVE, "Unsafe publication entry")
            if entry.filename in {"latest.json", "verification.json", "SHA256SUMS.txt"} or entry.filename.endswith(".sig"):
                require(entry.file_size <= signing.MAX_METADATA, "Oversized publication metadata")
        receipt = signing.read_json(zipped.read("verification.json"))
        require(receipt["status"] == "verified-production-candidate" and receipt["version"] == config["version"] and receipt["sourceSha"] == config["source_sha"] and receipt["toolingSha"] == publication["verification_tooling_sha"] and receipt["signingWorkflowRun"] == str(publication["verification_run_id"]) and receipt["candidates"] == config["candidates"] and receipt["published"] is False and receipt["nativeUpdateTested"] is False, "Verification receipt mismatch")
        require(set(receipt["files"]) == asset_names - {"verification.json", "SHA256SUMS.txt"}, "Verification receipt file scope mismatch")
        for name, digest in receipt["files"].items():
            require(signing.sha256(zipped.read(name)) == digest, "Verified publication file changed")
        expected_sums = dict(receipt["files"]) | {"verification.json": signing.sha256(zipped.read("verification.json"))}
        require(zipped.read("SHA256SUMS.txt").decode("ascii") == "".join(f"{digest}  {name}\n" for name, digest in sorted(expected_sums.items())), "Publication checksum mismatch")
        document = signing.read_json(zipped.read("latest.json"))
        signatures = {item["update_archive"] + ".sig": zipped.read(item["update_archive"] + ".sig") for item in config["candidates"]}
        require(document == feed(config, signatures, document["pub_date"]), "Publication feed mismatch")
        destination.mkdir()
        for name in asset_names:
            (destination / name).write_bytes(zipped.read(name))
    for candidate in config["candidates"]:
        signature_check(verifier, destination / candidate["update_archive"], destination / (candidate["update_archive"] + ".sig"), candidate)


def require_workflow_compatibility(source):
    # GitHub requires unavailable Workflows:write when a newly tagged source's
    # workflow files differ from the default branch. Later pin-only commits are safe.
    repository = metadata("", "Publication repository metadata")
    require(repository["default_branch"] == "main", "Unexpected publication default branch")
    current_main = metadata("git/ref/heads/main", "Publication main ref")["object"]["sha"]
    source_workflows = metadata(f"contents/.github/workflows?ref={source}", "Binary-source workflow metadata")
    main_workflows = metadata(f"contents/.github/workflows?ref={current_main}", "Default-branch workflow metadata")
    for entries in (source_workflows, main_workflows):
        require(isinstance(entries, list) and all(entry["type"] == "file" for entry in entries), "Unexpected workflow directory schema")
    require({entry["name"]: entry["sha"] for entry in source_workflows} == {entry["name"]: entry["sha"] for entry in main_workflows}, "Workflow files changed after binary build; review without broader credentials")


def publication_prepare(verifier, destination):
    source_context("release-publication.yml")
    config = policy()
    publication = publication_policy(config)
    approval(config)
    require_workflow_compatibility(config["source_sha"])
    run = metadata(f"actions/runs/{publication['verification_run_id']}", "Verification run metadata")
    require(run["repository"]["id"] == run["head_repository"]["id"] == REPOSITORY_ID and run["head_sha"] == publication["verification_tooling_sha"] and run["head_branch"] == "main" and run["path"] == ".github/workflows/release-signing.yml" and run["event"] == "workflow_dispatch" and run["status"] == "completed" and run["conclusion"] == "success", "Untrusted production verification run")
    artifact = metadata(f"actions/artifacts/{publication['artifact_id']}", "Verified artifact metadata")
    require(artifact["id"] == publication["artifact_id"] and artifact["name"] == publication["artifact_name"] and artifact["expired"] is False and artifact["expires_at"] == publication["expires_at"] and artifact["digest"] == "sha256:" + publication["artifact_sha256"] and artifact["size_in_bytes"] == publication["artifact_size"] and artifact["workflow_run"]["id"] == publication["verification_run_id"] and artifact["workflow_run"]["head_sha"] == publication["verification_tooling_sha"] and artifact["workflow_run"]["repository_id"] == artifact["workflow_run"]["head_repository_id"] == REPOSITORY_ID, "Untrusted verified artifact")
    raw = signing.download(f"https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{publication['artifact_id']}/zip", signing.MAX_ARCHIVE, os.environ["GH_TOKEN"])
    validate_publication(raw, config, verifier, destination)


def request(path, method="GET", data=None, upload_name=None):
    token = os.environ.get("GH_TOKEN")
    require(bool(token), "Release token missing")
    if upload_name is None:
        url = f"https://api.github.com/repos/{REPOSITORY}/{path}"
        payload = None if data is None else json.dumps(data).encode()
        content_type = "application/json"
    else:
        require(re.fullmatch(r"releases/[0-9]+/assets", path) is not None, "Invalid asset upload endpoint")
        url = f"https://uploads.github.com/repos/{REPOSITORY}/{path}?name={urllib.parse.quote(upload_name, safe='')}"
        payload, content_type = data, "application/octet-stream"
    headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": content_type}
    with urllib.request.build_opener(signing.SafeRedirect()).open(urllib.request.Request(url, data=payload, headers=headers, method=method), timeout=120) as response:
        return signing.read_json(response.read(signing.MAX_METADATA + 1))


def publish(verifier, destination):
    source_context("release-publication.yml")
    config = policy()
    publication_policy(config)
    # Repeat artifact, crypto and signing-Environment protection checks before writes.
    publication_prepare(verifier, destination)
    approval(config)
    for endpoint in ("git/ref/tags/v0.9.0", "releases/tags/v0.9.0"):
        try:
            request(endpoint)
        except urllib.error.HTTPError as error:
            error.close()
            require(error.code == 404, "Unable to establish release/tag absence")
        else:
            require(False, "Existing release/tag requires separate review; no overwrite")
    release = request("releases", "POST", {"tag_name": "v0.9.0", "target_commitish": config["source_sha"], "name": "Mogledge 0.9.0", "body": config["publication"]["notes"], "draft": True, "prerelease": False})
    require(release["draft"] is True and release["tag_name"] == "v0.9.0" and release["target_commitish"] == config["source_sha"], "Unexpected draft release response")
    release_id = release["id"]
    require(type(release_id) is int and release_id > 0, "Unexpected draft release identity")
    expected_names = {entry.name for entry in destination.iterdir()}
    expected_assets = {}
    for entry in sorted(destination.iterdir()):
        uploaded = request(f"releases/{release_id}/assets", "POST", entry.read_bytes(), entry.name)
        digest = "sha256:" + signing.sha256(entry.read_bytes())
        require(uploaded["name"] == entry.name and uploaded["size"] == entry.stat().st_size and uploaded.get("digest") == digest and uploaded["state"] == "uploaded" and type(uploaded["id"]) is int, "Uploaded asset digest/size mismatch")
        expected_assets[entry.name] = (uploaded["id"], entry.stat().st_size, digest)
    draft = request(f"releases/{release_id}")
    require(draft["id"] == release_id and draft["draft"] is True and draft["tag_name"] == "v0.9.0" and draft["target_commitish"] == config["source_sha"], "Draft release identity changed before publication")
    assets = draft["assets"]
    require({asset["name"] for asset in assets} == expected_names and len(assets) == len(expected_names), "Draft asset scope mismatch")
    for asset in assets:
        require((asset["id"], asset["size"], asset.get("digest")) == expected_assets[asset["name"]] and asset["state"] == "uploaded", "Draft asset changed before publication")
    approval(config)
    try:
        tag = request("git/ref/tags/v0.9.0")
    except urllib.error.HTTPError as error:
        error.close()
        require(error.code == 404, "Unable to recheck tag absence before publication")
    else:
        require(tag["object"]["type"] == "commit" and tag["object"]["sha"] == config["source_sha"], "Release tag changed to an unreviewed source")
    final = request(f"releases/{release_id}", "PATCH", {"draft": False, "make_latest": "true", "tag_name": "v0.9.0", "target_commitish": config["source_sha"]})
    require(final["draft"] is False and final["tag_name"] == "v0.9.0", "Publication readback mismatch")
    tag = request("git/ref/tags/v0.9.0")
    require(tag["object"]["type"] == "commit" and tag["object"]["sha"] == config["source_sha"], "Published tag source mismatch")
    print("Release is public; checking anonymous feed and updater bytes")
    public_feed = signing.read_json(signing.download(f"https://github.com/{REPOSITORY}/releases/latest/download/latest.json", signing.MAX_METADATA))
    require(public_feed == signing.read_json((destination / "latest.json").read_bytes()), "Anonymous latest feed differs from reviewed feed")
    for candidate in config["candidates"]:
        key = PLATFORMS[candidate["platform"]][2]
        public_payload = signing.download(public_feed["platforms"][key]["url"], signing.MAX_ARCHIVE)
        require(signing.sha256(public_payload) == signing.sha256((destination / candidate["update_archive"]).read_bytes()), "Anonymous updater bytes differ from verified assets")
    print("Published verified Mogledge 0.9.0 assets and latest.json")


def main():
    operations = {"prepare": prepare, "gate": gate, "sign": sign, "verify": verify, "publication-prepare": publication_prepare, "publish": publish}
    command, *arguments = sys.argv[1:]
    require(command in operations, "Unknown production operation")
    operations[command](*(Path(argument) for argument in arguments))


if __name__ == "__main__":
    try:
        main()
    except signing.ValidationError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Production distribution stopped safely; raw network/tool diagnostics suppressed.", file=sys.stderr)
        sys.exit(1)
