"""Bootstrap the system of work: identities, roles, rulebook, settings.

  1. create one SpacetimeDB identity per actor (admin, sync, cap_analyst, policy_learner,
     controller, head_of_cost_cap, gateway, red_team) and save tokens to agents/identities.json;
  2. admin calls bootstrapAdmin (only works while the role table is empty);
  3. for every other actor: admin calls createRoleInvite(role, label, code), the actor calls
     claimRole(code) with its own token (roles are claimed, not assigned);
  4. admin loads every rulebook/rulebook.json entry via loadRulebookEntry;
  5. admin sets materiality_usd_minor, cap_usd_minor, cap_year;
  6. epoch (SCHEMA §10): on a module without `setting db_epoch` admin writes a fresh 16-hex epoch and
     reads it back; identities.json records it on every actor entry. When the module already has an
     epoch and identities.json carries the same one, the role step is a no-op. An identities.json from
     another epoch is refused (the module was bootstrapped with other identities: republish or restore).
  7. dashboard seats: admin keeps SEATS_PER_ROLE unused one-time invite codes for each human role,
     minting new ones as seats are taken, in agents/state/seat_codes.json (mode 600). A person takes a seat in the dashboard by claiming
     one with the browser's own identity, so their approvals are checked by the same roles matrix and
     land in the audit log under that identity. The module stores only the codes' hashes.

Idempotent: existing identities are reused, actors that already hold their role are skipped,
rulebook entries already present are skipped (unless --reload-rulebook), settings are only written
when they differ. Stale agents/state files from an earlier epoch are reported (the agents refuse
them by name; `make stdb-publish` removes the directory).

Usage:
  uv run python -m agents.bootstrap [--reload-rulebook]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import sys
from pathlib import Path

from . import config, epoch, identities
from . import reducers as R
from .stdb import StdbClient


SEATS_PER_ROLE = 3  # one per browser that may take the seat; a claimed code is burnt


class BootstrapError(RuntimeError):
    pass


def load_rulebook(path: Path | None = None) -> list[dict]:
    data = json.loads(Path(path or config.RULEBOOK_PATH).read_text())
    return data.get("entries", []) if isinstance(data, dict) else data


def settings() -> dict[str, str]:
    return {
        "materiality_usd_minor": str(config.MATERIALITY_USD_MINOR),
        "cap_usd_minor": str(config.CAP_USD_MINOR),
        "cap_year": str(config.CAP_YEAR),
    }


def bootstrap(stdb: StdbClient, *, identities_path: Path | None = None, rulebook_path: Path | None = None,
              reload_rulebook: bool = False, seat_codes_path: Path | None = None, log=print) -> dict:
    ids = identities.load(identities_path)
    file_epoch = identities.epoch(ids) if ids else None
    created = []
    for name, role in config.ACTOR_ROLES.items():
        if name not in ids:
            identity, token = stdb.create_identity()
            ids[name] = {"identity": identity, "token": token, "role": role, "db_epoch": file_epoch}
            identities.save(ids, identities_path)
            created.append(name)
    admin = ids["admin"]

    def roles() -> dict[str, str]:
        return {r["identity"]: r["role"] for r in stdb.sql(admin["token"], "SELECT * FROM role")}

    module_epoch = epoch.current_epoch(stdb, admin["token"])
    if module_epoch is not None and file_epoch is not None and module_epoch != file_epoch:
        raise BootstrapError(
            f"{identities_path or config.IDENTITIES_PATH} carries db_epoch {file_epoch} but the module has "
            f"db_epoch {module_epoch}: the database was bootstrapped with another identities.json. Republish "
            f"(`make stdb-publish`) and bootstrap again, or restore the identities.json of this database.")

    current = roles()
    if admin["identity"] not in current:
        if current:
            raise BootstrapError(
                "role table already has rows but not this admin identity: the database was bootstrapped with "
                "another identities.json. Republish with --delete-data or restore the original identities.json.")
        stdb.call(admin["token"], R.BOOTSTRAP_ADMIN, R.bootstrap_admin())
        current = roles()
        if current.get(admin["identity"]) != "admin":
            raise BootstrapError("bootstrapAdmin did not make this identity admin")
        log("admin: bootstrapped")

    if module_epoch is None:
        fresh = epoch.new_epoch()
        stdb.call(admin["token"], R.SET_SETTING, R.set_setting(epoch.SETTING_KEY, fresh))
        module_epoch = epoch.current_epoch(stdb, admin["token"])
        if module_epoch != fresh:
            raise BootstrapError(f"setSetting {epoch.SETTING_KEY} did not take effect (read back {module_epoch!r})")
        log(f"db_epoch: {module_epoch} written")
    if identities.stamp(ids, module_epoch):
        identities.save(ids, identities_path)
    stale = [p for p in (config.SYNC_CURSORS_PATH, config.SYNC_CACHE_PATH, config.GATEWAY_LEDGER_PATH,
                         config.DEAD_LETTER_PATH, config.RULEBOOK_ISSUES_PATH)
             if p.exists() and epoch.read_state_epoch(p) != module_epoch]
    if stale:
        log("warning: state files from another db_epoch (the agents will refuse them; delete or `make stdb-publish`): "
            + ", ".join(str(p) for p in stale))

    claimed = []
    if file_epoch == module_epoch and not created:
        log("roles: unchanged (identities.json carries the module epoch)")
    else:
        for name, role in config.ACTOR_ROLES.items():
            if name == "admin":
                continue
            actor = ids[name]
            have = current.get(actor["identity"])
            if have == role:
                continue
            if have is not None:
                raise BootstrapError(f"{name} already holds role {have!r}, expected {role!r}")
            code = f"{name}-{secrets.token_hex(8)}"
            stdb.call(admin["token"], R.CREATE_ROLE_INVITE, R.create_role_invite(role, config.ACTOR_LABELS[name], code))
            stdb.call(actor["token"], R.CLAIM_ROLE, R.claim_role(code))
            claimed.append(name)
        if claimed:
            current = roles()
            missing = [n for n in claimed if current.get(ids[n]["identity"]) != config.ACTOR_ROLES[n]]
            if missing:
                raise BootstrapError(f"claimRole did not take effect for {missing}")
            log(f"roles claimed: {', '.join(claimed)}")

    entries = load_rulebook(rulebook_path)
    have_entries = {r["id"] for r in stdb.sql(admin["token"], "SELECT * FROM rulebook_entry")}
    loaded = 0
    for e in entries:
        if e["id"] in have_entries and not reload_rulebook:
            continue
        stdb.call(admin["token"], R.LOAD_RULEBOOK_ENTRY, R.load_rulebook_entry(e))
        loaded += 1
    log(f"rulebook: {loaded} loaded, {len(entries) - loaded} already present")

    have_settings = {r["key"]: r["value"] for r in stdb.sql(admin["token"], "SELECT * FROM setting")}
    written = []
    for k, v in settings().items():
        if have_settings.get(k) != v:
            stdb.call(admin["token"], R.SET_SETTING, R.set_setting(k, v))
            written.append(k)
    log(f"settings: {', '.join(written) if written else 'unchanged'}")
    if seat_codes_path is None and identities_path is not None:
        seat_codes_path = Path(identities_path).with_name("seat_codes.json")  # tests: keep it beside them
    seats = mint_seats(stdb, admin["token"], module_epoch, seat_codes_path)
    log(f"dashboard seats: {seats or 'unchanged'} ({seat_codes_path or config.SEAT_CODES_PATH})")
    return {"created": created, "claimed": claimed, "rulebook_loaded": loaded, "settings_written": written,
            "seats_minted": seats}


def mint_seats(stdb: StdbClient, admin_token: str, module_epoch: str | None, path: Path | None = None) -> dict:
    """Keep SEATS_PER_ROLE unused one-time invite codes per dashboard seat: codes from this module's
    epoch that nobody has claimed are kept, the rest are replaced (republishing wipes agents/state/ and
    the invites with it). Returns how many were minted per role."""
    p = Path(path or config.SEAT_CODES_PATH)
    data = json.loads(p.read_text()) if p.exists() else {}
    seats: dict[str, list[dict]] = data.get("seats", {}) if data.get("db_epoch") == module_epoch else {}
    # the module stores each code's SHA-256 (a test double may store it as given)
    invites = {r["code"]: r["used"] for r in stdb.sql(admin_token, "SELECT * FROM role_invite")}

    def unused(code: str) -> bool:
        key = hashlib.sha256(code.encode()).hexdigest()
        return invites.get(key, invites.get(code, True)) is False

    minted: dict[str, int] = {}
    for role, label in config.DASHBOARD_SEATS.items():
        keep = [s for s in seats.get(role, []) if unused(s["code"])]
        while len(keep) < SEATS_PER_ROLE:
            code = f"seat-{role.removeprefix('human_').replace('_', '-')}-{secrets.token_hex(8)}"
            stdb.call(admin_token, R.CREATE_ROLE_INVITE, R.create_role_invite(role, label, code))
            keep.append({"code": code, "label": label})
            minted[role] = minted.get(role, 0) + 1
        seats[role] = keep
    if minted or not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps({"db_epoch": module_epoch, "seats": seats}, indent=2))
        os.chmod(tmp, 0o600)
        tmp.replace(p)
    return minted


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.bootstrap",
                                 description="Create identities, claim roles, load rulebook and settings (idempotent).")
    ap.add_argument("--reload-rulebook", action="store_true", help="call loadRulebookEntry even for existing ids")
    ap.add_argument("--rulebook", type=Path, default=config.RULEBOOK_PATH)
    args = ap.parse_args(argv)
    try:
        res = bootstrap(StdbClient(), rulebook_path=args.rulebook, reload_rulebook=args.reload_rulebook)
    except BootstrapError as e:
        print(f"bootstrap failed: {e}", file=sys.stderr)
        return 1
    print(f"identities created: {res['created'] or 'none'}; written to {config.IDENTITIES_PATH}")
    print(f"db_epoch: {epoch.current_epoch(StdbClient(), identities.get('admin').token)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
