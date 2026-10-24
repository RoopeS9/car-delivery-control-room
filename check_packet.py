"""Check the 100-order packet: record counts, links and attachment hashes.

It needs nothing but the files in this repository.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else
            os.environ.get("PACKET_ROOT", Path(__file__).resolve().parent)).resolve()
DATA = ROOT / "dataset" / "data"
RECORD_ID = re.compile(
    r"^(?:[a-z]+-x[0-9a-f]{16}|(?:ord|veh|addr|drv|cus|site|doc)-\d{2,6}|"
    r"terminal-[a-z0-9-]+)$"
)
ORDER_REFERENCE = re.compile(r"\bCD-42\d{4}\b")
TARGET_TABLE = {
    "order": "orders", "transport_plan": "transport_plans",
    "market_offer": "market_offers", "work_assignment": "work_assignments",
    "proof": "proofs", "expense": "expenses", "transport_point": "transport_points",
    "alert": "alerts", "order_endpoint_detail": "order_endpoint_details",
    "market_offer_exposure": "market_offer_exposures",
    "travel_reservation": "travel_reservations", "document": "documents",
    "work_item": "work_items", "endpoint_claim": "endpoint_claims",
    "conversation": "conversations", "incident": "incidents",
    "order_item": "order_items", "message": "messages",
    "time_window": "time_windows", "site_visit": "site_visits",
    "travel_confirmation": "travel_confirmations",
    "transport_segment": "transport_segments",
}
ATTACHMENT_TABLE = {
    "document": "documents", "expense": "expenses", "message": "messages",
    "proof": "proofs", "site_visit": "site_visits",
}
DIRECT_LINKS = {
    "order_id": "orders", "customer_id": "customers", "vehicle_id": "vehicles",
    "driver_id": "drivers", "site_id": "sites", "managed_site_id": "sites",
    "address_id": "addresses", "pickup_address_id": "addresses",
    "delivery_address_id": "addresses", "pickup_site_id": "sites",
    "delivery_site_id": "sites", "plan_id": "transport_plans",
    "active_plan_id": "transport_plans", "point_id": "transport_points",
    "from_point_id": "transport_points", "to_point_id": "transport_points",
    "assignment_id": "work_assignments", "segment_id": "transport_segments",
    "assignment_step_id": "assignment_steps", "order_item_id": "order_items",
    "reservation_id": "travel_reservations", "conversation_id": "conversations",
    "follows_conversation_id": "conversations", "source_offer_id": "market_offers",
    "source_option_id": "travel_options", "offer_id": "market_offers",
    "document_id": "documents", "alert_id": "alerts", "source_alert_id": "alerts",
    "source_conversation_id": "conversations", "proposal_id": "agent_proposals",
    "source_message_id": "messages", "resolution_message_id": "messages",
    "followup_message_id": "messages", "asset_id": "custody_assets",
    "related_order_id": "orders", "confirmation_message_id": "messages",
    "outcome_message_id": "messages", "resolution_source_message_id": "messages",
    "driver_report_message_id": "messages", "customer_reply_message_id": "messages",
    "prior_duty_assignment_id": "work_assignments",
    "attributed_message_id": "messages", "prior_duty_observation_id": "tracking_observations",
    "basis_observation_id": "tracking_observations", "promise_window_id": "time_windows",
    "endpoint_detail_id": "order_endpoint_details", "selected_claim_id": "endpoint_claims",
    "superseded_by_proposal_id": "agent_proposals",
    "from_terminal_id": "ferry_terminals", "to_terminal_id": "ferry_terminals",
    "origin_terminal_id": "ferry_terminals", "destination_terminal_id": "ferry_terminals",
    "terminal_id": "ferry_terminals", "road_estimate_id": "terminal_road_estimates",
    "terminal_road_estimate_id": "terminal_road_estimates",
    "replacement_reservation_id": "travel_reservations",
    "replaces_reservation_id": "travel_reservations",
    "target_driver_id": "drivers", "source_site_id": "sites",
    "related_document_id": "documents", "supersedes_document_id": "documents",
    "superseded_by_document_id": "documents", "superseded_by_expense_id": "expenses",
    "supersedes_expense_id": "expenses",
}
LIST_LINKS = {
    "order_ids": "orders", "related_order_ids": "orders",
    "segment_ids": "transport_segments", "assignment_ids": "work_assignments",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def records() -> tuple[dict[str, dict[str, dict]], dict]:
    manifest = json.loads((DATA / "manifest.json").read_text(encoding="utf-8"))
    require(isinstance(manifest.get("tables"), dict), "Missing table manifest")
    expected = set(manifest["tables"])
    actual = {path.stem for path in DATA.glob("*.jsonl")}
    require(actual == expected, "JSONL collections differ from manifest")
    tables: dict[str, dict[str, dict]] = {}
    global_ids: set[str] = set()
    for table in sorted(expected):
        values = [json.loads(line) for line in
                  (DATA / f"{table}.jsonl").read_text(encoding="utf-8").splitlines()]
        require(len(values) == manifest["tables"][table], f"{table}: manifest count differs")
        ids = [row.get("id") for row in values]
        require(all(isinstance(value, str) for value in ids) and len(ids) == len(set(ids)),
                f"{table}: missing or duplicate IDs")
        require(not global_ids.intersection(ids), f"{table}: ID reused in another collection")
        global_ids.update(ids)
        tables[table] = {row["id"]: row for row in values}
    require(len(tables.get("orders", {})) == 100, "Selected packet must have exactly 100 orders")
    return tables, manifest


def walk(value: object, path: str):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from walk(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, f"{path}[{index}]")
    elif isinstance(value, str):
        yield path, value


def check_references(tables: dict[str, dict[str, dict]]) -> None:
    all_ids = {record_id for rows in tables.values() for record_id in rows}
    order_references = {row["reference"] for row in tables["orders"].values()}
    for table, rows in tables.items():
        for record in rows.values():
            owner = record.get("order_id")
            if owner is not None:
                require(owner in tables["orders"], f"{table}/{record['id']}: removed order")
            for field, target_table in DIRECT_LINKS.items():
                linked = record.get(field)
                if linked is not None:
                    require(isinstance(linked, str) and linked in tables[target_table],
                            f"{table}/{record['id']}.{field}: wrong or missing target")
            for field, target_table in LIST_LINKS.items():
                linked = record.get(field)
                if linked is not None:
                    require(isinstance(linked, list) and all(isinstance(item, str) and
                            item in tables[target_table] for item in linked),
                            f"{table}/{record['id']}.{field}: wrong or missing target")
            for path, value in walk(record, f"{table}/{record['id']}"):
                if RECORD_ID.fullmatch(value):
                    require(value in all_ids, f"{path}: dangling record ID {value}")
                for reference in ORDER_REFERENCE.findall(value):
                    require(reference in order_references,
                            f"{path}: mentions removed order {reference}")
            def check_typed_refs(value: object, path: str) -> None:
                if isinstance(value, dict):
                    target_table = value.get("table")
                    target_id = value.get("id")
                    if isinstance(target_table, str) and isinstance(target_id, str):
                        require(target_table in tables and target_id in tables[target_table],
                                f"{path}: typed evidence reference has wrong target")
                    for key, child in value.items():
                        check_typed_refs(child, f"{path}.{key}")
                elif isinstance(value, list):
                    for index, child in enumerate(value):
                        check_typed_refs(child, f"{path}[{index}]")
            check_typed_refs(record, f"{table}/{record['id']}")
    for order in tables["orders"].values():
        require(order["customer_id"] in tables["customers"],
                f"{order['id']}: missing customer")
        plan = order.get("active_plan_id")
        require(plan is None or plan in tables["transport_plans"] and
                tables["transport_plans"][plan]["order_id"] == order["id"],
                f"{order['id']}: active plan belongs to another order")


def check_transport(tables: dict[str, dict[str, dict]]) -> None:
    orders = tables["orders"]
    plans = tables["transport_plans"]
    items = tables["order_items"]
    points = tables["transport_points"]
    for item in items.values():
        require(item["order_id"] in orders and item["vehicle_id"] in tables["vehicles"],
                f"{item['id']}: missing order or vehicle")
    for point in points.values():
        require(point["plan_id"] in plans, f"{point['id']}: missing plan")
        require(point["address_id"] in tables["addresses"],
                f"{point['id']}: missing address")
    for segment in tables["transport_segments"].values():
        plan = plans.get(segment["plan_id"])
        item = items.get(segment["order_item_id"])
        require(plan is not None and item is not None and
                plan["order_id"] == item["order_id"],
                f"{segment['id']}: plan and item belong to different orders")
        for field in ("from_point_id", "to_point_id"):
            point = points.get(segment[field])
            require(point is not None and point["plan_id"] == segment["plan_id"],
                    f"{segment['id']}: {field} is outside plan")
    for table in ("addresses", "vehicles", "transport_points", "transport_segments"):
        require(bool(tables[table]), f"{table}: empty after selection")
    # A compact packet must not drag along vehicles and plans for removed orders.
    used_vehicles = {item["vehicle_id"] for item in items.values()}
    require(set(tables["vehicles"]) == used_vehicles, "Unlinked vehicles remain")
    require(all(plan["order_id"] in orders for plan in plans.values()),
            "Unlinked transport plan remains")
    require(set(points) == {point_id for segment in tables["transport_segments"].values()
                            for point_id in (segment["from_point_id"], segment["to_point_id"])},
            "Unlinked transport point remains")


def check_events(tables: dict[str, dict[str, dict]], snapshot: datetime) -> None:
    by_order: dict[str, list[dict]] = defaultdict(list)
    for event in tables["operational_events"].values():
        owner = event["order_id"]
        require(owner in tables["orders"], f"{event['id']}: removed order")
        require(event["target_type"] in TARGET_TABLE, f"{event['id']}: unknown target type")
        target = tables[TARGET_TABLE[event["target_type"]]].get(event["target_id"])
        require(target is not None, f"{event['id']}: missing target")
        target_order = target.get("order_id")
        if target_order is not None and target_order != owner:
            allowed = event["target_type"] == "market_offer" and owner in target.get("order_ids", [])
            require(allowed, f"{event['id']}: target belongs to another order")
        require(timestamp(event["recorded_at"]) <= snapshot,
                f"{event['id']}: event after snapshot")
        by_order[owner].append(event)
    for order in tables["orders"].values():
        history = sorted(by_order[order["id"]], key=lambda event:
                         (event["recorded_at"], event["id"]))
        require(bool(history) and history[0]["command"] == "order.created" and
                history[0]["target_id"] == order["id"],
                f"{order['id']}: missing creation event")
        require(order["created_at"] == history[0]["recorded_at"] and
                order["updated_at"] == max(event["recorded_at"] for event in history),
                f"{order['id']}: order timestamps disagree with events")
        require(timestamp(order["updated_at"]) <= snapshot,
                f"{order['id']}: updated after snapshot")


def check_attachments(tables: dict[str, dict[str, dict]]) -> int:
    directory = ROOT / "attachments"
    entries = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    require(isinstance(entries, list), "Attachment manifest must be a list")
    seen_ids: set[str] = set()
    seen_paths: set[Path] = set()
    attached_documents: set[str] = set()
    attached_expenses: set[str] = set()
    for entry in entries:
        require(entry["id"] not in seen_ids, f"Duplicate attachment {entry['id']}")
        seen_ids.add(entry["id"])
        require(entry.get("synthetic") is True, f"{entry['id']}: not marked fictional")
        order = entry["order_id"]
        require(order in tables["orders"], f"{entry['id']}: removed order")
        target_table = ATTACHMENT_TABLE.get(entry["related_record_type"])
        require(target_table is not None, f"{entry['id']}: unknown related type")
        target = tables[target_table].get(entry["related_record_id"])
        require(target is not None and target["order_id"] == order,
                f"{entry['id']}: related record missing or belongs to another order")
        relative = Path(entry["file_name"])
        require(not relative.is_absolute() and ".." not in relative.parts,
                f"{entry['id']}: unsafe file path")
        file = (directory / relative).resolve()
        require(file.is_relative_to(directory.resolve()) and file.is_file() and
                file not in seen_paths, f"{entry['id']}: missing or duplicate file")
        seen_paths.add(file)
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        require(digest == entry["sha256"], f"{entry['id']}: byte hash differs")
        expected_type = "application/pdf" if file.suffix == ".pdf" else "image/jpeg"
        require(file.suffix in {".pdf", ".jpg", ".jpeg"} and
                entry["content_type"] == expected_type,
                f"{entry['id']}: content type differs")
        if target_table == "documents":
            attached_documents.add(target["id"])
            require(file.suffix == ".pdf" and target["status"] == entry["status"] and
                    target["kind"] == entry["kind"],
                    f"{entry['id']}: document state differs")
        if target_table == "expenses":
            attached_expenses.add(target["id"])
            require(file.suffix == ".pdf" and target["status"] == entry["status"],
                    f"{entry['id']}: expense state differs")
        if target_table == "proof":
            require(target["status"] == entry["status"],
                    f"{entry['id']}: proof state differs")
    actual_files = {path.resolve() for path in directory.rglob("*")
                    if path.is_file() and path.suffix.lower() in {".pdf", ".jpg", ".jpeg"}}
    require(actual_files == seen_paths, "Unbundled or unlisted attachment file")
    filed = {row["id"] for row in tables["documents"].values()
             if row["kind"] in {"CMR", "RELEASE_AUTHORITY"} and
             row["status"] in {"SIGNED", "VERIFIED"} and row["file_count"] > 0}
    require(attached_documents == filed, "Filed CMR/release document lacks its PDF")
    sampled = {row["id"] for row in tables["expenses"].values()
               if row.get("receipt_state") == "ATTACHED_SAMPLED"}
    require(sampled <= attached_expenses, "Sampled expense receipt lacks its PDF")
    return len(entries)


def main() -> None:
    tables, manifest = records()
    check_references(tables)
    check_transport(tables)
    check_events(tables, timestamp(manifest["snapshot_at"]))
    attachment_count = check_attachments(tables)
    print(json.dumps({"orders": len(tables["orders"]),
                      "records": sum(len(rows) for rows in tables.values()),
                      "attachments": attachment_count,
                      "stages": dict(Counter(row["display_lane"] for row in
                                             tables["orders"].values()))}, indent=2))


if __name__ == "__main__":
    main()
