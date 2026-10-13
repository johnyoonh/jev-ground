#!/usr/bin/env python3
"""Normalize official AVeriTeC / ContractNLI data for jev-ground benchmark JSONL.

No external Python dependencies. This tool does not redistribute source datasets.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import random
import sys
from urllib.request import Request, urlopen

AV_URL = "https://raw.githubusercontent.com/MichSchli/AVeriTeC/main/data/{split}.json"
LABELS_AV = {
    "supported": "supported",
    "refuted": "contradicted",
    "not enough evidence": "insufficient",
}
LABELS_CNLI = {
    "Entailment": "supported",
    "Contradiction": "contradicted",
    "NotMentioned": "insufficient",
}


def download_averitec(split: str, path: Path) -> None:
    url = AV_URL.format(split=split)
    request = Request(url, headers={"User-Agent": "jev-ground-evaluation-importer/0.1"})
    with urlopen(request, timeout=45) as response:
        data = response.read(20_000_001)
    if len(data) > 20_000_000:
        raise ValueError("Downloaded AVeriTeC source exceeds 20 MB")
    if not isinstance(json.loads(data), list):
        raise ValueError("Unexpected AVeriTeC data shape")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def convert_averitec(data: object, split: str):
    if not isinstance(data, list):
        raise ValueError("AVeriTeC source must be a JSON array")
    rows = []
    skipped = Counter()
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            skipped["invalid_row"] += 1
            continue
        original_label = str(item.get("label", "")).strip()
        label = LABELS_AV.get(original_label.lower())
        if label is None:
            if "conflicting" in original_label.lower() or "cherry" in original_label.lower():
                skipped["conflicting_label"] += 1
                continue
            raise ValueError(f"Unexpected AVeriTeC label: {original_label!r}")
        claim = item.get("claim")
        if not isinstance(claim, str) or not claim.strip():
            skipped["empty_claim"] += 1
            continue
        evidence = []
        for qi, question in enumerate(item.get("questions", [])):
            if not isinstance(question, dict):
                continue
            question_text = str(question.get("question", "")).strip()
            for ai, answer in enumerate(question.get("answers", [])):
                if not isinstance(answer, dict):
                    continue
                text = answer.get("answer")
                if isinstance(text, str) and text.strip():
                    evidence.append({
                        "id": f"q{qi}-a{ai}",
                        "text": f"Question: {question_text}\nAnswer: {text.strip()}",
                    })
        if label != "insufficient" and not evidence:
            skipped["no_qa_evidence"] += 1
            continue
        rows.append({
            "id": f"averitec-{split}-{index}",
            "claim": claim.strip(),
            "evidence": evidence,
            "goldVerdict": label,
            "metadata": {
                "dataset": "AVeriTeC", "split": split,
                "originalLabel": original_label,
                "evidenceType": "annotator_question_answers_not_raw_pages",
            },
        })
    return rows, skipped


def convert_contract_nli(data: object, split: str):
    if not isinstance(data, dict) or not isinstance(data.get("documents"), list) or not isinstance(data.get("labels"), dict):
        raise ValueError("ContractNLI source must have 'documents' and 'labels' fields")
    rows = []
    skipped = Counter()
    labels = data["labels"]
    for document in data["documents"]:
        if not isinstance(document, dict):
            skipped["invalid_document"] += 1
            continue
        text = document.get("text")
        if not isinstance(text, str) or not text.strip():
            skipped["empty_document"] += 1
            continue
        ann_sets = document.get("annotation_sets")
        if not isinstance(ann_sets, list) or not ann_sets:
            skipped["no_annotations"] += 1
            continue
        annotations = ann_sets[0].get("annotations", {})
        for hypothesis_key, annotation in annotations.items():
            if not isinstance(annotation, dict):
                continue
            verdict = LABELS_CNLI.get(annotation.get("choice"))
            if verdict is None:
                raise ValueError(f"Unexpected ContractNLI choice: {annotation.get('choice')!r}")
            meta = labels.get(hypothesis_key, {})
            claim = meta.get("hypothesis") if isinstance(meta, dict) else None
            if not isinstance(claim, str) or not claim.strip():
                skipped["unknown_hypothesis"] += 1
                continue
            rows.append({
                "id": f"contractnli-{split}-{document.get('id')}-{hypothesis_key}",
                "claim": claim.strip(),
                "evidence": [{"id": str(document.get("id")), "text": text}],
                "goldVerdict": verdict,
                "metadata": {
                    "dataset": "ContractNLI", "split": split,
                    "documentId": document.get("id"),
                    "hypothesisKey": hypothesis_key,
                    "goldEvidenceSpanIndices": annotation.get("spans", []),
                    "evidenceType": "full_document",
                },
            })
    return rows, skipped


def choose_rows(rows: list[dict], limit: int, seed: int, balanced: bool):
    if limit <= 0:
        raise ValueError("--limit must be positive")
    randomizer = random.Random(seed)
    if not balanced:
        selected = list(rows)
        randomizer.shuffle(selected)
        return selected[:limit]
    groups = {label: [] for label in ("supported", "contradicted", "insufficient")}
    for row in rows:
        groups[row["goldVerdict"]].append(row)
    for group in groups.values():
        randomizer.shuffle(group)
    selected = []
    while len(selected) < limit and any(groups.values()):
        for label in groups:
            if groups[label] and len(selected) < limit:
                selected.append(groups[label].pop())
    randomizer.shuffle(selected)
    return selected


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", choices=["averitec", "contract-nli"])
    parser.add_argument("--input", type=Path, help="Official downloaded JSON source")
    parser.add_argument("--download", action="store_true", help="Download AVeriTeC public dev/train JSON")
    parser.add_argument("--split", default="dev", help="Split name in the source")
    parser.add_argument("--output", type=Path, required=True, help="Normalized benchmark JSONL output")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--balanced", action="store_true", help="Stratified sample; not a representative prevalence estimate")
    parser.add_argument("--max-evidence-chars", type=int, default=0,
                        help="Drop overlong cases, never truncate evidence (0 = unlimited)")
    args = parser.parse_args(argv)
    if args.download and args.dataset != "averitec":
        parser.error("--download is only supported for AVeriTeC; get ContractNLI after accepting its terms")
    if args.download and args.input:
        parser.error("Use either --download or --input, not both")
    if args.download and args.split not in {"train", "dev"}:
        parser.error("Only AVeriTeC train/dev splits are labeled and supported")
    if args.max_evidence_chars < 0:
        parser.error("--max-evidence-chars must be nonnegative")
    source = args.input or Path("data/raw") / args.dataset / f"{args.split}.json"
    if args.download:
        download_averitec(args.split, source)
    if not source.exists():
        parser.error(f"Source not found: {source}. Supply --input, or use --download for AVeriTeC")
    raw = source.read_bytes()
    data = json.loads(raw)
    if args.dataset == "averitec":
        rows, skipped = convert_averitec(data, args.split)
        source_url = AV_URL.format(split=args.split)
        license_id = "CC-BY-NC-4.0"
    else:
        rows, skipped = convert_contract_nli(data, args.split)
        source_url = "https://stanfordnlp.github.io/contract-nli/"
        license_id = "CC-BY-4.0"
    if args.max_evidence_chars:
        filtered = [row for row in rows
                    if sum(len(e["text"]) for e in row["evidence"]) <= args.max_evidence_chars]
        skipped["exceeds_evidence_char_limit"] += len(rows) - len(filtered)
        rows = filtered
    if not rows:
        raise ValueError("No usable records; cannot produce an empty evaluation")
    selected = choose_rows(rows, args.limit, args.seed, args.balanced)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output_bytes = ("\n".join(json.dumps(row, ensure_ascii=False) for row in selected) + "\n").encode("utf-8")
    args.output.write_bytes(output_bytes)
    manifest = {
        "dataset": args.dataset,
        "split": args.split,
        "source": source_url,
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "outputSha256": hashlib.sha256(output_bytes).hexdigest(),
        "createdUtc": datetime.now(timezone.utc).isoformat(),
        "sourceLicense": license_id,
        "output": str(args.output),
        "seed": args.seed,
        "balanced": args.balanced,
        "count": len(selected),
        "labelCounts": dict(Counter(r["goldVerdict"] for r in selected)),
        "skipped": dict(skipped),
    }
    manifest_path = args.output.with_suffix(".manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(selected)} labeled rows to {args.output} ({manifest_path})")
    print("Labels:", manifest["labelCounts"], "; skipped:", dict(skipped))
    print(f"npm run benchmark -- --dataset {args.output} --verifier jev --output results.json")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as exc:
        print(f"Dataset import failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
