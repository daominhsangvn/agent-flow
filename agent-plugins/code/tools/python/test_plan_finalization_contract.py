"""Phase 2.7 (plan finalization) produces the decision table Phase 5.5 reads.

Phase 2.7 generates the decision table that Phase 5.5 (behavior-verifier)
checks the code against. When Phase 2.5 wrote no review (no critics are
configured), the full-loop prompt used to skip straight to Phase 3, so a
`review: full` EXECUTE reached Phase 5.5 without a decision table and
hard-stopped there.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
NO_REVIEWS_RULE_RE = re.compile(r"If zero reviews written[^\n]*")
ACTIVATE_SKILL_RE = re.compile(r"\*\*Activate skill\*\*[^\n]*")


@pytest.mark.parametrize("prompt", ["prompts/prompt.md", "prompts/plan-prompt.md"])
def test_no_critic_reviews_still_finalizes_the_plan(prompt: str) -> None:
    rule = NO_REVIEWS_RULE_RE.search((PLUGIN_ROOT / prompt).read_text())

    assert rule is not None
    assert "skip to Phase 2.7" in rule.group(0)


def test_plan_writer_puts_the_decision_table_where_phase_5_5_reads_it() -> None:
    """The skill defaults to the repository root, which a workspace run lacks;
    plan-writer counts, and Phase 5.5 reads, the work directory's folder."""
    text = (PLUGIN_ROOT / "agents" / "plan-writer.md").read_text()
    activation = ACTIVATE_SKILL_RE.search(text)

    assert activation is not None
    assert "$AGENTFLOW_WORKDIR/.agentflow-ai/decision-tables/" in activation.group(0)
