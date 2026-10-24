"""Router: every event goes to the code tier first; only what code cannot settle goes to the agent."""

from __future__ import annotations

from .engine import Engine, Unhandled


class Router:
    def __init__(self, world, engine: Engine, agent, personas=None, auto_people: bool = True):
        self.world = world
        self.engine = engine
        self.agent = agent
        self.personas = personas
        self.auto_people = auto_people
        self.stats = {"events": 0, "code": 0, "agent": 0}

    def dispatch(self, event: dict, ledger) -> list:
        ledger.clock = event["at"]
        ledger.rules = self.agent.store.approved()
        self.stats["events"] += 1
        results = []
        for item in self.engine.handle(event, ledger):
            if isinstance(item, Unhandled):
                self.stats["agent"] += 1
                results += self.agent.handle(item, event, ledger)
            else:
                self.stats["code"] += 1
                results.append(item)
        results += self.settle(ledger)
        ledger.log_event(event, results)
        return results

    def settle(self, ledger) -> list:
        """Let the people work their queue (auto mode), then re-review anything their answers unblocked."""
        out = []
        if self.auto_people and self.personas:
            for _ in range(3):
                done = self.personas.work(ledger)
                if not done:
                    break
                out += done
        out += self.engine.rereview(ledger)
        return out
