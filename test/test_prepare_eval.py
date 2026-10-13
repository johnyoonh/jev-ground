import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "prepare_eval", Path(__file__).resolve().parents[1] / "scripts" / "prepare_eval.py"
)
assert SPEC is not None and SPEC.loader is not None
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class PrepareEvalTests(unittest.TestCase):
    def test_averitec_3way_and_skip_conflicting(self):
        cases = [
            {"claim": "A", "label": "Supported", "questions": [
                {"question": "Q", "answers": [{"answer": "yes"}]}
            ]},
            {"claim": "B", "label": "Refuted", "questions": [
                {"question": "Q", "answers": [{"answer": "no"}]}
            ]},
            {"claim": "C", "label": "Not Enough Evidence", "questions": []},
            {"claim": "D", "label": "Conflicting Evidence/Cherry-picking", "questions": []},
        ]
        rows, skipped = module.convert_averitec(cases, "dev")
        self.assertEqual([x["goldVerdict"] for x in rows],
                         ["supported", "contradicted", "insufficient"])
        self.assertEqual(skipped["conflicting_label"], 1)
        self.assertEqual(rows[0]["evidence"][0]["text"], "Question: Q\nAnswer: yes")

    def test_contract_nli_full_premise_not_gold_only(self):
        source = {"labels": {"nda-1": {"hypothesis": "H"}}, "documents": [{
            "id": 10, "text": "Entire contract text", "annotation_sets": [{
                "annotations": {"nda-1": {"choice": "Entailment", "spans": [2]}}
            }]
        }]}
        rows, _ = module.convert_contract_nli(source, "dev")
        self.assertEqual(rows[0]["goldVerdict"], "supported")
        self.assertEqual(rows[0]["evidence"][0]["text"], "Entire contract text")
        self.assertEqual(rows[0]["metadata"]["goldEvidenceSpanIndices"], [2])

    def test_balanced_reproducible_sampling(self):
        rows = [{"id": f"{label}-{i}", "goldVerdict": label} for label in
                ("supported", "contradicted", "insufficient") for i in range(10)]
        first = module.choose_rows(rows, 9, 12, True)
        self.assertEqual(first, module.choose_rows(rows, 9, 12, True))
        self.assertEqual({c: sum(x["goldVerdict"] == c for x in first) for c in
                          ("supported", "contradicted", "insufficient")},
                         {"supported": 3, "contradicted": 3, "insufficient": 3})

    def test_cli_writes_manifest_with_checksum(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "input.json"
            dest = Path(d) / "out.jsonl"
            source.write_text(json.dumps([{
                "claim": "X", "label": "Supported",
                "questions": [{"question": "Q", "answers": [{"answer": "Yes"}]}]
            }]), encoding="utf-8")
            module.main([
                "averitec", "--input", str(source), "--output", str(dest), "--limit", "1"
            ])
            self.assertTrue(dest.exists())
            self.assertEqual(json.loads(dest.read_text().strip())["goldVerdict"], "supported")
            self.assertEqual(json.loads(dest.with_suffix(".manifest.json").read_text())["count"], 1)


if __name__ == "__main__":
    unittest.main()
