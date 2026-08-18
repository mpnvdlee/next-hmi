from __future__ import annotations

import asyncio
import io
import json
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from api import manager_peers_api
from api.manager_auth_api import router as auth_router
from api.manager_peers_api import manager_router, public_router
from core import manager_auth, peer_tokens, runtime_home
from core.exceptions import ConflictError, register_exception_handlers
from core.manifest import (
    ManifestV1,
    ProjectEntry,
    ProjectMetadata,
    RunningEntry,
    load_manifest,
    read_project_metadata,
    save_manifest,
    write_project_metadata,
)
from core.project_packer import pack_project
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(auth_router)
    app.include_router(public_router)
    app.include_router(manager_router)
    return app


def _configure_home(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    home = tmp_path / "runtime"
    root = home / "Projects"
    root.mkdir(parents=True)
    monkeypatch.setattr(runtime_home, "runtime_home_path", lambda: home)
    save_manifest(ManifestV1(defaultProjectsRoot=str(root)))
    manager_auth.set_password("destination-admin")
    return home, root


def _archive(
    tmp_path: Path, project_id: str = "source-id", name: str = "Source"
) -> bytes:
    source = tmp_path / f"source-{project_id}"
    source.mkdir()
    write_project_metadata(source, ProjectMetadata(id=project_id, name=name))
    (source / "pages.json").write_text('{"pages": []}', encoding="utf-8")
    output = io.BytesIO()
    pack_project(source, output)
    return output.getvalue()


def _pair(client: TestClient) -> str:
    response = client.post(
        "/api/manager/peer/pair",
        json={"password": "destination-admin", "name": "Workshop laptop"},
    )
    assert response.status_code == 201
    return response.json()["token"]


def _receive(
    client: TestClient,
    token: str,
    archive: bytes,
    **fields: str,
):
    data = {
        "transferId": "tx-test",
        "sourceProjectId": "source-id",
        "destinationProjectId": "source-id",
        "destinationFolder": "source-copy",
        "collisionPolicy": "reject",
        "confirmReplace": "false",
        "start": "false",
        **fields,
    }
    return client.post(
        "/api/manager/peer/transfers",
        headers={"Authorization": f"Bearer {token}"},
        data=data,
        files={"file": ("project.zip", archive, "application/zip")},
    )


def test_pair_persists_only_hash_and_password_change_revokes(
    monkeypatch, tmp_path: Path
):
    _configure_home(monkeypatch, tmp_path)
    with TestClient(_app()) as client:
        token = _pair(client)
        stored = peer_tokens.tokens_path().read_text(encoding="utf-8")
        assert token not in stored
        assert json.loads(stored)["tokens"][0]["hash"]

        assert (
            client.get(
                "/api/manager/peer/projects",
                headers={"Authorization": f"Bearer {token}"},
            ).status_code
            == 200
        )
        changed = client.post(
            "/api/manager/auth/change-password",
            json={"currentPassword": "destination-admin", "newPassword": "new-admin"},
        )
        assert changed.status_code == 200
        assert (
            client.get(
                "/api/manager/peer/projects",
                headers={"Authorization": f"Bearer {token}"},
            ).status_code
            == 401
        )


def test_receive_rejects_collision_by_default_and_is_idempotent(
    monkeypatch, tmp_path: Path
):
    _, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    with TestClient(_app()) as client:
        token = _pair(client)
        first = _receive(client, token, archive)
        assert first.status_code == 201
        assert (root / "source-copy" / "pages.json").is_file()
        assert load_manifest().projects[0].id == "source-id"

        retry = _receive(client, token, archive)
        assert retry.status_code == 201
        assert retry.json() == first.json()

        collision = _receive(
            client,
            token,
            archive,
            transferId="tx-collision",
            destinationFolder="another-folder",
        )
        assert collision.status_code == 409
        assert not (root / "another-folder").exists()


def test_copy_gets_explicit_new_id_and_target_root_is_enforced(
    monkeypatch, tmp_path: Path
):
    _, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    with TestClient(_app()) as client:
        token = _pair(client)
        copied = _receive(
            client,
            token,
            archive,
            transferId="tx-copy",
            destinationProjectId="copy-id",
            destinationFolder="copy-folder",
            collisionPolicy="copy",
        )
        assert copied.status_code == 201
        assert read_project_metadata(root / "copy-folder").id == "copy-id"

        escaped = _receive(
            client,
            token,
            archive,
            transferId="tx-escape",
            destinationProjectId="other-id",
            destinationFolder="../outside",
            collisionPolicy="copy",
        )
        assert escaped.status_code == 422
        assert not (root.parent / "outside").exists()


def test_confirmed_replace_backs_up_stopped_project_without_touching_running_set(
    monkeypatch,
    tmp_path: Path,
):
    _, root = _configure_home(monkeypatch, tmp_path)
    destination = root / "destination"
    destination.mkdir()
    write_project_metadata(
        destination, ProjectMetadata(id="destination-id", name="Old")
    )
    (destination / "old.txt").write_text("old", encoding="utf-8")
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="destination-id",
            name="Old",
            path=str(destination),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    manifest.running.append(RunningEntry(id="unrelated-running", port=8123))
    save_manifest(manifest)

    archive = _archive(tmp_path)
    with TestClient(_app()) as client:
        token = _pair(client)
        response = _receive(
            client,
            token,
            archive,
            transferId="tx-replace",
            destinationProjectId="destination-id",
            destinationFolder="destination",
            collisionPolicy="replace",
            confirmReplace="true",
        )
    assert response.status_code == 201
    body = response.json()
    assert (
        Path(body["backupPath"]).joinpath("old.txt").read_text(encoding="utf-8")
        == "old"
    )
    assert read_project_metadata(destination).id == "destination-id"
    assert [entry.id for entry in load_manifest().running] == ["unrelated-running"]


def test_replace_requires_confirmation_and_stopped_destination(
    monkeypatch, tmp_path: Path
):
    _, root = _configure_home(monkeypatch, tmp_path)
    destination = root / "destination"
    destination.mkdir()
    write_project_metadata(
        destination, ProjectMetadata(id="destination-id", name="Old")
    )
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="destination-id",
            name="Old",
            path=str(destination),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    manifest.running.append(RunningEntry(id="destination-id", port=8124))
    save_manifest(manifest)

    with TestClient(_app()) as client:
        token = _pair(client)
        no_confirmation = _receive(
            client,
            token,
            _archive(tmp_path),
            transferId="tx-no-confirm",
            destinationProjectId="destination-id",
            destinationFolder="destination",
            collisionPolicy="replace",
        )
        assert no_confirmation.status_code == 422
        running = _receive(
            client,
            token,
            _archive(tmp_path, project_id="source-id-2"),
            transferId="tx-running",
            sourceProjectId="source-id-2",
            destinationProjectId="destination-id",
            destinationFolder="destination",
            collisionPolicy="replace",
            confirmReplace="true",
        )
        assert running.status_code == 409
    assert (destination / "config.json").is_file()


def test_replace_rolls_back_when_manifest_commit_fails(monkeypatch, tmp_path: Path):
    _, root = _configure_home(monkeypatch, tmp_path)
    destination = root / "destination"
    destination.mkdir()
    write_project_metadata(
        destination, ProjectMetadata(id="destination-id", name="Old")
    )
    (destination / "old.txt").write_text("preserve", encoding="utf-8")
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="destination-id",
            name="Old",
            path=str(destination),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)

    with TestClient(_app(), raise_server_exceptions=False) as client:
        token = _pair(client)
        monkeypatch.setattr(
            manager_peers_api,
            "save_manifest",
            lambda _manifest: (_ for _ in ()).throw(
                OSError("simulated commit failure")
            ),
        )
        response = _receive(
            client,
            token,
            _archive(tmp_path),
            transferId="tx-rollback",
            destinationProjectId="destination-id",
            destinationFolder="destination",
            collisionPolicy="replace",
            confirmReplace="true",
        )
    assert response.status_code == 500
    assert (destination / "old.txt").read_text(encoding="utf-8") == "preserve"
    assert not list(root.glob(".nexthmi-transfer-*"))


def test_start_is_opt_in_and_transfer_id_cannot_escape_staging(
    monkeypatch, tmp_path: Path
):
    _configure_home(monkeypatch, tmp_path)
    starts: list[str] = []
    monkeypatch.setattr(
        manager_peers_api.supervisor,
        "start",
        lambda project_id: starts.append(project_id) or {"status": "running"},
    )
    archive = _archive(tmp_path)
    with TestClient(_app()) as client:
        token = _pair(client)
        not_started = _receive(client, token, archive, transferId="tx-no-start")
        assert not_started.status_code == 201
        assert starts == []

        started = _receive(
            client,
            token,
            archive,
            transferId="tx-start",
            destinationProjectId="started-copy-id",
            destinationFolder="started-copy",
            collisionPolicy="copy",
            start="true",
        )
        assert started.status_code == 201
        assert starts == ["started-copy-id"]

        invalid = _receive(
            client,
            token,
            archive,
            transferId="../../escape",
            destinationProjectId="escape-id",
            destinationFolder="escape-folder",
            collisionPolicy="copy",
        )
        assert invalid.status_code == 422


def test_projects_root_symlink_is_never_followed(monkeypatch, tmp_path: Path):
    _, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "marker.txt").write_text("keep", encoding="utf-8")
    root.rmdir()
    root.symlink_to(outside, target_is_directory=True)
    with TestClient(_app()) as client:
        response = _receive(client, _pair(client), archive, transferId="tx-root-link")
    assert response.status_code == 422
    assert (outside / "marker.txt").read_text(encoding="utf-8") == "keep"


def test_target_appearance_race_is_preserved(monkeypatch, tmp_path: Path):
    _, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    original = manager_peers_api._atomic_rename_noreplace

    def appear(source, destination, binding):
        if destination == root / "source-copy" and not destination.exists():
            destination.mkdir()
            (destination / "marker.txt").write_text("operator", encoding="utf-8")
        return original(source, destination, binding)

    monkeypatch.setattr(manager_peers_api, "_atomic_rename_noreplace", appear)
    with TestClient(_app()) as client:
        response = _receive(client, _pair(client), archive, transferId="tx-appearance")
    assert response.status_code == 409
    assert (root / "source-copy" / "marker.txt").read_text(
        encoding="utf-8"
    ) == "operator"
    assert load_manifest().projects == []


def test_existing_target_symlink_is_preserved(monkeypatch, tmp_path: Path):
    _, root = _configure_home(monkeypatch, tmp_path)
    outside = tmp_path / "outside-target"
    outside.mkdir()
    (outside / "marker.txt").write_text("keep", encoding="utf-8")
    target = root / "source-copy"
    target.symlink_to(outside, target_is_directory=True)
    with TestClient(_app()) as client:
        response = _receive(
            client,
            _pair(client),
            _archive(tmp_path),
            transferId="tx-target-link",
        )
    assert response.status_code == 409
    assert target.is_symlink()
    assert (outside / "marker.txt").read_text(encoding="utf-8") == "keep"


def test_replace_rechecks_actual_starting_process_under_project_lock(
    monkeypatch, tmp_path: Path
):
    _, root = _configure_home(monkeypatch, tmp_path)
    destination = root / "destination"
    destination.mkdir()
    write_project_metadata(
        destination, ProjectMetadata(id="destination-id", name="Old")
    )
    (destination / "old.txt").write_text("keep", encoding="utf-8")
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="destination-id",
            name="Old",
            path=str(destination),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)
    monkeypatch.setattr(
        manager_peers_api.supervisor, "is_fully_stopped", lambda _id: False
    )
    with TestClient(_app()) as client:
        response = _receive(
            client,
            _pair(client),
            _archive(tmp_path),
            transferId="tx-starting-race",
            destinationProjectId="destination-id",
            destinationFolder="destination",
            collisionPolicy="replace",
            confirmReplace="true",
        )
    assert response.status_code == 409
    assert (destination / "old.txt").read_text(encoding="utf-8") == "keep"


def test_cancel_after_backup_rolls_back_before_cancelled_state(
    monkeypatch, tmp_path: Path
):
    home, root = _configure_home(monkeypatch, tmp_path)
    destination = root / "destination"
    destination.mkdir()
    write_project_metadata(
        destination, ProjectMetadata(id="destination-id", name="Old")
    )
    (destination / "old.txt").write_text("keep", encoding="utf-8")
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="destination-id",
            name="Old",
            path=str(destination),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)
    original_update = manager_peers_api._journal_update

    def cancel_after_backup(transfer_id: str, **updates):
        original_update(transfer_id, **updates)
        if updates.get("phase") == "backup_created":
            manager_peers_api._receive_cancellations[transfer_id].set()

    monkeypatch.setattr(manager_peers_api, "_journal_update", cancel_after_backup)
    with TestClient(_app(), raise_server_exceptions=False) as client:
        response = _receive(
            client,
            _pair(client),
            _archive(tmp_path),
            transferId="tx-cancel-backup",
            destinationProjectId="destination-id",
            destinationFolder="destination",
            collisionPolicy="replace",
            confirmReplace="true",
        )
    assert response.status_code >= 400
    assert (destination / "old.txt").read_text(encoding="utf-8") == "keep"
    journal = json.loads((home / ".peer-transfer-receipts.json").read_text())
    assert (
        journal["receipts"]["tx-cancel-backup"]["phase"] == "cancelled_after_rollback"
    )


def test_corrupt_transfer_journal_fails_closed(monkeypatch, tmp_path: Path):
    home, _ = _configure_home(monkeypatch, tmp_path)
    (home / ".peer-transfer-receipts.json").write_text("{corrupt", encoding="utf-8")
    with TestClient(_app()) as client:
        response = _receive(
            client, _pair(client), _archive(tmp_path), transferId="tx-corrupt"
        )
    assert response.status_code == 409


def test_retry_fingerprint_includes_archive_bytes(monkeypatch, tmp_path: Path):
    _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    with TestClient(_app()) as client:
        token = _pair(client)
        assert (
            _receive(client, token, archive, transferId="tx-archive").status_code == 201
        )
        changed = archive + b"changed"
        retry = _receive(client, token, changed, transferId="tx-archive")
    assert retry.status_code == 409


def test_private_peer_resolution_rejects_public_and_mixed_dns(monkeypatch):
    monkeypatch.setattr(
        manager_peers_api.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("8.8.8.8", 8000))],
    )
    with pytest.raises(manager_peers_api.ValidationError):
        manager_peers_api._resolve_private_peer("peer.example", 8000)

    monkeypatch.setattr(
        manager_peers_api.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (2, 1, 6, "", ("192.168.1.5", 8000)),
            (2, 1, 6, "", ("8.8.8.8", 8000)),
        ],
    )
    with pytest.raises(manager_peers_api.ValidationError):
        manager_peers_api._resolve_private_peer("rebind.example", 8000)


def _seed_applied_pending_start(home: Path, root: Path, archive: bytes) -> None:
    target = root / "source-copy"
    target.mkdir()
    write_project_metadata(target, ProjectMetadata(id="source-id", name="Source"))
    target_stat = target.stat()
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="source-id",
            name="Source",
            path=str(target),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)
    request_fingerprint = manager_peers_api._receipt_fingerprint(
        sourceProjectId="source-id",
        destinationProjectId="source-id",
        destinationFolder="source-copy",
        collisionPolicy="reject",
        confirmReplace="False",
        start="True",
    )
    archive_sha = manager_peers_api.hashlib.sha256(archive).hexdigest()
    fingerprint = manager_peers_api.hashlib.sha256(
        f"{request_fingerprint}:{archive_sha}".encode()
    ).hexdigest()
    (home / ".peer-transfer-receipts.json").write_text(
        json.dumps(
            {
                "version": 1,
                "receipts": {
                    "tx-pending-start": {
                        "fingerprint": fingerprint,
                        "archiveSha256": archive_sha,
                        "status": "active",
                        "phase": "committing_manifest",
                        "sourceProjectId": "source-id",
                        "destinationProjectId": "source-id",
                        "destinationFolder": "source-copy",
                        "targetPath": str(target),
                        "installedIdentity": {
                            "device": target_stat.st_dev,
                            "inode": target_stat.st_ino,
                        },
                        "collisionPolicy": "reject",
                        "startRequested": True,
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def test_restart_requires_authenticated_retry_before_pending_start(
    monkeypatch, tmp_path: Path
):
    home, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    _seed_applied_pending_start(home, root, archive)
    starts: list[str] = []
    monkeypatch.setattr(
        manager_peers_api.supervisor,
        "start",
        lambda project_id: starts.append(project_id) or {"status": "running"},
    )
    manager_peers_api.reconcile_transfer_journals()
    assert starts == []
    journal = json.loads((home / ".peer-transfer-receipts.json").read_text())
    assert journal["receipts"]["tx-pending-start"]["status"] == "applied_pending_start"

    with TestClient(_app()) as client:
        token = _pair(client)
        retry = _receive(
            client,
            token,
            archive,
            transferId="tx-pending-start",
            start="true",
        )
    assert retry.status_code == 201
    assert retry.json()["started"] is True
    assert starts == ["source-id"]


def test_password_rotation_blocks_old_token_from_pending_start(
    monkeypatch, tmp_path: Path
):
    home, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    _seed_applied_pending_start(home, root, archive)
    starts: list[str] = []
    monkeypatch.setattr(
        manager_peers_api.supervisor,
        "start",
        lambda project_id: starts.append(project_id) or {"status": "running"},
    )
    with TestClient(_app()) as client:
        old_token = _pair(client)
        manager_peers_api.reconcile_transfer_journals()
        manager_auth.set_password("rotated-admin")
        peer_tokens.revoke_all()
        blocked = _receive(
            client,
            old_token,
            archive,
            transferId="tx-pending-start",
            start="true",
        )
    assert blocked.status_code == 401
    assert starts == []


def _write_interrupted_receipt(home: Path, transfer_id: str, **values) -> None:
    (home / ".peer-transfer-receipts.json").write_text(
        json.dumps(
            {
                "version": 1,
                "receipts": {
                    transfer_id: {
                        "fingerprint": "test-fingerprint",
                        "status": "active",
                        "sourceProjectId": "source-id",
                        "destinationProjectId": "source-id",
                        "destinationFolder": "source-copy",
                        "collisionPolicy": "reject",
                        "startRequested": False,
                        **values,
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def test_restart_restores_proven_backup_from_backing_up_phase(
    monkeypatch, tmp_path: Path
):
    home, root = _configure_home(monkeypatch, tmp_path)
    target = root / "source-copy"
    backup = root / "source-copy.bak-tx-backup-recovery"
    backup.mkdir()
    (backup / "operator.txt").write_text("preserve", encoding="utf-8")
    backup_stat = backup.stat()
    _write_interrupted_receipt(
        home,
        "tx-backup-recovery",
        phase="backing_up",
        targetPath=str(target),
        backupPath=str(backup),
        backupIdentity={"device": backup_stat.st_dev, "inode": backup_stat.st_ino},
    )

    manager_peers_api.reconcile_transfer_journals()

    assert (target / "operator.txt").read_text(encoding="utf-8") == "preserve"
    assert not backup.exists()
    journal = json.loads((home / ".peer-transfer-receipts.json").read_text())
    assert (
        journal["receipts"]["tx-backup-recovery"]["phase"]
        == "rolled_back_after_restart"
    )


def test_restart_quarantines_proven_install_from_installing_phase(
    monkeypatch, tmp_path: Path
):
    home, root = _configure_home(monkeypatch, tmp_path)
    target = root / "source-copy"
    target.mkdir()
    (target / "new.txt").write_text("new", encoding="utf-8")
    target_stat = target.stat()
    _write_interrupted_receipt(
        home,
        "tx-install-recovery",
        phase="installing",
        targetPath=str(target),
        installedIdentity={"device": target_stat.st_dev, "inode": target_stat.st_ino},
    )

    manager_peers_api.reconcile_transfer_journals()

    quarantine = root / ".nexthmi-recovery-tx-install-recovery"
    assert not target.exists()
    assert (quarantine / "new.txt").read_text(encoding="utf-8") == "new"
    journal = json.loads((home / ".peer-transfer-receipts.json").read_text())
    assert (
        journal["receipts"]["tx-install-recovery"]["phase"]
        == "rolled_back_after_restart"
    )


def test_restart_identity_mismatch_never_moves_mutable_target(
    monkeypatch, tmp_path: Path
):
    home, root = _configure_home(monkeypatch, tmp_path)
    target = root / "source-copy"
    target.mkdir()
    (target / "operator.txt").write_text("preserve", encoding="utf-8")
    _write_interrupted_receipt(
        home,
        "tx-identity-mismatch",
        phase="installing",
        targetPath=str(target),
        installedIdentity={"device": 0, "inode": 0},
    )

    manager_peers_api.reconcile_transfer_journals()

    assert (target / "operator.txt").read_text(encoding="utf-8") == "preserve"
    assert not (root / ".nexthmi-recovery-tx-identity-mismatch").exists()
    journal = json.loads((home / ".peer-transfer-receipts.json").read_text())
    assert journal["receipts"]["tx-identity-mismatch"]["status"] == "recovery_required"


def test_concurrent_same_transfer_id_has_one_atomic_claim(monkeypatch, tmp_path: Path):
    _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    barrier = threading.Barrier(2)
    original_fingerprint = manager_peers_api._archive_fingerprint

    def synchronized_fingerprint(file):
        result = original_fingerprint(file)
        barrier.wait(timeout=5)
        return result

    monkeypatch.setattr(
        manager_peers_api, "_archive_fingerprint", synchronized_fingerprint
    )
    with TestClient(_app()) as client:
        token = _pair(client)
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(
                executor.map(
                    lambda _: _receive(
                        client, token, archive, transferId="tx-concurrent-claim"
                    ),
                    range(2),
                )
            )

    assert sorted(response.status_code for response in responses) == [201, 409]


def test_concurrent_ids_for_same_target_have_one_winner(monkeypatch, tmp_path: Path):
    _, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    barrier = threading.Barrier(2)
    original_fingerprint = manager_peers_api._archive_fingerprint

    def synchronized_fingerprint(file):
        result = original_fingerprint(file)
        barrier.wait(timeout=5)
        return result

    monkeypatch.setattr(
        manager_peers_api, "_archive_fingerprint", synchronized_fingerprint
    )
    with TestClient(_app()) as client:
        token = _pair(client)
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(
                executor.map(
                    lambda transfer_id: _receive(
                        client, token, archive, transferId=transfer_id
                    ),
                    ("tx-concurrent-a", "tx-concurrent-b"),
                )
            )

    assert sorted(response.status_code for response in responses) == [201, 409]
    assert (root / "source-copy" / "pages.json").is_file()
    assert len(load_manifest().projects) == 1


def test_token_revocation_before_manifest_commit_rolls_back(
    monkeypatch, tmp_path: Path
):
    _, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    original_update = manager_peers_api._journal_update

    def revoke_after_install(transfer_id: str, **updates):
        original_update(transfer_id, **updates)
        if updates.get("phase") == "installed":
            peer_tokens.revoke_all()

    monkeypatch.setattr(manager_peers_api, "_journal_update", revoke_after_install)
    with TestClient(_app()) as client:
        response = _receive(
            client, _pair(client), archive, transferId="tx-revoke-before-commit"
        )

    assert response.status_code == 401
    assert not (root / "source-copy").exists()
    assert load_manifest().projects == []


def test_backup_path_appearance_race_is_preserved(monkeypatch, tmp_path: Path):
    _, root = _configure_home(monkeypatch, tmp_path)
    destination = root / "destination"
    destination.mkdir()
    write_project_metadata(
        destination, ProjectMetadata(id="destination-id", name="Old")
    )
    (destination / "old.txt").write_text("keep", encoding="utf-8")
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="destination-id",
            name="Old",
            path=str(destination),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)
    original_update = manager_peers_api._journal_update
    backup = root / "destination.bak-tx-backup-race"

    def create_backup_race(transfer_id: str, **updates):
        original_update(transfer_id, **updates)
        if updates.get("phase") == "backing_up":
            backup.mkdir()
            (backup / "operator.txt").write_text("preserve", encoding="utf-8")

    monkeypatch.setattr(manager_peers_api, "_journal_update", create_backup_race)
    with TestClient(_app()) as client:
        response = _receive(
            client,
            _pair(client),
            _archive(tmp_path),
            transferId="tx-backup-race",
            destinationProjectId="destination-id",
            destinationFolder="destination",
            collisionPolicy="replace",
            confirmReplace="true",
        )

    assert response.status_code == 409
    assert (destination / "old.txt").read_text(encoding="utf-8") == "keep"
    assert (backup / "operator.txt").read_text(encoding="utf-8") == "preserve"


def test_replace_never_probes_supervisor_under_the_manifest_lock(
    monkeypatch, tmp_path: Path
):
    # The supervisor takes its own lock and then loads the manifest. Asking it
    # anything while the manifest transaction is open inverts that order, and a
    # concurrent start (including an automatic crash restart) deadlocks the
    # whole manager, not just this transfer.
    _home, root = _configure_home(monkeypatch, tmp_path)
    destination = root / "destination"
    destination.mkdir()
    write_project_metadata(
        destination, ProjectMetadata(id="destination-id", name="Old")
    )
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="destination-id",
            name="Old",
            path=str(destination),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)

    manifest_reachable: list[bool] = []
    original_stopped = manager_peers_api.supervisor.is_fully_stopped

    def probing_is_fully_stopped(project_id: str) -> bool:
        # Another thread must be able to read the manifest at this moment; if it
        # cannot, we are holding the manifest lock and a real concurrent start
        # would deadlock here. The probe is never joined — under the bug it
        # stays blocked until the transaction we are inside finally commits.
        pool = ThreadPoolExecutor(max_workers=1)
        try:
            probe = pool.submit(load_manifest)
            try:
                probe.result(timeout=5)
                manifest_reachable.append(True)
            except FuturesTimeoutError:
                manifest_reachable.append(False)
        finally:
            pool.shutdown(wait=False)
        return original_stopped(project_id)

    monkeypatch.setattr(
        manager_peers_api.supervisor, "is_fully_stopped", probing_is_fully_stopped
    )
    with TestClient(_app()) as client:
        response = _receive(
            client,
            _pair(client),
            _archive(tmp_path),
            transferId="tx-lock-order",
            destinationProjectId="destination-id",
            destinationFolder="destination",
            collisionPolicy="replace",
            confirmReplace="true",
        )

    assert response.status_code == 201, response.text
    assert manifest_reachable == [True]


def test_reconcile_survives_a_missing_staging_container(monkeypatch, tmp_path: Path):
    # An operator clearing leftovers after a crash must not stop the manager
    # from booting. These phases never moved the destination, so the transfer
    # stays retryable rather than being locked into recovery_required.
    home, root = _configure_home(monkeypatch, tmp_path)
    journal = {
        "version": 1,
        "receipts": {
            "tx-gone": {
                "fingerprint": "f",
                "status": "active",
                "phase": "extracting",
                "sourceProjectId": "source-id",
                "destinationProjectId": "source-id",
                "destinationFolder": "source-copy",
                "targetPath": str(root / "source-copy"),
                "containerPath": str(root / ".nexthmi-transfer-tx-gone-abc"),
                "containerIdentity": {"device": 1, "inode": 2},
            }
        },
    }
    (home / ".peer-transfer-receipts.json").write_text(json.dumps(journal))

    manager_peers_api.reconcile_transfer_journals()

    entry = json.loads((home / ".peer-transfer-receipts.json").read_text())["receipts"][
        "tx-gone"
    ]
    assert entry["status"] == "error"
    assert entry["phase"] == "interrupted_retryable"


def test_cancel_after_manifest_commit_is_not_reported_as_cancelled(
    monkeypatch, tmp_path: Path
):
    # Once the install is the destination project, calling the transfer
    # "cancelled" strands it: the retry hits the collision preflight forever.
    home, root = _configure_home(monkeypatch, tmp_path)

    def cancel_during_start(project_id: str):
        raise asyncio.CancelledError("deadline during start")

    archive = _archive(tmp_path)
    monkeypatch.setattr(manager_peers_api.supervisor, "start", cancel_during_start)
    with TestClient(_app(), raise_server_exceptions=False) as client:
        token = _pair(client)
        _receive(
            client,
            token,
            archive,
            transferId="tx-cancel-commit",
            start="true",
        )
        entry = json.loads((home / ".peer-transfer-receipts.json").read_text())[
            "receipts"
        ]["tx-cancel-commit"]
        assert entry["status"] != "cancelled"
        assert (root / "source-copy").is_dir()

        monkeypatch.setattr(
            manager_peers_api.supervisor,
            "start",
            lambda project_id: {"status": "running"},
        )
        retry = _receive(
            client, token, archive, transferId="tx-cancel-commit", start="true"
        )
        assert retry.status_code == 201, retry.text
        assert retry.json()["started"] is True


def test_recovery_required_is_never_downgraded_by_a_later_update(
    monkeypatch, tmp_path: Path
):
    home, _ = _configure_home(monkeypatch, tmp_path)
    manager_peers_api._journal_update("tx-stuck", status="active", phase="installing")
    manager_peers_api._journal_update(
        "tx-stuck", status="recovery_required", phase="recovery_required"
    )
    manager_peers_api._journal_update("tx-stuck", status="error", phase="error")

    entry = json.loads((home / ".peer-transfer-receipts.json").read_text())["receipts"][
        "tx-stuck"
    ]
    assert entry["status"] == "recovery_required"


# ── Windows commit path ──────────────────────────────────────────────────────
#
# These drive the non-posix branches on a posix host by flipping the platform
# predicate. They prove the branch logic, not the Windows syscalls underneath:
# `os.rename` no-replace semantics and `CreateFileW` binding still need a smoke
# test on a real Windows build before release.


def test_windows_staging_removal_clears_the_container_by_path(
    monkeypatch, tmp_path: Path
):
    monkeypatch.setattr(
        manager_peers_api, "_handle_bound_removal_supported", lambda: False
    )
    container = tmp_path / "container"
    (container / "payload" / "nested").mkdir(parents=True)
    (container / "payload" / "nested" / "file.txt").write_text("x", encoding="utf-8")
    binding = manager_peers_api._bind_staging_directory(container)
    try:
        manager_peers_api._clear_bound_directory(container, binding)
    finally:
        binding.close()

    assert not container.exists()


def test_windows_cleanup_owned_container_does_not_require_a_bound_rmdir(
    monkeypatch, tmp_path: Path
):
    # On posix the container is removed through the parent's directory handle.
    # That call is unavailable on Windows; the path-based removal must stand in
    # rather than raising and stranding the transfer as recovery_required.
    monkeypatch.setattr(
        manager_peers_api, "_handle_bound_removal_supported", lambda: False
    )
    root = tmp_path / "Projects"
    root.mkdir()
    container = root / ".nexthmi-transfer-tx-win-abcd"
    (container / "payload").mkdir(parents=True)
    binding = manager_peers_api._bind_staging_directory(container)
    identity = {
        "device": binding.identity.device,
        "inode": binding.identity.inode,
    }
    binding.close()

    manager_peers_api._cleanup_owned_container(
        "tx-win",
        {
            "containerPath": str(container),
            "targetPath": str(root / "destination"),
            "containerIdentity": identity,
        },
    )

    assert not container.exists()


def test_windows_commit_refuses_a_destination_that_appeared(monkeypatch, tmp_path: Path):
    # The check-then-rename fallback is not atomic; what it must still
    # guarantee is that an occupied destination is never overwritten.
    from api import projects_api

    stage = tmp_path / "payload"
    stage.mkdir()
    (stage / "config.json").write_text("{}", encoding="utf-8")
    target = tmp_path / "destination"
    target.mkdir()
    (target / "operator.txt").write_text("preserve", encoding="utf-8")
    binding = manager_peers_api._bind_staging_directory(stage)
    monkeypatch.setattr(projects_api.os, "name", "nt")
    try:
        with pytest.raises(ConflictError):
            manager_peers_api._rename_bound(stage, target, binding)
    finally:
        binding.close()

    assert (target / "operator.txt").read_text(encoding="utf-8") == "preserve"
    assert (stage / "config.json").is_file()


def test_failure_after_commit_is_recorded_as_applied_not_error(
    monkeypatch, tmp_path: Path
):
    # The project is installed and in the manifest; a failure while writing the
    # receipt must not leave a state that neither retry nor restart can settle.
    home, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    calls: list[int] = []
    original_save = manager_peers_api._save_receipt

    def fail_first_receipt(transfer_id: str, fingerprint: str, result: dict):
        calls.append(1)
        if len(calls) == 1:
            raise OSError(28, "No space left on device")
        original_save(transfer_id, fingerprint, result)

    monkeypatch.setattr(manager_peers_api, "_save_receipt", fail_first_receipt)
    with TestClient(_app(), raise_server_exceptions=False) as client:
        token = _pair(client)
        _receive(client, token, archive, transferId="tx-post-commit")
        assert (root / "source-copy").is_dir()
        entry = json.loads((home / ".peer-transfer-receipts.json").read_text())[
            "receipts"
        ]["tx-post-commit"]
        assert entry["status"] != "error"

        monkeypatch.setattr(manager_peers_api, "_save_receipt", original_save)
        retry = _receive(client, token, archive, transferId="tx-post-commit")
        assert retry.status_code == 201, retry.text
        assert retry.json()["destinationProjectId"] == "source-id"


def test_reconcile_keeps_a_proven_commit_when_the_container_is_gone(
    monkeypatch, tmp_path: Path
):
    # An operator clearing .nexthmi-transfer-* leftovers before restart must not
    # turn a committed install into recovery_required.
    home, root = _configure_home(monkeypatch, tmp_path)
    target = root / "destination"
    target.mkdir()
    write_project_metadata(target, ProjectMetadata(id="destination-id", name="Dest"))
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="destination-id",
            name="Dest",
            path=str(target),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)
    installed = target.stat()
    journal = {
        "version": 1,
        "receipts": {
            "tx-proven": {
                "fingerprint": "f",
                "status": "active",
                "phase": "committing_manifest",
                "sourceProjectId": "source-id",
                "destinationProjectId": "destination-id",
                "destinationFolder": "destination",
                "targetPath": str(target),
                "containerPath": str(root / ".nexthmi-transfer-tx-proven-zzz"),
                "containerIdentity": {"device": 1, "inode": 2},
                "installedIdentity": {
                    "device": installed.st_dev,
                    "inode": installed.st_ino,
                },
                "startRequested": False,
            }
        },
    }
    (home / ".peer-transfer-receipts.json").write_text(json.dumps(journal))

    manager_peers_api.reconcile_transfer_journals()

    entry = json.loads((home / ".peer-transfer-receipts.json").read_text())["receipts"][
        "tx-proven"
    ]
    assert entry["status"] == "complete"


@pytest.mark.asyncio
async def test_cancelled_lock_acquire_never_leaks_the_lock():
    # asyncio.to_thread cannot cancel the worker: without the cancel-safe
    # wrapper the thread takes a lock nobody releases, wedging the project.
    lock = threading.Lock()
    lock.acquire()
    waiter = asyncio.ensure_future(manager_peers_api._acquire_lock_cancel_safe(lock))
    await asyncio.sleep(0.05)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    lock.release()
    for _ in range(100):
        if not lock.locked():
            break
        await asyncio.sleep(0.05)
    assert not lock.locked()


def test_transfer_refuses_a_folder_another_project_already_claims(
    monkeypatch, tmp_path: Path
):
    # A folder deleted outside the app leaves a `missing` manifest entry; two
    # entries must never end up pointing at the same path.
    _, root = _configure_home(monkeypatch, tmp_path)
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="stale-id",
            name="Deleted outside the app",
            path=str(root / "source-copy"),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)

    with TestClient(_app()) as client:
        response = _receive(
            client, _pair(client), _archive(tmp_path), transferId="tx-claimed"
        )

    assert response.status_code == 409
    assert "stale-id" in response.json()["detail"]
    assert [entry.id for entry in load_manifest().projects] == ["stale-id"]


def test_progress_persistence_is_time_budgeted_not_per_megabyte(monkeypatch):
    # The durable journal write is a blocking read-modify-write of the whole
    # file; a multi-gigabyte upload must not do one per megabyte.
    writes: list[dict] = []
    monkeypatch.setattr(
        manager_peers_api,
        "_sender_update",
        lambda transfer_id, **updates: writes.append(updates),
    )
    clock = [0.0]
    monkeypatch.setattr(manager_peers_api.time, "monotonic", lambda: clock[0])
    state = manager_peers_api.TransferState(
        transferId="tx-progress",
        fingerprint="f",
        sourceProjectId="source-id",
        destinationProjectId="source-id",
    )
    payload = io.BytesIO(b"x" * (8 * 1024 * 1024))
    progress_file = manager_peers_api._ProgressFile(
        payload, state, threading.Event()
    )
    while progress_file.read(1024 * 1024):
        clock[0] += 0.1

    assert state.bytesDone == 8 * 1024 * 1024
    # 0.8s of upload at a 2s budget: one opening write plus the final flush.
    assert len(writes) <= 2


def test_progress_file_flushes_immediately_for_a_zero_byte_upload(monkeypatch):
    # An empty file's first read is already the terminal empty chunk — the
    # "final emission always happens" rule must fire even though nothing was
    # ever transferred and the total is 0.
    writes: list[dict] = []
    monkeypatch.setattr(
        manager_peers_api,
        "_sender_update",
        lambda transfer_id, **updates: writes.append(updates),
    )
    state = manager_peers_api.TransferState(
        transferId="tx-empty",
        fingerprint="f",
        sourceProjectId="source-id",
        destinationProjectId="source-id",
        bytesTotal=0,
    )
    progress_file = manager_peers_api._ProgressFile(
        io.BytesIO(b""), state, threading.Event()
    )

    chunk = progress_file.read(1024)

    assert chunk == b""
    assert state.bytesDone == 0
    assert writes == [{"phase": "uploading", "bytesDone": 0, "bytesTotal": 0}]


def test_progress_file_persists_once_the_time_budget_elapses_mid_stream(monkeypatch):
    writes: list[dict] = []
    monkeypatch.setattr(
        manager_peers_api,
        "_sender_update",
        lambda transfer_id, **updates: writes.append(dict(updates)),
    )
    clock = [0.0]
    monkeypatch.setattr(manager_peers_api.time, "monotonic", lambda: clock[0])
    state = manager_peers_api.TransferState(
        transferId="tx-budget",
        fingerprint="f",
        sourceProjectId="source-id",
        destinationProjectId="source-id",
        bytesTotal=4 * 1024 * 1024,
    )
    progress_file = manager_peers_api._ProgressFile(
        io.BytesIO(b"x" * (4 * 1024 * 1024)), state, threading.Event()
    )

    progress_file.read(1024 * 1024)  # still inside the 2s budget
    assert writes == []

    clock[0] += 2.5  # cross the persistence budget
    progress_file.read(1024 * 1024)

    assert len(writes) == 1
    assert writes[0]["bytesDone"] == 2 * 1024 * 1024


def test_progress_file_seek_to_zero_resets_the_persistence_budget(monkeypatch):
    # A retried upload rewinds the source file. If the budget kept the
    # previous attempt's `_last_persisted_at`, a read shortly after the rewind
    # would wrongly inherit however much of the 2s budget was already spent
    # and delay reporting the retry's progress.
    writes: list[dict] = []
    monkeypatch.setattr(
        manager_peers_api,
        "_sender_update",
        lambda transfer_id, **updates: writes.append(dict(updates)),
    )
    clock = [0.0]
    monkeypatch.setattr(manager_peers_api.time, "monotonic", lambda: clock[0])
    state = manager_peers_api.TransferState(
        transferId="tx-retry",
        fingerprint="f",
        sourceProjectId="source-id",
        destinationProjectId="source-id",
        bytesTotal=2 * 1024 * 1024,
    )
    source = io.BytesIO(b"x" * (2 * 1024 * 1024))
    progress_file = manager_peers_api._ProgressFile(source, state, threading.Event())

    clock[0] = 2.5  # crosses the 2s budget -> persists, last_persisted_at = 2.5
    progress_file.read(1024 * 1024)
    assert writes == [
        {"phase": "uploading", "bytesDone": 1024 * 1024, "bytesTotal": 2 * 1024 * 1024}
    ]

    progress_file.seek(0)
    assert state.bytesDone == 0

    # Only 0.6s after the rewind: a budget still anchored at t=2.5 would stay
    # silent (diff 0.6 < 2.0). The reset anchors it at 0, so this now looks
    # like 3.1s since the last (reset) persist and must flush immediately.
    clock[0] = 3.1
    progress_file.read(1024)
    assert writes[-1] == {
        "phase": "uploading",
        "bytesDone": 1024,
        "bytesTotal": 2 * 1024 * 1024,
    }
    assert len(writes) == 2


def test_journal_pruning_never_drops_unsettled_entries(monkeypatch, tmp_path: Path):
    _home, _ = _configure_home(monkeypatch, tmp_path)
    entries = {
        f"tx-old-{index}": {
            "status": "complete",
            "updatedAt": f"2026-01-01T00:00:{index:02d}Z",
        }
        for index in range(60)
    }
    entries["tx-active"] = {"status": "active", "updatedAt": "2026-01-01T00:00:00Z"}
    entries["tx-stuck"] = {
        "status": "recovery_required",
        "updatedAt": "2026-01-01T00:00:00Z",
    }
    monkeypatch.setattr(manager_peers_api, "_JOURNAL_ENTRIES_KEPT", 10)

    manager_peers_api._prune_journal_entries(entries, "tx-keep")

    assert "tx-active" in entries
    assert "tx-stuck" in entries
    assert len(entries) == 10


def test_target_locks_do_not_grow_without_bound(monkeypatch, tmp_path: Path):
    _configure_home(monkeypatch, tmp_path)
    manager_peers_api._target_locks.clear()
    manager_peers_api._target_lock_users.clear()
    monkeypatch.setattr(manager_peers_api, "_TARGET_LOCKS_KEPT", 4)
    with manager_peers_api._target_path_lock(tmp_path / "held") as held:
        # In use but not yet acquired — exactly the window a transfer sits in
        # between taking its reference and acquiring it.
        for index in range(20):
            with manager_peers_api._target_path_lock(tmp_path / f"target-{index}"):
                pass
        assert len(manager_peers_api._target_locks) <= 5
        with manager_peers_api._target_path_lock(tmp_path / "held") as again:
            assert again is held
    manager_peers_api._target_locks.clear()
    manager_peers_api._target_lock_users.clear()


@pytest.mark.asyncio
async def test_deferred_cleanup_waits_for_the_extracting_thread(tmp_path: Path):
    # Clearing the container while the extractor is still writing races it into
    # ENOTEMPTY and leaves the tree behind, so removal waits for the worker.
    container = tmp_path / ".nexthmi-transfer-tx-defer-abc"
    (container / "payload").mkdir(parents=True)
    release = threading.Event()
    thread_done = threading.Event()

    def still_writing() -> None:
        try:
            release.wait(10)
            (container / "payload" / "late.txt").write_text("late", encoding="utf-8")
        finally:
            thread_done.set()

    worker = manager_peers_api._staging_executor.submit(still_writing)
    while not worker.running():
        await asyncio.sleep(0.01)
    # Cancelling a running job fails, and the awaiting coroutine is cancelled
    # anyway — the thread keeps writing, so cleanup must key off the thread.
    worker.cancel()
    manager_peers_api._defer_container_cleanup(
        "tx-defer", container, thread_done, worker
    )
    await asyncio.sleep(0.05)
    assert container.exists()

    release.set()
    for _ in range(100):
        if not container.exists():
            break
        await asyncio.sleep(0.05)
    assert not container.exists()


@pytest.mark.asyncio
async def test_deferred_cleanup_retrieves_a_failed_worker_exception(tmp_path: Path):
    container = tmp_path / ".nexthmi-transfer-tx-boom-abc"
    container.mkdir()
    thread_done = threading.Event()

    def explode() -> None:
        try:
            raise RuntimeError("unpack failed")
        finally:
            thread_done.set()

    worker = manager_peers_api._staging_executor.submit(explode)
    manager_peers_api._defer_container_cleanup(
        "tx-boom", container, thread_done, worker
    )
    for _ in range(100):
        if not container.exists():
            break
        await asyncio.sleep(0.05)

    assert not container.exists()
    assert worker.done() and worker.exception() is not None


@pytest.mark.asyncio
async def test_deferred_cleanup_does_not_wait_for_a_job_that_never_started(
    tmp_path: Path,
):
    # Cancelling before the executor picks the job up means the unpack body
    # never runs, so its completion event can never be set. Waiting on it would
    # block for the whole drain timeout and strand the container.
    container = tmp_path / ".nexthmi-transfer-tx-never-abc"
    container.mkdir()
    thread_done = threading.Event()
    blocker = threading.Event()

    def occupy() -> None:
        blocker.wait(10)

    # Saturate the staging executor so the real job cannot start.
    hogs = [
        manager_peers_api._staging_executor.submit(occupy)
        for _ in range(manager_peers_api._staging_executor._max_workers)
    ]
    try:
        worker = manager_peers_api._staging_executor.submit(thread_done.set)
        await asyncio.sleep(0.05)
        assert worker.cancel()
        manager_peers_api._defer_container_cleanup(
            "tx-never", container, thread_done, worker
        )
        for _ in range(60):
            if not container.exists():
                break
            await asyncio.sleep(0.05)
        assert not container.exists()
        assert not thread_done.is_set()
    finally:
        blocker.set()
        for hog in hogs:
            hog.result(timeout=10)


# ── sender-side endpoints ────────────────────────────────────────────────────
#
# These were entirely untested for three review rounds, which is how a
# `TypeError` in `TransferState.public()` — fatal to every sender endpoint the
# moment a transfer was actually running — survived.


def _sender_app_with_project(monkeypatch, tmp_path: Path) -> tuple[FastAPI, Path]:
    _, root = _configure_home(monkeypatch, tmp_path)
    source = root / "to-send"
    source.mkdir()
    write_project_metadata(source, ProjectMetadata(id="source-id", name="Source"))
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="source-id",
            name="Source",
            path=str(source),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)
    return _app(), source


def _begin_body(**overrides) -> dict:
    return {
        "sourceProjectId": "source-id",
        "destinationProjectId": "source-id",
        "destinationFolder": "landing",
        "peerHost": "10.0.0.5",
        "peerPort": 8000,
        "token": "peer-token",
        **overrides,
    }


def test_sender_endpoints_work_while_a_transfer_is_running(monkeypatch, tmp_path: Path):
    app, _ = _sender_app_with_project(monkeypatch, tmp_path)
    running = threading.Event()

    async def slow_send(state, body, source, source_name) -> None:
        running.set()
        await asyncio.sleep(30)

    monkeypatch.setattr(manager_peers_api, "_send_transfer", slow_send)
    with TestClient(app) as client:
        begun = client.post("/api/manager/transfers", json=_begin_body())
        assert begun.status_code == 202, begun.text
        transfer_id = begun.json()["transferId"]
        # The task holds a live asyncio.Task; serializing it must not blow up.
        assert begun.json()["status"] == "active"
        assert "task" not in begun.json()
        assert "fingerprint" not in begun.json()

        status = client.get(f"/api/manager/transfers/{transfer_id}")
        assert status.status_code == 200, status.text
        assert status.json()["transferId"] == transfer_id

        cancelled = client.delete(f"/api/manager/transfers/{transfer_id}")
        assert cancelled.status_code == 200, cancelled.text


def test_begin_transfer_rejects_a_reused_id_with_different_parameters(
    monkeypatch, tmp_path: Path
):
    app, _ = _sender_app_with_project(monkeypatch, tmp_path)

    async def noop(state, body, source, source_name) -> None:
        await asyncio.sleep(30)

    monkeypatch.setattr(manager_peers_api, "_send_transfer", noop)
    with TestClient(app) as client:
        first = client.post(
            "/api/manager/transfers", json=_begin_body(transferId="tx-fixed")
        )
        assert first.status_code == 202, first.text
        # Same id, different destination folder.
        second = client.post(
            "/api/manager/transfers",
            json=_begin_body(transferId="tx-fixed", destinationFolder="elsewhere"),
        )
        assert second.status_code == 409, second.text


def test_begin_transfer_rejects_an_unknown_source_project(monkeypatch, tmp_path: Path):
    app, _ = _sender_app_with_project(monkeypatch, tmp_path)
    with TestClient(app) as client:
        response = client.post(
            "/api/manager/transfers", json=_begin_body(sourceProjectId="not-here")
        )
    assert response.status_code == 404, response.text


# ── pull direction ───────────────────────────────────────────────────────────
#
# The install itself (staging, collision policy, backup/rollback, manifest
# commit) is `_stage_and_install`, shared verbatim with `receive_transfer` and
# already exercised by the tests above. What's new here is: the authenticated
# archive-download endpoint, `begin_pull`'s own preflight/idempotency, the
# download loop wiring into that shared core, and that crash reconciliation
# covers the pull journal too.


def test_peer_project_archive_requires_auth_and_streams_registered_project(
    monkeypatch, tmp_path: Path
):
    _, root = _configure_home(monkeypatch, tmp_path)
    source = root / "shared"
    source.mkdir()
    write_project_metadata(source, ProjectMetadata(id="shared-id", name="Shared"))
    (source / "pages.json").write_text('{"pages": []}', encoding="utf-8")
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="shared-id",
            name="Shared",
            path=str(source),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)

    with TestClient(_app()) as client:
        token = _pair(client)
        unauthenticated = client.get("/api/manager/peer/projects/shared-id/archive")
        assert unauthenticated.status_code == 401

        missing = client.get(
            "/api/manager/peer/projects/not-registered/archive",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert missing.status_code == 404

        response = client.get(
            "/api/manager/peer/projects/shared-id/archive",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        config = json.loads(archive.read("config.json"))
    assert config["project"]["id"] == "shared-id"


def _pull_body(**overrides) -> dict:
    return {
        "sourceProjectId": "source-id",
        "destinationProjectId": "source-id",
        "destinationFolder": "pulled-copy",
        "peerHost": "10.0.0.5",
        "peerPort": 8000,
        "token": "peer-token",
        **overrides,
    }


def test_begin_pull_rejects_a_reused_id_with_different_parameters(
    monkeypatch, tmp_path: Path
):
    _configure_home(monkeypatch, tmp_path)

    async def noop(state, body, target) -> None:
        await asyncio.sleep(30)

    monkeypatch.setattr(manager_peers_api, "_run_pull", noop)
    with TestClient(_app()) as client:
        first = client.post(
            "/api/manager/pulls", json=_pull_body(transferId="pull-fixed")
        )
        assert first.status_code == 202, first.text
        second = client.post(
            "/api/manager/pulls",
            json=_pull_body(transferId="pull-fixed", destinationFolder="elsewhere"),
        )
        assert second.status_code == 409, second.text


def test_begin_pull_rejects_destination_collision(monkeypatch, tmp_path: Path):
    _, root = _configure_home(monkeypatch, tmp_path)
    destination = root / "pulled-copy"
    destination.mkdir()
    write_project_metadata(
        destination, ProjectMetadata(id="source-id", name="Existing")
    )
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="source-id",
            name="Existing",
            path=str(destination),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)

    with TestClient(_app()) as client:
        response = client.post("/api/manager/pulls", json=_pull_body())
    assert response.status_code == 409, response.text


class _FakeStreamResponse:
    def __init__(
        self, body: bytes, status_code: int = 200, *, known_length: bool = True
    ) -> None:
        self.status_code = status_code
        self.headers = {"content-length": str(len(body))} if known_length else {}
        self._body = body

    async def aiter_bytes(self, chunk_size: int = 65536):
        for offset in range(0, len(self._body), chunk_size):
            yield self._body[offset : offset + chunk_size]

    async def aread(self) -> bytes:
        return self._body


class _FakeStreamContext:
    def __init__(self, response: _FakeStreamResponse) -> None:
        self._response = response

    async def __aenter__(self) -> _FakeStreamResponse:
        return self._response

    async def __aexit__(self, *exc: object) -> bool:
        return False


class _FakePeerClient:
    """Stands in for httpx.AsyncClient inside `_run_pull`.

    Serves canned archive bytes instead of a real socket, so the download loop
    and its wiring into `_stage_and_install` are exercised for real without a
    live second manager — matching how the rest of this file tests each side
    of a transfer in isolation rather than over a real network.
    """

    def __init__(
        self, body: bytes, status_code: int = 200, *, known_length: bool = True
    ) -> None:
        self._body = body
        self._status_code = status_code
        self._known_length = known_length

    async def __aenter__(self) -> _FakePeerClient:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    def stream(self, method: str, url: str, headers=None):
        return _FakeStreamContext(
            _FakeStreamResponse(
                self._body, self._status_code, known_length=self._known_length
            )
        )


def _patch_peer_download(
    monkeypatch, archive_bytes: bytes, status_code: int = 200, *, known_length: bool = True
) -> None:
    monkeypatch.setattr(
        manager_peers_api,
        "_resolve_private_peer",
        lambda host, port, scheme="http": manager_peers_api.PeerEndpoint(
            "http://peer.invalid", {"Host": f"{host}:{port}"}, True, host, port, "127.0.0.1"
        ),
    )
    fake_httpx = SimpleNamespace(**vars(httpx))
    fake_httpx.AsyncClient = lambda *a, **k: _FakePeerClient(
        archive_bytes, status_code, known_length=known_length
    )
    monkeypatch.setattr(manager_peers_api, "httpx", fake_httpx)


def _wait_for_pull(client: TestClient, transfer_id: str, *, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    status: dict = {}
    while time.monotonic() < deadline:
        status = client.get(f"/api/manager/pulls/{transfer_id}").json()
        if status.get("status") != "active":
            return status
        time.sleep(0.02)
    raise AssertionError(f"pull {transfer_id} did not settle in time: {status}")


def test_pull_happy_path_installs_via_shared_stage_and_install(
    monkeypatch, tmp_path: Path
):
    _, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    _patch_peer_download(monkeypatch, archive)

    with TestClient(_app()) as client:
        begun = client.post(
            "/api/manager/pulls", json=_pull_body(transferId="pull-happy")
        )
        assert begun.status_code == 202, begun.text
        status = _wait_for_pull(client, "pull-happy")
    assert status["status"] == "complete", status
    assert (root / "pulled-copy" / "pages.json").is_file()
    assert load_manifest().projects[0].id == "source-id"


def test_pull_transport_failure_keeps_the_transports_own_message(
    monkeypatch, tmp_path: Path
):
    """The peer was reached, so the operator must not be told it was unreachable."""
    _configure_home(monkeypatch, tmp_path)
    _patch_peer_download(monkeypatch, _archive(tmp_path))

    def reset_mid_stream(*_args, **_kwargs):
        raise httpx.RemoteProtocolError("peer closed connection without sending a complete body")

    monkeypatch.setattr(_FakePeerClient, "stream", reset_mid_stream)

    with TestClient(_app()) as client:
        client.post("/api/manager/pulls", json=_pull_body(transferId="pull-reset"))
        status = _wait_for_pull(client, "pull-reset")

    assert status["status"] == "error", status
    assert status["message"] == "peer closed connection without sending a complete body"


def test_pull_with_unknown_content_length_preserves_downloaded_bytes(
    monkeypatch, tmp_path: Path
):
    # Regression: when the peer omits Content-Length, `bytesTotal` stays 0 for
    # the whole download. The extracting/complete phase transitions used to
    # force `bytesDone = bytesTotal`, snapping the reported progress back to 0
    # even though the archive had fully downloaded.
    _, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    _patch_peer_download(monkeypatch, archive, known_length=False)

    with TestClient(_app()) as client:
        begun = client.post(
            "/api/manager/pulls", json=_pull_body(transferId="pull-unknown-length")
        )
        assert begun.status_code == 202, begun.text
        status = _wait_for_pull(client, "pull-unknown-length")
    assert status["status"] == "complete", status
    assert status["bytesTotal"] == 0
    assert status["bytesDone"] == len(archive)
    assert (root / "pulled-copy" / "pages.json").is_file()


def test_pull_cancel_during_download_leaves_no_target(monkeypatch, tmp_path: Path):
    _, root = _configure_home(monkeypatch, tmp_path)
    archive = _archive(tmp_path)
    _patch_peer_download(monkeypatch, archive)

    original_update = manager_peers_api._pull_journal_update

    def cancel_when_downloading(transfer_id: str, **updates):
        original_update(transfer_id, **updates)
        if updates.get("phase") == "downloading" and updates.get("status") == "active":
            manager_peers_api._pull_cancellations[transfer_id].set()

    monkeypatch.setattr(
        manager_peers_api, "_pull_journal_update", cancel_when_downloading
    )

    with TestClient(_app()) as client:
        begun = client.post(
            "/api/manager/pulls", json=_pull_body(transferId="pull-cancel")
        )
        assert begun.status_code == 202, begun.text
        status = _wait_for_pull(client, "pull-cancel")
    assert status["status"] == "cancelled", status
    assert not (root / "pulled-copy").exists()
    journal = json.loads(
        (runtime_home.runtime_home_path() / ".peer-transfer-pull.json").read_text()
    )
    assert journal["pulls"]["pull-cancel"]["phase"] == "cancelled"


def _write_interrupted_pull(home: Path, transfer_id: str, **values) -> None:
    (home / ".peer-transfer-pull.json").write_text(
        json.dumps(
            {
                "version": 1,
                "pulls": {
                    transfer_id: {
                        "fingerprint": "test-fingerprint",
                        "status": "active",
                        "sourceProjectId": "source-id",
                        "destinationProjectId": "source-id",
                        "destinationFolder": "pulled-copy",
                        "collisionPolicy": "reject",
                        "startRequested": False,
                        **values,
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def test_restart_quarantines_proven_pull_install_from_installing_phase(
    monkeypatch, tmp_path: Path
):
    home, root = _configure_home(monkeypatch, tmp_path)
    target = root / "pulled-copy"
    target.mkdir()
    (target / "new.txt").write_text("new", encoding="utf-8")
    target_stat = target.stat()
    _write_interrupted_pull(
        home,
        "pull-install-recovery",
        phase="installing",
        targetPath=str(target),
        installedIdentity={"device": target_stat.st_dev, "inode": target_stat.st_ino},
    )

    manager_peers_api.reconcile_transfer_journals()

    quarantine = root / ".nexthmi-recovery-pull-install-recovery"
    assert not target.exists()
    assert (quarantine / "new.txt").read_text(encoding="utf-8") == "new"
    journal = json.loads((home / ".peer-transfer-pull.json").read_text())
    assert (
        journal["pulls"]["pull-install-recovery"]["phase"] == "rolled_back_after_restart"
    )


def _seed_applied_pending_pull(home: Path, root: Path) -> None:
    target = root / "pulled-copy"
    target.mkdir()
    write_project_metadata(target, ProjectMetadata(id="source-id", name="Source"))
    target_stat = target.stat()
    manifest = load_manifest()
    manifest.projects.append(
        ProjectEntry(
            id="source-id",
            name="Source",
            path=str(target),
            addedAt="2026-01-01T00:00:00Z",
        )
    )
    save_manifest(manifest)
    body = manager_peers_api.PullBody(
        **_pull_body(transferId="pull-pending-start", start=True)
    )
    fingerprint = manager_peers_api._pull_fingerprint(body)
    (home / ".peer-transfer-pull.json").write_text(
        json.dumps(
            {
                "version": 1,
                "pulls": {
                    "pull-pending-start": {
                        "fingerprint": fingerprint,
                        "status": "active",
                        "phase": "committing_manifest",
                        "sourceProjectId": "source-id",
                        "destinationProjectId": "source-id",
                        "destinationFolder": "pulled-copy",
                        "targetPath": str(target),
                        "installedIdentity": {
                            "device": target_stat.st_dev,
                            "inode": target_stat.st_ino,
                        },
                        "collisionPolicy": "reject",
                        "startRequested": True,
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def test_restart_requires_retry_before_pull_pending_start(
    monkeypatch, tmp_path: Path
):
    home, root = _configure_home(monkeypatch, tmp_path)
    _seed_applied_pending_pull(home, root)
    starts: list[str] = []
    monkeypatch.setattr(
        manager_peers_api.supervisor,
        "start",
        lambda project_id: starts.append(project_id) or {"status": "running"},
    )
    manager_peers_api.reconcile_transfer_journals()
    assert starts == []
    journal = json.loads((home / ".peer-transfer-pull.json").read_text())
    assert journal["pulls"]["pull-pending-start"]["status"] == "applied_pending_start"

    with TestClient(_app()) as client:
        retry = client.post(
            "/api/manager/pulls",
            json=_pull_body(transferId="pull-pending-start", start=True),
        )
    assert retry.status_code == 202, retry.text
    assert retry.json()["result"]["started"] is True
    assert starts == ["source-id"]


# ── receiver-side cancel endpoint (`DELETE /transfers/{id}`) ────────────────
#
# `test_cancel_after_backup_rolls_back_before_cancelled_state` above drives
# cancellation through a real in-flight receive. These hit the HTTP endpoint
# directly against seeded journal states to cover its own branches: unknown
# id, the admin-owned `recovery_required` conflict, the "too late" phase
# guard, and the live-vs-durable-only cancellation-event split.


def test_cancel_incoming_unknown_transfer_returns_404(monkeypatch, tmp_path: Path):
    _configure_home(monkeypatch, tmp_path)
    with TestClient(_app()) as client:
        token = _pair(client)
        resp = client.delete(
            "/api/manager/peer/transfers/does-not-exist",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 404


def test_cancel_incoming_recovery_required_returns_409(monkeypatch, tmp_path: Path):
    _configure_home(monkeypatch, tmp_path)
    manager_peers_api._journal_update(
        "tx-recovery", status="recovery_required", phase="recovery_required"
    )
    with TestClient(_app()) as client:
        token = _pair(client)
        resp = client.delete(
            "/api/manager/peer/transfers/tx-recovery",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 409


@pytest.mark.parametrize(
    "phase,status",
    [
        ("committing_manifest", "active"),
        ("manifest_committed", "active"),
        ("starting", "active"),
        ("receipt", "active"),
        ("extracting", "complete"),  # any phase once status is already terminal
    ],
)
def test_cancel_incoming_reports_too_late_and_does_not_cancel(
    monkeypatch, tmp_path: Path, phase: str, status: str
):
    _configure_home(monkeypatch, tmp_path)
    manager_peers_api._journal_update("tx-late", status=status, phase=phase)
    cancel = threading.Event()
    manager_peers_api._receive_cancellations["tx-late"] = cancel
    try:
        with TestClient(_app()) as client:
            token = _pair(client)
            resp = client.delete(
                "/api/manager/peer/transfers/tx-late",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 200
        assert resp.json() == {
            "transferId": "tx-late",
            "cancelRequested": False,
            "tooLate": True,
        }
        assert cancel.is_set() is False
    finally:
        manager_peers_api._receive_cancellations.pop("tx-late", None)


def test_cancel_incoming_sets_the_live_event_and_journals_the_request(
    monkeypatch, tmp_path: Path
):
    home, _ = _configure_home(monkeypatch, tmp_path)
    manager_peers_api._journal_update(
        "tx-cancel-live", status="active", phase="extracting"
    )
    cancel = threading.Event()
    manager_peers_api._receive_cancellations["tx-cancel-live"] = cancel
    try:
        with TestClient(_app()) as client:
            token = _pair(client)
            resp = client.delete(
                "/api/manager/peer/transfers/tx-cancel-live",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 200
        assert resp.json() == {"transferId": "tx-cancel-live", "cancelRequested": True}
        assert cancel.is_set() is True
        journal = json.loads((home / ".peer-transfer-receipts.json").read_text())
        assert journal["receipts"]["tx-cancel-live"]["cancelRequested"] is True
    finally:
        manager_peers_api._receive_cancellations.pop("tx-cancel-live", None)


def test_cancel_incoming_without_a_live_event_reports_not_requested(
    monkeypatch, tmp_path: Path
):
    # A manager restart drops in-memory cancellation events but keeps the
    # durable journal — cancelling a cancellable-looking transfer from that
    # state must not crash, and honestly reports it couldn't interrupt it.
    _configure_home(monkeypatch, tmp_path)
    manager_peers_api._journal_update(
        "tx-orphaned", status="active", phase="extracting"
    )
    assert "tx-orphaned" not in manager_peers_api._receive_cancellations
    with TestClient(_app()) as client:
        token = _pair(client)
        resp = client.delete(
            "/api/manager/peer/transfers/tx-orphaned",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"transferId": "tx-orphaned", "cancelRequested": False}
