"""Who gets told what, and how to reach them. Contact details come only from the environment."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from ..config import WORLD_DIR


@dataclass
class Person:
    pid: str
    name: str
    title: str
    roles: list[str]
    channels: list[str]
    slack_user: str = ""
    email: str = ""
    phone: str = ""
    extra: dict = field(default_factory=dict)


class Directory:
    def __init__(self, world_dir: Path = WORLD_DIR, env=os.environ):
        data = json.loads((Path(world_dir) / "people.json").read_text())
        self.people = {
            pid: Person(pid, p["name"], p["title"], p["roles"], p["channels"],
                        env.get(p.get("slack_user_env", ""), ""), env.get(p.get("email_env", ""), ""), env.get(p.get("phone_env", ""), ""))
            for pid, p in data["people"].items()
        }
        self.sponsors = {sid: {"contact": s["contact"], "email": env.get(s.get("email_env", ""), "")} for sid, s in data["sponsors"].items()}

    def by_role(self, role: str) -> list[Person]:
        return [p for p in self.people.values() if role in p.roles]

    def by_slack_user(self, slack_user: str) -> Person | None:
        return next((p for p in self.people.values() if slack_user and p.slack_user == slack_user), None)
