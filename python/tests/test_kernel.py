from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from python.zhibo.orchestrator import ZhiboRuntime


def create_runtime():
    return ZhiboRuntime({"autoSimulate": False, "seed": True})


def is_finite(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def find(rows, predicate):
    return next((row for row in rows if predicate(row)), None)


class KernelTest(unittest.TestCase):
    def test_prepare_cnp_selects_selector_and_publishes_a_complete_plan(self):
        runtime = create_runtime()
        try:
            result = runtime.prepare()
            state = runtime.snapshot()

            self.assertEqual(state["session"]["stage"], "ready")
            self.assertEqual(state["plan"]["version"], "v1.1")
            self.assertGreaterEqual(len(state["plan"]["products"]), 3)
            self.assertGreaterEqual(len(state["plan"]["segments"]), 4)
            self.assertGreaterEqual(len(state["plan"]["scripts"]), 3)
            self.assertGreaterEqual(len(state["plan"]["memoryHits"]), 1)
            self.assertEqual(result["contract"]["winner"], "selector")
            self.assertGreaterEqual(len(result["contract"]["bids"]), 2)
            self.assertTrue(all(is_finite(bid["score"]) for bid in state["cnp"]["bids"]))
            self.assertGreaterEqual(len(state["consensusHistory"]), 0)
            self.assertTrue(any(decision["agent"] == "selector" for decision in state["decisions"]))
            self.assertGreaterEqual(len(state["tools"]), 15)
            self.assertTrue(any(tool.get("requiresApproval") for tool in state["tools"]))
            self.assertTrue(
                all(tool.get("parameters") and tool.get("riskLevel") for tool in state["tools"])
            )
        finally:
            runtime.stopTicker()

    def test_live_scenarios_consensus_veto_and_coupon_approval_stay_consistent(self):
        runtime = create_runtime()
        try:
            runtime.prepare()
            runtime.startLive()
            self.assertEqual(runtime.snapshot()["session"]["stage"], "live")

            negative = runtime.runScenario("negative")
            self.assertEqual(negative["injected"], 3)
            self.assertTrue(negative["incident"])
            self.assertEqual(negative["incident"]["status"], "executed")
            self.assertGreaterEqual(negative["incident"]["count"], 2)
            incident_votes = negative["incident"]["voteSummary"]
            self.assertGreaterEqual(incident_votes["weight"], incident_votes["threshold"])
            consensus = runtime.lastConsensus
            self.assertTrue(consensus)
            self.assertGreaterEqual(
                consensus["weight"],
                consensus["threshold"],
                "negative incident must pass weighted consensus",
            )
            self.assertIs(consensus["vetoed"], False)

            extreme = runtime.runScenario("extreme")
            self.assertEqual(extreme["injected"], 1)
            response = ((extreme.get("result") or {}).get("result") or {}).get("response")
            self.assertTrue(response, "guardrail must return a rewritten response")
            self.assertTrue(response.get("text"), "guardrail must return a rewritten response")
            self.assertGreaterEqual(len(response["guardrail"]["violations"]), 1)
            self.assertGreater(len(response["guardrail"]["rewritten"]), 0)
            self.assertNotIn("价价", response["guardrail"]["rewritten"], "rewrite must not duplicate the price suffix")

            coupon = runtime.runScenario("coupon")
            self.assertIs(coupon["vote"]["approved"], True)
            self.assertGreaterEqual(coupon["vote"]["weight"], coupon["vote"]["threshold"])
            self.assertTrue((coupon.get("coupon") or {}).get("id"), "approved coupon must be issued by the tool layer")
            self.assertEqual(coupon["coupon"]["status"], "active")
            self.assertTrue(coupon["coupon"]["label"], "issued coupon must carry a display label")
            self.assertTrue(coupon["vote"]["approvalId"])

            price = runtime.runScenario("price")
            self.assertEqual(price["veto"]["code"], "PRICE_FLOOR")
            self.assertEqual(price["decision"]["status"], "vetoed")
            self.assertTrue(price["decision"]["consensus"]["vetoed"])

            surge = runtime.runScenario("surge")
            self.assertEqual(surge["snapshot"]["events"], 80)
            self.assertTrue(is_finite(surge["snapshot"]["p99"]))

            state = runtime.snapshot()
            self.assertGreaterEqual(len(state["consensusHistory"]), 2)
            self.assertTrue(any(item["status"] == "open" for item in state["humanQueue"]))
            self.assertGreater(state["metrics"]["gmv"], 0)
            self.assertGreater(state["metrics"]["viewers"], 0)
        finally:
            runtime.stopTicker()

    def test_review_reports_causal_att_and_stores_reflexion_lessons(self):
        runtime = create_runtime()
        try:
            runtime.prepare()
            runtime.startLive()
            runtime.runScenario("negative")
            runtime.runScenario("coupon")
            runtime.stopLive()
            self.assertEqual(runtime.snapshot()["session"]["stage"], "ended")

            result = runtime.review()
            causal = result["report"]["causal"]
            state = runtime.snapshot()

            self.assertEqual(state["session"]["stage"], "reviewed")
            self.assertTrue(is_finite(causal["att"]))
            treatment = find(causal["dag"]["nodes"], lambda node: node["type"] == "treatment")
            self.assertTrue(treatment, "review DAG must include a treatment node")
            self.assertNotRegex(
                treatment["label"], "undefined", "treatment label must be fully resolved"
            )
            self.assertTrue(is_finite(causal["pValue"]))
            self.assertGreaterEqual(causal["pValue"], 0)
            self.assertLessEqual(causal["pValue"], 1)
            self.assertEqual(len(causal["ci95"]), 2)
            self.assertLessEqual(causal["ci95"][0], causal["ci95"][1])
            self.assertGreaterEqual(len(result["report"]["lessons"]), 1)
            self.assertGreaterEqual(len(result["report"]["memoryHits"]), 1)
            self.assertIs(state["reviewIsHistorical"], False)
            self.assertEqual(state["review"]["id"], result["report"]["id"])
        finally:
            runtime.stopTicker()

    def test_resilience_hotplug_replica_failover_and_measured_stream_stress(self):
        runtime = create_runtime()
        try:
            runtime.prepare()

            spec = runtime.hotplugTool({
                "name": "test.margin",
                "category": "测试",
                "handlerType": "margin_calc",
                "riskLevel": "low",
                "description": "测试用毛利测算工具",
            })
            self.assertEqual(spec["name"], "test.margin")
            self.assertEqual(spec["source"], "hotplug")
            self.assertTrue(any(tool["name"] == "test.margin" for tool in runtime.snapshot()["tools"]))

            called = runtime.registry.call("test.margin", {"cost": 80, "price": 199})
            self.assertTrue(is_finite(called["result"]["grossMargin"]))

            failover = runtime.setAgentFault("controller", "offline")
            self.assertEqual(failover["replica"], "controller-b")
            self.assertIn("controller-b", failover["active"])
            self.assertEqual(
                find(runtime.snapshot()["agents"], lambda agent: agent["id"] == "controller-b")["status"],
                "active",
            )
            runtime.setAgentFault("controller", "restore")
            self.assertEqual(
                find(runtime.snapshot()["agents"], lambda agent: agent["id"] == "controller-b")["status"],
                "standby",
            )

            runtime.removeTool("test.margin")
            self.assertFalse(any(tool["name"] == "test.margin" for tool in runtime.snapshot()["tools"]))

            stress = runtime.stressTest(600)
            self.assertEqual(stress["events"], 600)
            self.assertGreater(stress["throughput"], 0)
            self.assertLessEqual(
                stress["p99"],
                stress["targetP99"],
                f"p99 {stress['p99']}ms should stay under {stress['targetP99']}ms",
            )
            self.assertEqual(runtime.snapshot()["loadTest"]["events"], 600)
        finally:
            runtime.stopTicker()

    def test_full_acceptance_harness_reaches_a_passing_score(self):
        runtime = create_runtime()
        try:
            report = runtime.runAcceptance()
            self.assertGreaterEqual(
                report["score"], 90, f"score {report['score']} should be at least 90"
            )
            self.assertEqual(report["summary"]["fail"], 0)
            self.assertEqual(len(report["probes"]), 20)
        finally:
            runtime.stopTicker()


if __name__ == "__main__":
    unittest.main()
