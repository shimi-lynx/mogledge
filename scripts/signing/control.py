"""Trusted release tooling: never import or execute downloaded application material."""

import base64
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
import urllib.parse
import zipfile

ROOT = Path(__file__).resolve().parent
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_METADATA = 64 * 1024
TOOL_PACKAGES = (
    (
        "cli",
        "kEDEiGzG+yAc5FeLxtXpES/VN+F2C8H0r4gDVtfRLKxT9np9101d9REG/Kgo2lr0hKi0IpDsODiHnU3+naOmLg==",
    ),
    (
        "cli-linux-x64-gnu",
        "Z1QGPr49HJZMktu+Spu6Q1b/f9ANadXvqZZZt2645ua1x1ev6prOgp85eiGv2jRzohFEMLo6aJyaLjLUX5KIvA==",
    ),
)


class ValidationError(ValueError):
    """Only fixed, deliberately public diagnostic text may enter this exception."""


def require(condition, message):
    if not condition:
        raise ValidationError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def read_json(data):
    require(len(data) <= MAX_METADATA, "Oversized metadata")
    return json.loads(data, object_pairs_hook=unique_object)


def policy():
    return read_json((ROOT / "policy.json").read_bytes())


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fresh(candidate, now=None):
    expiry = dt.datetime.fromisoformat(candidate["expires_at"].replace("Z", "+00:00"))
    require(
        (now or dt.datetime.now(dt.timezone.utc)) < expiry,
        "Trusted candidate expired; review a new build record",
    )


def source_context(env):
    require(
        env.get("GITHUB_REPOSITORY") == "shimi-lynx/mogledge",
        "Unexpected signing repository",
    )
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual workflow only")
    require(
        env.get("GITHUB_REF") == "refs/heads/main", "Signing tooling must run from main"
    )
    require(
        env.get("GITHUB_WORKFLOW_REF")
        == "shimi-lynx/mogledge/.github/workflows/updater-signing.yml@refs/heads/main",
        "Unexpected workflow ref",
    )
    expected = env.get("EXPECTED_WORKFLOW_SHA", "")
    require(
        re.fullmatch(r"[0-9a-f]{40}", expected) is not None,
        "Full reviewed tooling SHA required",
    )
    require(
        expected == env.get("GITHUB_SHA") == env.get("GITHUB_WORKFLOW_SHA"),
        "Reviewed tooling SHA mismatch",
    )


def approval_gate(approval, repository, environment, branches):
    # A committed false default cannot be enabled through workflow inputs or variables.
    require(
        approval["enabled"] is True,
        "Signing disabled: effective human approval gate has not been verified",
    )
    require(
        type(approval["environment_id"]) is int,
        "Pinned release environment ID required",
    )
    require(repository["id"] == 1416386985, "Unexpected repository identity")
    if repository["private"]:
        require(
            approval["private_required_reviewers_entitlement_verified"] is True,
            "Private-repository approval entitlement unverified",
        )
    require(
        environment["name"] == "release"
        and environment["id"] == approval["environment_id"],
        "Release environment mismatch",
    )
    require(
        environment.get("can_admins_bypass") is False,
        "Administrator approval bypass must be disabled and observable",
    )
    rules = [
        rule
        for rule in environment.get("protection_rules", [])
        if rule.get("type") == "required_reviewers"
    ]
    require(len(rules) == 1, "Effective Required reviewers rule missing")
    reviewers = rules[0].get("reviewers", [])
    require(
        len(reviewers) == 1
        and reviewers[0].get("type") == "User"
        and reviewers[0].get("reviewer", {}).get("id") == approval["reviewer_user_id"],
        "Unexpected required reviewer",
    )
    branch_policy = environment.get("deployment_branch_policy", {}) or {}
    require(
        branch_policy.get("custom_branch_policies") is True
        and branch_policy.get("protected_branches") is False,
        "Explicit deployment branch policy required",
    )
    policies = branches.get("branch_policies", [])
    require(
        branches.get("total_count") == len(policies) == 1
        and policies[0].get("name") == "main"
        and policies[0].get("type") == "branch",
        "Only main may use the release environment",
    )


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        require(new_url.startswith("https://"), "HTTPS redirect required")
        redirected = super().redirect_request(
            request, fp, code, message, headers, new_url
        )
        if (
            urllib.parse.urlparse(request.full_url).netloc
            != urllib.parse.urlparse(new_url).netloc
        ):
            redirected.remove_header("Authorization")
        return redirected


def download(url, maximum, token=None):
    require(url.startswith("https://"), "HTTPS required")
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        require(
            url.startswith("https://api.github.com/"),
            "Token may only be sent to GitHub API",
        )
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.build_opener(SafeRedirect()).open(
        request, timeout=60
    ) as response:
        data = response.read(maximum + 1)
    require(len(data) <= maximum, "Download exceeds limit")
    return data


def api(path):
    token = os.environ.get("GH_TOKEN")
    require(bool(token), "Read-only Actions token missing")
    return read_json(
        download(
            "https://api.github.com/repos/shimi-lynx/mogledge/" + path,
            MAX_METADATA,
            token,
        )
    )


def metadata(candidate, run, artifact):
    fresh(candidate)
    require(
        run["id"] == candidate["run_id"] and run["head_sha"] == candidate["source_sha"],
        "Build run/SHA mismatch",
    )
    require(
        run["repository"]["id"]
        == run["head_repository"]["id"]
        == candidate["repository_id"],
        "Foreign build repository",
    )
    require(
        run["repository"]["full_name"] == candidate["repository"],
        "Build repository name mismatch",
    )
    require(
        run["head_branch"] == "main" and run["path"] == candidate["workflow_path"],
        "Untrusted build branch/workflow",
    )
    require(
        run["event"] == "workflow_dispatch"
        and run["status"] == "completed"
        and run["conclusion"] == "success",
        "Successful manual build required",
    )
    require(
        artifact["id"] == candidate["artifact_id"]
        and artifact["name"] == candidate["artifact_name"],
        "Artifact identity mismatch",
    )
    require(
        artifact["expired"] is False
        and artifact["expires_at"] == candidate["expires_at"],
        "Artifact expired or expiry changed",
    )
    require(
        artifact["size_in_bytes"] == candidate["artifact_size"]
        and artifact["digest"] == "sha256:" + candidate["artifact_sha256"],
        "Artifact size/digest mismatch",
    )
    source = artifact["workflow_run"]
    require(
        source["id"] == candidate["run_id"]
        and source["head_sha"] == candidate["source_sha"]
        and source["head_branch"] == "main",
        "Artifact run binding mismatch",
    )
    require(
        source["repository_id"]
        == source["head_repository_id"]
        == candidate["repository_id"],
        "Foreign artifact repository",
    )


def validated_archive(data, candidate):
    require(
        len(data) <= MAX_ARCHIVE
        and len(data) == candidate["artifact_size"]
        and sha256(data) == candidate["artifact_sha256"],
        "Outer artifact size/digest mismatch",
    )
    expected = {
        candidate["update_archive"],
        candidate["initial_archive"],
        "manifest.json",
        "SHA256SUMS.txt",
    }
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        require(
            len(entries) == 4 and {entry.filename for entry in entries} == expected,
            "Unexpected or duplicate artifact entries",
        )
        for entry in entries:
            require(
                not entry.is_dir()
                and "/" not in entry.filename
                and "\\" not in entry.filename,
                "Unsafe artifact path",
            )
            mode = entry.external_attr >> 16
            require(
                stat.S_IFMT(mode) in (0, stat.S_IFREG), "Non-regular artifact entry"
            )
            require(
                not entry.flag_bits & 1 and entry.file_size <= MAX_ARCHIVE,
                "Encrypted or oversized artifact entry",
            )
            if entry.filename in {"manifest.json", "SHA256SUMS.txt"}:
                require(entry.file_size <= MAX_METADATA, "Oversized artifact metadata")
        manifest = read_json(archive.read("manifest.json"))
        for name in (
            "version",
            "platform",
            "architecture",
            "target",
            "identifier",
            "signature",
        ):
            require(
                manifest[name] == candidate[name], "Manifest identity mismatch: " + name
            )
        require(
            manifest["productName"] == "Mogledge"
            and manifest["sourceSha"] == candidate["source_sha"],
            "Manifest product/source mismatch",
        )
        require(
            manifest["updater"] is True and manifest["notarized"] is False,
            "Unexpected enrollment/OS signature",
        )
        require(
            manifest["distributionConfigSha256"]
            == candidate["distribution_config_sha256"],
            "Distribution configuration mismatch",
        )
        require(
            manifest["updateArchive"] == candidate["update_archive"],
            "Update archive mismatch",
        )
        checksums = archive.read("SHA256SUMS.txt").decode("ascii").splitlines()
        require(len(checksums) == 2, "Expected two archive checksums")
        records = {}
        for line in checksums:
            match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9_.-]+)", line)
            require(
                match is not None and match[2] not in records,
                "Malformed or duplicate checksum",
            )
            records[match[2]] = match[1]
        require(
            set(records) == {candidate["update_archive"], candidate["initial_archive"]},
            "Unexpected checksum paths",
        )
        payload = archive.read(candidate["update_archive"])
        require(
            sha256(payload)
            == records[candidate["update_archive"]]
            == manifest["updateArchiveSha256"],
            "Update archive hash mismatch",
        )
        require(
            sha256(archive.read(candidate["initial_archive"]))
            == records[candidate["initial_archive"]],
            "Initial archive hash mismatch",
        )
    return payload


def prepare(destination):
    source_context(os.environ)
    config = policy()
    candidate, approval = config["candidate"], config["approval"]
    # Check the committed kill switch before network access. No signing job is scheduled on failure.
    require(
        approval["enabled"] is True,
        "Signing disabled: effective human approval gate has not been verified",
    )
    approval_gate(
        approval,
        api(""),
        api("environments/release"),
        api("environments/release/deployment-branch-policies"),
    )
    metadata(
        candidate,
        api(f"actions/runs/{candidate['run_id']}"),
        api(f"actions/artifacts/{candidate['artifact_id']}"),
    )
    data = download(
        f"https://api.github.com/repos/shimi-lynx/mogledge/actions/artifacts/{candidate['artifact_id']}/zip",
        MAX_ARCHIVE,
        os.environ["GH_TOKEN"],
    )
    validated_archive(data, candidate)
    destination.mkdir()
    (destination / "candidate.zip").write_bytes(data)


def gate():
    source_context(os.environ)
    config = policy()
    approval = config["approval"]
    require(
        approval["enabled"] is True,
        "Signing disabled: effective human approval gate has not been verified",
    )
    approval_gate(
        approval,
        api(""),
        api("environments/release"),
        api("environments/release/deployment-branch-policies"),
    )
    fresh(config["candidate"])


def provision(destination):
    # Only these integrity-pinned official npm packages are installed; no npm lifecycle scripts.
    for name, integrity in TOOL_PACKAGES:
        data = download(
            f"https://registry.npmjs.org/@tauri-apps/{name}/-/{name}-2.12.1.tgz",
            MAX_ARCHIVE,
        )
        require(
            hashlib.sha512(data).digest() == base64.b64decode(integrity, validate=True),
            "Signing tool integrity mismatch",
        )
        package = destination / "node_modules" / "@tauri-apps" / name
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            entries = archive.getmembers()
            require(
                sum(entry.size for entry in entries) <= MAX_ARCHIVE,
                "Oversized signing tool",
            )
            seen = set()
            for entry in entries:
                parts = PurePosixPath(entry.name).parts
                require(
                    parts
                    and parts[0] == "package"
                    and ".." not in parts
                    and "\\" not in entry.name,
                    "Unsafe signing tool path",
                )
                require(
                    entry.name not in seen and (entry.isdir() or entry.isfile()),
                    "Duplicate/non-regular signing tool entry",
                )
                seen.add(entry.name)
                target = package.joinpath(*parts[1:])
                if entry.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.extractfile(entry).read())
                    target.chmod(0o644)


def sign(candidate_zip, tool, destination):
    source_context(os.environ)
    require(policy()["approval"]["enabled"] is True, "Signing activation is disabled")
    candidate = policy()["candidate"]
    fresh(candidate)
    payload = validated_archive(candidate_zip.read_bytes(), candidate)
    require(
        bool(os.environ.get("TAURI_SIGNING_PRIVATE_KEY")), "Signing key unavailable"
    )
    require(
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" in os.environ,
        "Signing password variable unavailable",
    )
    destination.mkdir()
    archive = destination / candidate["update_archive"]
    archive.write_bytes(payload)
    # Secrets exist only in this step and child environment, never arguments, files or diagnostics.
    environment = {
        key: os.environ[key]
        for key in (
            "PATH",
            "HOME",
            "TAURI_SIGNING_PRIVATE_KEY",
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        )
    }
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    result = subprocess.run(
        [
            shutil.which("node"),
            str(tool / "node_modules/@tauri-apps/cli/tauri.js"),
            "signer",
            "sign",
            "--app-version",
            candidate["version"],
            str(archive.resolve()),
        ],
        cwd=destination,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=120,
        check=False,
    )
    require(
        result.returncode == 0,
        "Signing failed; tool output suppressed to protect secrets",
    )
    require(
        sha256(archive.read_bytes()) == sha256(payload), "Signer changed archive bytes"
    )
    signature = Path(str(archive) + ".sig")
    require(
        signature.is_file()
        and not signature.is_symlink()
        and 0 < signature.stat().st_size <= MAX_METADATA,
        "Signature missing or oversized",
    )
    # This artifact is explicitly unverified. The next job has no production secrets.
    archive.unlink()


def verify(candidate_zip, signature_dir, verifier, destination):
    source_context(os.environ)
    candidate = policy()["candidate"]
    fresh(candidate)
    payload = validated_archive(candidate_zip.read_bytes(), candidate)
    signature_name = candidate["update_archive"] + ".sig"
    require(
        {path.name for path in signature_dir.iterdir()} == {signature_name},
        "Unexpected signature files",
    )
    signature = signature_dir / signature_name
    require(
        not signature.is_symlink() and signature.stat().st_size <= MAX_METADATA,
        "Unsafe signature",
    )
    destination.mkdir()
    archive = destination / candidate["update_archive"]
    archive.write_bytes(payload)
    result = subprocess.run(
        [
            str(verifier.resolve()),
            str(archive.resolve()),
            str(signature.resolve()),
            candidate["public_key"],
            candidate["version"],
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=120,
    )
    require(
        result.returncode == 0,
        "Cryptographic signature or signed-version verification failed",
    )
    (destination / signature_name).write_bytes(signature.read_bytes())
    receipt = {
        "status": "signature-verified-only",
        "candidate": candidate,
        "toolingSha": os.environ["GITHUB_SHA"],
        "signingWorkflowRun": os.environ["GITHUB_RUN_ID"],
        "updateArchiveSha256": sha256(payload),
        "signatureSha256": sha256(signature.read_bytes()),
        "published": False,
        "nativeUpdateTested": False,
    }
    (destination / "verification.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (destination / "SHA256SUMS.txt").write_text(
        f"{sha256(payload)}  {archive.name}\n{sha256(signature.read_bytes())}  {signature_name}\n"
    )


def main():
    command, *arguments = sys.argv[1:]
    functions = {
        "gate": gate,
        "prepare": prepare,
        "provision": provision,
        "sign": sign,
        "verify": verify,
    }
    require(command in functions, "Unknown signing operation")
    functions[command](*(Path(argument) for argument in arguments))


if __name__ == "__main__":
    try:
        main()
    except ValidationError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Network/tool exceptions can contain credential-bearing URLs or tool output.
        print(
            "Signing workflow stopped safely. Check gate, trusted metadata, hashes and tool configuration; raw diagnostics are suppressed.",
            file=sys.stderr,
        )
        sys.exit(1)
