"""Boundary fixtures only: no private keys, signing, app execution or live writes."""

import base64
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

import release


def context(workflow="release-signing.yml"):
    return {
        "GITHUB_REPOSITORY": release.REPOSITORY,
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_WORKFLOW_REF": f"{release.REPOSITORY}/.github/workflows/{workflow}@refs/heads/main",
        "GITHUB_SHA": "b" * 40,
        "GITHUB_WORKFLOW_SHA": "b" * 40,
        "EXPECTED_WORKFLOW_SHA": "b" * 40,
        "GITHUB_RUN_ID": "300",
    }


def fixture():
    config = copy.deepcopy(release.policy())
    config["approval"]["enabled"] = True
    config["source_sha"] = "a" * 40
    for index, (platform, (target, signature, _)) in enumerate(release.PLATFORMS.items()):
        candidate = copy.deepcopy(release.signing.policy()["candidate"])
        prefix = f"Mogledge_0.8.2_{platform}_{signature}_updater_{config['source_sha'][:12]}"
        candidate.update(source_sha=config["source_sha"], version="0.8.2", platform=platform, target=target, signature=signature, architecture="arm64" if platform == "macos-arm64" else "x64", run_id=100 + index, artifact_id=200 + index, expires_at="2099-01-01T00:00:00Z", update_archive=prefix + ("-setup.exe" if platform == "windows-x64" else ".app.tar.gz"), initial_archive=prefix + ".zip", artifact_name=f"Mogledge-{platform}-{config['source_sha']}")
        config["candidates"].append(candidate)
    return config


def packed(candidate):
    payload = ("opaque fixture " + candidate["platform"]).encode()
    initial = b"opaque initial ZIP"
    manifest = {name: candidate[name] for name in ("version", "platform", "architecture", "target", "identifier", "signature")}
    manifest.update(productName="Mogledge", sourceSha=candidate["source_sha"], updater=True, notarized=False, distributionConfigSha256=candidate["distribution_config_sha256"], updateArchive=candidate["update_archive"], updateArchiveSha256=release.signing.sha256(payload))
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as zipped:
        zipped.writestr(candidate["update_archive"], payload)
        zipped.writestr(candidate["initial_archive"], initial)
        zipped.writestr("manifest.json", json.dumps(manifest))
        zipped.writestr("SHA256SUMS.txt", f"{release.signing.sha256(payload)}  {candidate['update_archive']}\n{release.signing.sha256(initial)}  {candidate['initial_archive']}\n")
    candidate.update(artifact_size=len(raw.getvalue()), artifact_sha256=release.signing.sha256(raw.getvalue()))
    return raw.getvalue()


def verified_fixture(root):
    config = fixture()
    source, signatures, output = root / "input", root / "signatures", root / "verified"
    source.mkdir()
    signatures.mkdir()
    for candidate in config["candidates"]:
        folder = source / candidate["platform"]
        folder.mkdir()
        (folder / "candidate.zip").write_bytes(packed(candidate))
        (signatures / (candidate["update_archive"] + ".sig")).write_bytes(base64.b64encode(b"opaque signature fixture"))
    with patch.dict(os.environ, context(), clear=True), patch.object(release, "policy", return_value=config), patch.object(release, "signature_check") as verifier:
        release.verify(source, signatures, root / "public-verifier", output)
        assert verifier.call_count == 3
    files = {entry.name: entry.read_bytes() for entry in output.iterdir()}
    config["publication"].update(enabled=True, verification_run_id=300, verification_tooling_sha="b" * 40, artifact_id=400, artifact_name="production-verified-0.8.2-300-1", expires_at="2099-01-01T00:00:00Z")
    return config, files


def publication_zip(config, files):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as zipped:
        for name, content in files.items():
            zipped.writestr(name, content)
    raw = data.getvalue()
    config["publication"].update(artifact_size=len(raw), artifact_sha256=release.signing.sha256(raw))
    return raw


class PolicyTests(unittest.TestCase):
    def test_committed_signing_and_publication_stop_before_metadata(self):
        with patch.dict(os.environ, context(), clear=True), patch.object(release, "metadata") as metadata:
            with self.assertRaisesRegex(ValueError, "disabled"):
                release.prepare(Path("unused"))
            metadata.assert_not_called()
        with patch.dict(os.environ, context("release-publication.yml"), clear=True), patch.object(release, "metadata") as metadata:
            with self.assertRaisesRegex(ValueError, "disabled"):
                release.publication_prepare(Path("unused"), Path("unused"))
            metadata.assert_not_called()

    def test_old_version_changed_source_scope_or_key_cannot_be_substituted(self):
        release.candidate_policy(fixture())
        for field, value in (("version", "0.8.1"), ("source_sha", "c" * 40), ("public_key", "fixture-wrong-key"), ("identifier", "changed"), ("target", "changed"), ("update_archive", "../changed")):
            config = fixture()
            config["candidates"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                release.candidate_policy(config)
        config = fixture()
        config["candidates"].pop()
        with self.assertRaises(ValueError):
            release.candidate_policy(config)

    def test_context_pins_each_separate_manual_main_workflow(self):
        for workflow in ("release-signing.yml", "release-publication.yml"):
            with patch.dict(os.environ, context(workflow), clear=True):
                release.source_context(workflow)
            for key, value in (("GITHUB_SHA", "c" * 40), ("GITHUB_REF", "refs/heads/other"), ("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_WORKFLOW_REF", "trial")):
                with self.subTest(workflow=workflow, key=key), patch.dict(os.environ, context(workflow) | {key: value}, clear=True), self.assertRaises(ValueError):
                    release.source_context(workflow)

    def test_publication_remains_disabled_after_signing_activation(self):
        config = fixture()
        release.candidate_policy(config)
        with self.assertRaisesRegex(ValueError, "Publication disabled"):
            release.publication_policy(config)

    def test_metadata_error_reports_only_public_stage_and_status(self):
        error = urllib.error.HTTPError("https://fixture.invalid/private-value", 403, "fixture-private-message", {}, None)
        with patch.object(release.signing, "api", side_effect=error), self.assertRaisesRegex(ValueError, "Repository metadata: HTTP 403") as stopped:
            release.metadata("", "Repository metadata")
        self.assertNotIn("private", str(stopped.exception))


class VerificationTests(unittest.TestCase):
    def test_signer_failure_has_no_secret_arguments_diagnostics_or_extra_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, _ = verified_fixture(root)
            environment = context() | {"PATH": os.defpath, "HOME": temporary, "GH_TOKEN": "fixture-api-token", "NODE_OPTIONS": "fixture-untrusted", "TAURI_SIGNING_PRIVATE_KEY": "fixture-key-marker", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "fixture-password-marker"}
            with patch.dict(os.environ, environment, clear=True), patch.object(release, "policy", return_value=config), patch.object(release.resource, "setrlimit"), patch.object(release.shutil, "which", return_value="/usr/bin/node"), patch.object(release.subprocess, "run") as run:
                run.return_value.returncode = 1
                with self.assertRaisesRegex(ValueError, "diagnostics suppressed") as stopped:
                    release.sign(root / "input", root / "trusted-tool", root / "failed-signing")
                args, keywords = run.call_args
                self.assertNotIn("fixture-key-marker", str(args))
                self.assertNotIn("fixture-password-marker", str(stopped.exception))
                self.assertNotIn("GH_TOKEN", keywords["env"])
                self.assertNotIn("NODE_OPTIONS", keywords["env"])
                self.assertEqual(keywords["stdout"], release.subprocess.DEVNULL)
                self.assertEqual(keywords["stderr"], release.subprocess.DEVNULL)
                self.assertEqual(keywords["stdin"], release.subprocess.DEVNULL)
                self.assertIn("0.8.2", args[0])

    def test_feed_has_exact_platforms_https_asset_urls_and_signature_contents(self):
        config = fixture()
        signatures = {item["update_archive"] + ".sig": base64.b64encode(b"fixture") for item in config["candidates"]}
        feed = release.feed(config, signatures, "2026-10-14T00:00:00Z")
        self.assertEqual(set(feed["platforms"]), {"windows-x86_64", "darwin-x86_64", "darwin-aarch64"})
        for entry in feed["platforms"].values():
            self.assertTrue(entry["url"].startswith("https://github.com/shimi-lynx/mogledge/releases/download/v0.8.2/"))
            self.assertEqual(entry["signature"], base64.b64encode(b"fixture").decode())
        with self.assertRaises(ValueError):
            release.feed(config, signatures, "2026-10-14T00:00:00+01:00")

    def test_verified_assets_receipt_and_crypto_recheck(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, files = verified_fixture(root)
            with patch.object(release, "signature_check") as verifier:
                release.validate_publication(publication_zip(config, files), config, root / "verifier", root / "publication")
                self.assertEqual(verifier.call_count, 3)
                self.assertEqual({entry.name for entry in (root / "publication").iterdir()}, set(files))

    def test_changed_payload_wrong_receipt_feed_path_or_outer_digest_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, files = verified_fixture(root)
            changed_receipt = json.loads(files["verification.json"]) | {"published": True}
            cases = [files | {config["candidates"][0]["update_archive"]: b"tampered"}, files | {"verification.json": json.dumps(changed_receipt).encode()}, files | {"../extra": b"unsafe"}]
            for index, changed in enumerate(cases):
                with self.subTest(index=index), self.assertRaises(ValueError), patch.object(release, "signature_check") as verifier:
                    release.validate_publication(publication_zip(config, changed), config, root / "verifier", root / f"rejected{index}")
                verifier.assert_not_called()
            raw = publication_zip(config, files)
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                release.validate_publication(raw + b"tampered", config, root / "verifier", root / "rejected-outer")

    def test_crypto_rejection_does_not_create_success_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, _ = verified_fixture(root)
            with patch.dict(os.environ, context(), clear=True), patch.object(release, "policy", return_value=config), patch.object(release, "signature_check", side_effect=release.signing.ValidationError("fixture rejected")), self.assertRaises(ValueError):
                release.verify(root / "input", root / "signatures", root / "verifier", root / "rejected")
            self.assertFalse((root / "rejected/verification.json").exists())


class PublicationTests(unittest.TestCase):
    def test_workflow_changes_after_binary_build_fail_without_broader_permissions(self):
        workflows = [{"name": "release-signing.yml", "sha": "c" * 40, "type": "file"}]
        responses = [{"default_branch": "main"}, {"object": {"sha": "b" * 40}}, workflows, workflows]
        with patch.object(release, "metadata", side_effect=responses):
            release.require_workflow_compatibility("a" * 40)
        changed = responses[:-1] + [[workflows[0] | {"sha": "d" * 40}]]
        with patch.object(release, "metadata", side_effect=changed), self.assertRaisesRegex(ValueError, "without broader credentials"):
            release.require_workflow_compatibility("a" * 40)

    def fixture(self, root):
        config, files = verified_fixture(root)
        publication_zip(config, files)
        self.config, self.files, self.root = config, files, root
        self.calls, self.assets = [], []

    def prepare(self, verifier, destination):
        destination.mkdir()
        for name, data in self.files.items():
            (destination / name).write_bytes(data)

    def public_download(self, url, maximum, token=None):
        self.assertIsNone(token)
        self.assertTrue(url.startswith("https://github.com/shimi-lynx/mogledge/releases/"))
        name = url.rsplit("/", 1)[1]
        return self.files[name]

    def request(self, path, method="GET", data=None, upload_name=None):
        self.calls.append((path, method))
        if method == "GET" and path in ("git/ref/tags/v0.8.2", "releases/tags/v0.8.2"):
            if any(verb == "PATCH" for _, verb in self.calls):
                return {"object": {"type": "commit", "sha": self.config["source_sha"]}}
            raise urllib.error.HTTPError("https://fixture.invalid", 404, "fixture", {}, None)
        if method == "POST" and path == "releases":
            self.assertEqual(data["target_commitish"], self.config["source_sha"])
            self.assertIs(data["draft"], True)
            return {"id": 10, "draft": True, "tag_name": "v0.8.2", "target_commitish": self.config["source_sha"]}
        if method == "POST" and path == "releases/10/assets":
            asset = {"id": 1000 + len(self.assets), "name": upload_name, "size": len(data), "digest": "sha256:" + release.signing.sha256(data), "state": "uploaded"}
            self.assets.append(asset)
            return asset
        if method == "GET" and path == "releases/10":
            return {"id": 10, "draft": True, "tag_name": "v0.8.2", "target_commitish": self.config["source_sha"], "assets": self.assets}
        if method == "PATCH" and path == "releases/10":
            self.assertEqual({item["name"] for item in self.assets}, set(self.files))
            self.assertEqual(data["tag_name"], "v0.8.2")
            self.assertEqual(data["target_commitish"], self.config["source_sha"])
            return {"draft": False, "tag_name": "v0.8.2"}
        raise AssertionError("Unexpected fixture API operation")

    def test_stages_all_hash_verified_assets_before_publish_and_checks_tag_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.fixture(Path(temporary))
            with patch.dict(os.environ, context("release-publication.yml"), clear=True), patch.object(release, "policy", return_value=self.config), patch.object(release, "publication_prepare", side_effect=self.prepare), patch.object(release, "approval"), patch.object(release, "request", side_effect=self.request), patch.object(release.signing, "download", side_effect=self.public_download) as download, patch("builtins.print"):
                release.publish(self.root / "verifier", self.root / "publication")
            self.assertEqual(sum(method == "PATCH" for _, method in self.calls), 1)
            self.assertEqual(len(self.assets), len(self.files))
            self.assertEqual(download.call_count, 4)

    def test_anonymous_byte_mismatch_reports_failure_without_retry_or_deletion(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.fixture(Path(temporary))
            def download(url, maximum, token=None):
                data = self.public_download(url, maximum, token)
                return data if url.endswith("latest.json") else data + b"changed"
            with patch.dict(os.environ, context("release-publication.yml"), clear=True), patch.object(release, "policy", return_value=self.config), patch.object(release, "publication_prepare", side_effect=self.prepare), patch.object(release, "approval"), patch.object(release, "request", side_effect=self.request), patch.object(release.signing, "download", side_effect=download), patch("builtins.print"), self.assertRaisesRegex(ValueError, "Anonymous updater bytes"):
                release.publish(self.root / "verifier", self.root / "publication")
            self.assertEqual(sum(method == "PATCH" for _, method in self.calls), 1)
            self.assertFalse(any(method == "DELETE" for _, method in self.calls))

    def test_existing_release_or_tag_stops_without_any_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.fixture(Path(temporary))
            with patch.dict(os.environ, context("release-publication.yml"), clear=True), patch.object(release, "policy", return_value=self.config), patch.object(release, "publication_prepare", side_effect=self.prepare), patch.object(release, "approval"), patch.object(release, "request", return_value={}) as request, self.assertRaisesRegex(ValueError, "no overwrite"):
                release.publish(self.root / "verifier", self.root / "publication")
            self.assertEqual(request.call_args.args, ("git/ref/tags/v0.8.2",))

    def test_wrong_uploaded_digest_never_publishes_draft(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.fixture(Path(temporary))
            def request(path, method="GET", data=None, upload_name=None):
                result = self.request(path, method, data, upload_name)
                return result | {"digest": "sha256:" + "0" * 64} if upload_name else result
            with patch.dict(os.environ, context("release-publication.yml"), clear=True), patch.object(release, "policy", return_value=self.config), patch.object(release, "publication_prepare", side_effect=self.prepare), patch.object(release, "approval"), patch.object(release, "request", side_effect=request), self.assertRaisesRegex(ValueError, "digest/size mismatch"):
                release.publish(self.root / "verifier", self.root / "publication")
            self.assertFalse(any(method == "PATCH" for _, method in self.calls))

    def test_changed_draft_digest_or_identity_stops_before_publication(self):
        for change in ("digest", "tag", "source"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                self.fixture(Path(temporary))
                def request(path, method="GET", data=None, upload_name=None):
                    result = copy.deepcopy(self.request(path, method, data, upload_name))
                    if path == "releases/10" and method == "GET":
                        if change == "digest":
                            result["assets"][0]["digest"] = "sha256:" + "0" * 64
                        elif change == "tag":
                            result["tag_name"] = "v9.9.9"
                        else:
                            result["target_commitish"] = "c" * 40
                    return result
                with patch.dict(os.environ, context("release-publication.yml"), clear=True), patch.object(release, "policy", return_value=self.config), patch.object(release, "publication_prepare", side_effect=self.prepare), patch.object(release, "approval"), patch.object(release, "request", side_effect=request), self.assertRaises(ValueError):
                    release.publish(self.root / "verifier", self.root / "publication")
                self.assertFalse(any(method == "PATCH" for _, method in self.calls))


class WorkflowTests(unittest.TestCase):
    def test_two_manual_workflows_have_distinct_native_human_approvals(self):
        root = release.ROOT.parents[1]
        signing = (root / ".github/workflows/release-signing.yml").read_text()
        publication = (root / ".github/workflows/release-publication.yml").read_text()
        for text in (signing, publication):
            self.assertIn("workflow_dispatch:", text)
            self.assertIn("permissions: {}", text)
            self.assertEqual(text.count("environment: release"), 1)
            self.assertNotIn("pull_request:", text)
            self.assertNotIn("push:", text)
            self.assertNotIn("cancel-in-progress: true", text)
        self.assertEqual(signing.count("secrets."), 2)
        self.assertNotIn("contents: write", signing)
        self.assertNotIn("secrets.", publication)
        prepare, publish = publication.split("  publish:", 1)
        self.assertNotIn("contents: write", prepare)
        self.assertIn("contents: write", publish)
        self.assertIn("actions: read", publish)
        self.assertIn("needs: prepare", publish)
        self.assertIn("if: needs.prepare.outputs.ready == 'true'", publish)


if __name__ == "__main__":
    unittest.main()
