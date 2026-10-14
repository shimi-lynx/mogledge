"""Fixture-only boundary tests. No keys, signing, application or network execution."""

import copy
import base64
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import tarfile
import unittest
from unittest.mock import patch
import urllib.request
import warnings
import zipfile

import control


def fixture():
    candidate = copy.deepcopy(control.policy()["candidate"])
    payload = b"opaque updater tar; never extracted or executed"
    initial = b"opaque initial-install zip"
    manifest = {
        name: candidate[name]
        for name in (
            "version",
            "platform",
            "architecture",
            "target",
            "identifier",
            "signature",
        )
    }
    manifest.update(
        productName="Mogledge",
        sourceSha=candidate["source_sha"],
        updater=True,
        notarized=False,
        distributionConfigSha256=candidate["distribution_config_sha256"],
        updateArchive=candidate["update_archive"],
        updateArchiveSha256=control.sha256(payload),
    )
    files = {
        candidate["update_archive"]: payload,
        candidate["initial_archive"]: initial,
        "manifest.json": json.dumps(manifest).encode(),
        "SHA256SUMS.txt": f"{control.sha256(payload)}  {candidate['update_archive']}\n{control.sha256(initial)}  {candidate['initial_archive']}\n".encode(),
    }
    return candidate, files


def packed(candidate, files):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    candidate["artifact_sha256"] = control.sha256(data.getvalue())
    candidate["artifact_size"] = len(data.getvalue())
    return data.getvalue()


def context():
    return {
        "GITHUB_REPOSITORY": "shimi-lynx/mogledge",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_WORKFLOW_REF": "shimi-lynx/mogledge/.github/workflows/updater-signing.yml@refs/heads/main",
        "EXPECTED_WORKFLOW_SHA": "a" * 40,
        "GITHUB_SHA": "a" * 40,
        "GITHUB_WORKFLOW_SHA": "a" * 40,
    }


class ApiTests(unittest.TestCase):
    def test_repository_metadata_uses_canonical_endpoint_without_trailing_slash(self):
        with patch.dict(os.environ, {"GH_TOKEN": "fixture-token"}, clear=True), patch.object(
            control, "download", return_value=b'{"id":1416386985}'
        ) as download:
            self.assertEqual(control.api(""), {"id": 1416386985})
            download.assert_called_once_with(
                "https://api.github.com/repos/shimi-lynx/mogledge",
                control.MAX_METADATA,
                "fixture-token",
            )

    def test_subresource_endpoints_and_read_only_token_requirement_are_preserved(self):
        for path in (
            "environments/release",
            "environments/release/deployment-branch-policies",
            "actions/runs/38495813692",
            "actions/artifacts/11865015479",
        ):
            with self.subTest(path=path), patch.dict(
                os.environ, {"GH_TOKEN": "fixture-token"}, clear=True
            ), patch.object(control, "download", return_value=b"{}") as download:
                self.assertEqual(control.api(path), {})
                download.assert_called_once_with(
                    "https://api.github.com/repos/shimi-lynx/mogledge/" + path,
                    control.MAX_METADATA,
                    "fixture-token",
                )
        with patch.dict(os.environ, {}, clear=True), patch.object(
            control, "download"
        ) as download, self.assertRaisesRegex(ValueError, "token missing"):
            control.api("")
        download.assert_not_called()


class SourceTests(unittest.TestCase):
    def test_exact_reviewed_main_context(self):
        control.source_context(context())
        for key, value in {
            "GITHUB_REPOSITORY": "other/repo",
            "GITHUB_REF": "refs/heads/trial",
            "GITHUB_EVENT_NAME": "pull_request",
            "EXPECTED_WORKFLOW_SHA": "main",
            "GITHUB_SHA": "b" * 40,
            "GITHUB_WORKFLOW_SHA": "b" * 40,
            "GITHUB_WORKFLOW_REF": "other",
        }.items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                control.source_context(context() | {key: value})

    def test_expired_candidate_is_not_automatically_replaced(self):
        candidate, _ = fixture()
        control.fresh(candidate, dt.datetime(2026, 10, 16, tzinfo=dt.timezone.utc))
        with self.assertRaises(ValueError):
            control.fresh(
                candidate, dt.datetime(2026, 10, 17, 1, 57, 50, tzinfo=dt.timezone.utc)
            )

    def test_disabled_policy_stops_before_api_or_secrets_job(self):
        disabled = copy.deepcopy(control.policy())
        disabled["approval"].update(enabled=False, environment_id=None)
        with patch.dict(os.environ, context(), clear=True), patch.object(
            control, "policy", return_value=disabled
        ), patch.object(control, "api") as api:
            with self.assertRaisesRegex(ValueError, "Signing disabled"):
                control.prepare(Path("unused"))
            api.assert_not_called()


class GateTests(unittest.TestCase):
    def setUp(self):
        self.approval = control.policy()["approval"] | {
            "enabled": True,
            "environment_id": 123,
        }
        self.repository = {"id": 1416386985, "private": False}
        self.environment = {
            "id": 123,
            "name": "release",
            "can_admins_bypass": False,
            "protection_rules": [
                {
                    "type": "required_reviewers",
                    "reviewers": [{"type": "User", "reviewer": {"id": 56603283}}],
                }
            ],
            "deployment_branch_policy": {
                "custom_branch_policies": True,
                "protected_branches": False,
            },
        }
        self.branches = {
            "total_count": 1,
            "branch_policies": [{"id": 1, "name": "main", "type": "branch"}],
        }

    def check(self):
        control.approval_gate(
            self.approval, self.repository, self.environment, self.branches
        )

    def test_supported_gate_fixture(self):
        self.check()

    def test_private_free_and_unverified_entitlement_rejected(self):
        self.repository["private"] = True
        with self.assertRaisesRegex(ValueError, "entitlement"):
            self.check()

    def test_secrets_without_reviewers_and_bypass_rejected(self):
        for changes in (
            {"protection_rules": []},
            {"can_admins_bypass": True},
            {"can_admins_bypass": None},
            {"id": 456},
            {"name": "other"},
            {"deployment_branch_policy": None},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                control.approval_gate(
                    self.approval,
                    self.repository,
                    self.environment | changes,
                    self.branches,
                )

    def test_reviewers_and_branch_scope_cannot_be_broadened(self):
        self.environment["protection_rules"][0]["reviewers"].append(
            {"type": "User", "reviewer": {"id": 999}}
        )
        with self.assertRaises(ValueError):
            self.check()
        self.setUp()
        for branch in ("*", "release", "main*"):
            self.branches["branch_policies"][0]["name"] = branch
            with self.subTest(branch=branch), self.assertRaises(ValueError):
                self.check()
        self.setUp()
        self.branches["branch_policies"][0]["type"] = "tag"
        with self.assertRaises(ValueError):
            self.check()


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.candidate, _ = fixture()
        c = self.candidate
        self.run = {
            "id": c["run_id"],
            "head_sha": c["source_sha"],
            "repository": {"id": c["repository_id"], "full_name": c["repository"]},
            "head_repository": {"id": c["repository_id"]},
            "head_branch": "main",
            "path": c["workflow_path"],
            "event": "workflow_dispatch",
            "status": "completed",
            "conclusion": "success",
        }
        self.artifact = {
            "id": c["artifact_id"],
            "name": c["artifact_name"],
            "expired": False,
            "expires_at": c["expires_at"],
            "size_in_bytes": c["artifact_size"],
            "digest": "sha256:" + c["artifact_sha256"],
            "workflow_run": {
                "id": c["run_id"],
                "head_sha": c["source_sha"],
                "head_branch": "main",
                "repository_id": c["repository_id"],
                "head_repository_id": c["repository_id"],
            },
        }

    def test_exact_run_sha_digest_version_record(self):
        with patch.object(control, "fresh"):
            control.metadata(self.candidate, self.run, self.artifact)

    def test_changed_run_or_artifact_fails(self):
        for field, value in {
            "id": 1,
            "head_sha": "b" * 40,
            "head_branch": "feature",
            "path": "other.yml",
            "event": "pull_request",
            "conclusion": "failure",
            "status": "in_progress",
        }.items():
            with self.subTest(run_field=field), patch.object(
                control, "fresh"
            ), self.assertRaises(ValueError):
                control.metadata(
                    self.candidate, self.run | {field: value}, self.artifact
                )
        for field, value in {
            "id": 1,
            "name": "replacement",
            "expired": True,
            "size_in_bytes": 0,
            "digest": "sha256:" + "0" * 64,
            "expires_at": "2050-01-01T00:00:00Z",
        }.items():
            with self.subTest(artifact_field=field), patch.object(
                control, "fresh"
            ), self.assertRaises(ValueError):
                control.metadata(
                    self.candidate, self.run, self.artifact | {field: value}
                )
        self.artifact["workflow_run"]["head_repository_id"] = 1
        with patch.object(control, "fresh"), self.assertRaises(ValueError):
            control.metadata(self.candidate, self.run, self.artifact)


class ArchiveTests(unittest.TestCase):
    def test_valid_fixture_keeps_tar_opaque(self):
        candidate, files = fixture()
        payload = control.validated_archive(packed(candidate, files), candidate)
        self.assertEqual(payload, files[candidate["update_archive"]])

    def test_outer_and_inner_tampering_rejected(self):
        candidate, files = fixture()
        data = packed(candidate, files)
        with self.assertRaises(ValueError):
            control.validated_archive(data + b"tampered", candidate)
        for name in (
            candidate["update_archive"],
            candidate["initial_archive"],
            "SHA256SUMS.txt",
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                control.validated_archive(
                    packed(candidate, files | {name: b"tampered"}), candidate
                )

    def test_manifest_version_identity_enrollment_and_config_bound(self):
        candidate, files = fixture()
        for field, value in {
            "version": "0.8.2",
            "sourceSha": "b" * 40,
            "identifier": "other",
            "updater": False,
            "notarized": True,
            "distributionConfigSha256": "0" * 64,
            "updateArchive": "other.tar.gz",
            "platform": "macos-arm64",
        }.items():
            changed = json.loads(files["manifest.json"]) | {field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                control.validated_archive(
                    packed(
                        candidate,
                        files | {"manifest.json": json.dumps(changed).encode()},
                    ),
                    candidate,
                )

    def test_zip_duplicate_path_extra_symlink_and_oversize_rejected(self):
        candidate, files = fixture()
        for path in (
            "../payload",
            "/payload",
            "nested/payload",
            "payload\\evil",
            "extra",
        ):
            with self.subTest(path=path), self.assertRaises(ValueError):
                control.validated_archive(
                    packed(candidate, files | {path: b"x"}), candidate
                )
        for duplicate, symlink in ((True, False), (False, True)):
            data = io.BytesIO()
            with zipfile.ZipFile(data, "w") as archive, warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                for name, content in files.items():
                    entry = zipfile.ZipInfo(name)
                    entry.external_attr = (
                        (
                            stat.S_IFLNK
                            if symlink and name == candidate["update_archive"]
                            else stat.S_IFREG
                        )
                        | 0o644
                    ) << 16
                    archive.writestr(entry, content)
                if duplicate:
                    archive.writestr("manifest.json", files["manifest.json"])
            candidate["artifact_sha256"] = control.sha256(data.getvalue())
            candidate["artifact_size"] = len(data.getvalue())
            with self.assertRaises(ValueError):
                control.validated_archive(data.getvalue(), candidate)
        with self.assertRaises(ValueError):
            control.validated_archive(
                packed(
                    candidate,
                    files | {"manifest.json": b" " * (control.MAX_METADATA + 1)},
                ),
                candidate,
            )

    def test_duplicate_json_and_checksum_records_rejected(self):
        candidate, files = fixture()
        with self.assertRaises(ValueError):
            control.read_json(b'{"version":"0.8.1","version":"0.8.2"}')
        repeated = files["SHA256SUMS.txt"].splitlines()[0] + b"\n"
        with self.assertRaises(ValueError):
            control.validated_archive(
                packed(candidate, files | {"SHA256SUMS.txt": repeated * 2}), candidate
            )


class SecretBoundaryTests(unittest.TestCase):
    def test_redirect_strips_token_and_rejects_http(self):
        request = urllib.request.Request(
            "https://api.github.com/source", headers={"Authorization": "Bearer fixture"}
        )
        redirected = control.SafeRedirect().redirect_request(
            request, None, 302, "", {}, "https://storage.example/opaque"
        )
        self.assertIsNone(redirected.get_header("Authorization"))
        with self.assertRaises(ValueError):
            control.SafeRedirect().redirect_request(
                request, None, 302, "", {}, "http://storage.example/opaque"
            )

    def test_signer_failure_has_no_secret_arguments_or_output(self):
        candidate, files = fixture()
        config = control.policy() | {
            "candidate": candidate,
            "approval": {"enabled": True},
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "candidate.zip"
            source.write_bytes(packed(candidate, files))
            environment = context() | {
                "PATH": os.defpath,
                "HOME": temporary,
                "GH_TOKEN": "fixture-token",
                "NODE_OPTIONS": "untrusted-option",
                "TAURI_SIGNING_PRIVATE_KEY": "fixture-marker-only",
                "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "fixture-password-only",
            }
            with patch.dict(os.environ, environment, clear=True), patch.object(
                control, "policy", return_value=config
            ), patch.object(control, "fresh"), patch.object(
                control.resource, "setrlimit"
            ), patch.object(
                control.shutil, "which", return_value="/usr/bin/node"
            ), patch.object(
                control.subprocess, "run"
            ) as run:
                run.return_value.returncode = 1
                with self.assertRaisesRegex(ValueError, "output suppressed") as error:
                    control.sign(source, root / "tool", root / "output")
                args, keywords = run.call_args
                self.assertNotIn("fixture-marker-only", str(args))
                self.assertNotIn("fixture-marker-only", str(error.exception))
                self.assertNotIn("GH_TOKEN", keywords["env"])
                self.assertNotIn("NODE_OPTIONS", keywords["env"])
                self.assertEqual(keywords["stdout"], control.subprocess.DEVNULL)
                self.assertEqual(keywords["stderr"], control.subprocess.DEVNULL)
                self.assertEqual(keywords["stdin"], control.subprocess.DEVNULL)

    def test_verification_failure_never_creates_receipt(self):
        candidate, files = fixture()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "candidate.zip"
            source.write_bytes(packed(candidate, files))
            signatures = root / "signature"
            signatures.mkdir()
            (signatures / (candidate["update_archive"] + ".sig")).write_text(
                "fixture-invalid-signature"
            )
            with patch.dict(os.environ, context(), clear=True), patch.object(
                control, "policy", return_value={"candidate": candidate}
            ), patch.object(control, "fresh"), patch.object(
                control.subprocess, "run"
            ) as run:
                run.return_value.returncode = 1
                with self.assertRaisesRegex(ValueError, "verification failed"):
                    control.verify(
                        source, signatures, root / "verifier", root / "output"
                    )
                self.assertFalse((root / "output/verification.json").exists())


class ProvisionTests(unittest.TestCase):
    def test_tool_integrity_failure_precedes_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "tool"
            with patch.object(control, "download", return_value=b"changed package"):
                with self.assertRaisesRegex(ValueError, "tool integrity"):
                    control.provision(target)
            self.assertFalse(target.exists())

    def test_tool_path_and_symlink_cannot_escape(self):
        for name, kind in (
            ("package/../../outside", tarfile.REGTYPE),
            ("package/native.node", tarfile.SYMTYPE),
        ):
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode="w:gz") as archive:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.linkname = "../../outside" if kind == tarfile.SYMTYPE else ""
                archive.addfile(entry, io.BytesIO(b""))
            data = raw.getvalue()
            integrity = base64.b64encode(hashlib.sha512(data).digest()).decode()
            with tempfile.TemporaryDirectory() as temporary, patch.object(
                control, "download", return_value=data
            ), patch.object(control, "TOOL_PACKAGES", (("fixture", integrity),)):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    control.provision(Path(temporary) / "tool")
                self.assertFalse((Path(temporary) / "outside").exists())


class WorkflowTests(unittest.TestCase):
    def test_secret_environment_is_only_on_dependent_signing_job(self):
        workflow = (
            control.ROOT.parents[1] / ".github/workflows/updater-signing.yml"
        ).read_text()
        prepare, sign, verify = (
            workflow.split("  prepare:", 1)[1].split("  sign:", 1)[0],
            workflow.split("  sign:", 1)[1].split("  verify:", 1)[0],
            workflow.split("  verify:", 1)[1],
        )
        self.assertNotIn("environment:", prepare + verify)
        self.assertNotIn("secrets.", prepare + verify)
        self.assertEqual(workflow.count("environment: release"), 1)
        self.assertIn("needs: prepare", sign)
        self.assertIn("if: needs.prepare.outputs.ready == 'true'", sign)
        self.assertIn("needs: [prepare, sign]", verify)
        self.assertEqual(workflow.count("secrets."), 2)
        self.assertEqual(workflow.count("sparse-checkout: /scripts/signing/"), 3)
        self.assertNotIn("write", workflow)
        self.assertNotIn("npm ", workflow)
        self.assertNotIn("tauri build", workflow)
        self.assertIn("permissions: {}", workflow)
        self.assertIn("      expected_workflow_sha:", workflow)
        self.assertNotIn("type: boolean", workflow)

    def test_every_action_is_official_and_sha_pinned(self):
        workflow = (
            control.ROOT.parents[1] / ".github/workflows/updater-signing.yml"
        ).read_text()
        actions = re.findall(r"uses: (\S+)", workflow)
        self.assertTrue(actions)
        for action in actions:
            self.assertRegex(
                action,
                r"^actions/(checkout|setup-node|upload-artifact|download-artifact)@[0-9a-f]{40}$",
            )

    def test_public_identity_matches_existing_overlay_and_tool_lock(self):
        root = control.ROOT.parents[1]
        config = root / "src-tauri/tauri.updater.distribution.json"
        self.assertEqual(
            control.policy()["candidate"]["public_key"],
            json.loads(config.read_text())["plugins"]["updater"]["pubkey"],
        )
        self.assertEqual(
            control.policy()["candidate"]["distribution_config_sha256"],
            control.sha256(config.read_bytes()),
        )
        lock = (root / "package-lock.json").read_text()
        for name, integrity in control.TOOL_PACKAGES:
            self.assertIn('"integrity": "sha512-' + integrity + '"', lock)


if __name__ == "__main__":
    unittest.main()
