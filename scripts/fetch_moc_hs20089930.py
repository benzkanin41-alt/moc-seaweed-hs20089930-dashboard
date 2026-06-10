from __future__ import annotations

import csv
import json
import re
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests


BASE_URL = "https://tradereport.moc.go.th"
REPORT_URL = f"{BASE_URL}/th/stat/reporthscodeexport01"
RESULT_ENDPOINT = f"{BASE_URL}/stat/reporthscodeexport01/result"
PRODUCT_NAME = "สาหร่าย"
HS_CODE = "20089930"
START_YEAR = 2021
START_MONTH = 1

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "dashboard"
DATA_DIR = OUT_DIR / "data"
RAW_DIR = ROOT / "work" / "moc_raw"

THAI_MONTHS = {
    1: "ม.ค.",
    2: "ก.พ.",
    3: "มี.ค.",
    4: "เม.ย.",
    5: "พ.ค.",
    6: "มิ.ย.",
    7: "ก.ค.",
    8: "ส.ค.",
    9: "ก.ย.",
    10: "ต.ค.",
    11: "พ.ย.",
    12: "ธ.ค.",
}


def as_number(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, str):
        value = value.replace(",", "")
    return float(value)


def request_json(
    session: requests.Session,
    method: str,
    url: str,
    *,
    json_payload: dict[str, Any] | None = None,
    retries: int = 3,
) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            if method == "GET":
                response = session.get(url, timeout=45)
            else:
                response = session.post(url, json=json_payload, timeout=45)
            response.raise_for_status()
            return response.json()
        except Exception as exc:  # noqa: BLE001 - retry and report final context.
            last_error = exc
            if attempt == retries:
                raise
            time.sleep(0.75 * attempt)
    raise RuntimeError(f"Failed to request {url}") from last_error


def get_latest_period(session: requests.Session) -> tuple[int, int, str]:
    response = session.get(REPORT_URL, timeout=45)
    response.raise_for_status()
    html = response.text
    match = re.search(r'latestmonth="(\d+)"\s+latestyear="(\d+)"', html)
    if not match:
        raise RuntimeError("Could not find latestmonth/latestyear in MOC report page.")
    latest_month = int(match.group(1))
    latest_year = int(match.group(2))
    app_match = re.search(r"/js/app\.js\?id=([0-9a-f]+)", html)
    app_id = app_match.group(1) if app_match else ""
    return latest_year, latest_month, app_id


def hscode_versions(session: requests.Session) -> list[str]:
    rows = request_json(session, "GET", f"{BASE_URL}/lookup/hscodeversions")
    versions: list[str] = []
    if isinstance(rows, list):
        for row in rows:
            if isinstance(row, dict):
                value = row.get("id") or row.get("ID") or row.get("name") or row.get("text")
            else:
                value = row
            if value is not None:
                versions.append(str(value))
    if "2022" in versions:
        versions = ["2022"] + [version for version in versions if version != "2022"]
    return versions or ["2022"]


def lookup_hs_name(session: requests.Session) -> tuple[str, str, Any]:
    attempts = []
    for version in hscode_versions(session):
        lookup_url = f"{BASE_URL}/lookup/hscodelist{HS_CODE}/{version}"
        try:
            payload = request_json(session, "POST", lookup_url, json_payload={"lang": "th"})
        except Exception as exc:  # noqa: BLE001 - record and try other source versions.
            attempts.append({"version": version, "error": str(exc)})
            continue

        name = None
        if isinstance(payload, dict):
            name = payload.get("Name") or payload.get("name") or payload.get("text")
        elif isinstance(payload, list) and payload:
            first = payload[0]
            if isinstance(first, dict):
                name = first.get("Name") or first.get("name") or first.get("text")
        if name:
            return version, str(name), payload
        attempts.append({"version": version, "payload": payload})

    raise RuntimeError(f"HS code {HS_CODE} was not found in MOC lookup. Attempts: {attempts}")


def build_country_metadata(
    country_rows: list[dict[str, Any]],
    groups: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, str]]]:
    country_by_id = {
        str(row["id"]): {
            "countryId": str(row["id"]),
            "code": row.get("Code2", ""),
            "nameTh": row.get("nameTh", ""),
            "nameEn": row.get("nameEn", ""),
        }
        for row in country_rows
    }

    continents: list[dict[str, Any]] = []
    country_to_continent: dict[str, dict[str, str]] = {}
    for group in groups:
        group_id = str(group.get("id", ""))
        if group_id == "00" or not group_id.startswith("1"):
            continue
        continent = {
            "continentId": group_id,
            "continentName": group.get("name", ""),
            "countryCount": len(group.get("countrys", [])),
        }
        continents.append(continent)
        for country in group.get("countrys", []):
            country_to_continent[str(country.get("CountryID"))] = {
                "continentId": group_id,
                "continentName": group.get("name", ""),
            }

    enriched_countries = []
    for country_id, meta in country_by_id.items():
        continent = country_to_continent.get(
            country_id,
            {"continentId": "UNMAPPED", "continentName": "ไม่จัดกลุ่ม"},
        )
        enriched_countries.append({**meta, **continent})

    enriched_countries.sort(key=lambda row: (row["continentId"], row["code"], row["countryId"]))
    continents.sort(key=lambda row: row["continentId"])
    return enriched_countries, continents, country_to_continent


def period_range(latest_year: int, latest_month: int) -> list[tuple[int, int]]:
    periods: list[tuple[int, int]] = []
    for year in range(START_YEAR, latest_year + 1):
        first_month = START_MONTH if year == START_YEAR else 1
        last_month = latest_month if year == latest_year else 12
        for month in range(first_month, last_month + 1):
            periods.append((year, month))
    return periods


def make_payload(year: int, month: int, year_name: Any, hs_version: str, hs_name: str) -> dict[str, Any]:
    return {
        "year": {"id": str(year), "text": str(year_name)},
        "month": {"id": str(month), "text": THAI_MONTHS[month]},
        "currency": {"id": "baht", "text": "บาท"},
        "hscodedigits": len(HS_CODE),
        "hscode": None,
        "sort": {"id": "value_desc", "text": "มูลค่า (จากมากไปน้อย)"},
        "hscodes": [{"id": HS_CODE, "name": hs_name}],
        "Previousyear": {"id": "0", "text": "0 ปี"},
        "hscodeversion": {"id": hs_version, "text": hs_version},
        "lang": "th",
    }


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers.update(
        {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Origin": BASE_URL,
            "Referer": REPORT_URL,
            "User-Agent": "Mozilla/5.0 Codex dashboard builder",
        }
    )

    latest_year, latest_month, app_id = get_latest_period(session)
    years = request_json(session, "GET", f"{BASE_URL}/lookup/years?lang=th")
    year_name_by_id = {str(row["id"]): row["name"] for row in years}
    country_lookup = request_json(session, "GET", f"{BASE_URL}/lookup/country")
    country_groups = request_json(session, "GET", f"{BASE_URL}/lookup/countrygroup?lang=th")
    hs_version, hs_name, hs_lookup_payload = lookup_hs_name(session)

    countries, continents, country_to_continent = build_country_metadata(country_lookup, country_groups)
    country_meta_by_id = {row["countryId"]: row for row in countries}

    monthly_rows: list[dict[str, Any]] = []
    total_rows: list[dict[str, Any]] = []
    validations: list[dict[str, Any]] = []
    missing_continent_ids: set[str] = set()

    periods = period_range(latest_year, latest_month)
    for index, (year, month) in enumerate(periods, start=1):
        payload = make_payload(year, month, year_name_by_id.get(str(year), year + 543), hs_version, hs_name)
        response_data = request_json(session, "POST", RESULT_ENDPOINT, json_payload=payload)
        raw_path = RAW_DIR / f"report_hs{HS_CODE}_{year}_{month:02d}.json"
        raw_path.write_text(json.dumps(response_data, ensure_ascii=False, indent=2), encoding="utf-8")

        records = response_data.get("records", [])
        if not records:
            raise RuntimeError(f"No records returned for {year}-{month:02d}.")

        period_key = f"{year}-{month:02d}"
        world_record = next((record for record in records if record.get("RowType") == "S"), None)
        if not world_record:
            raise RuntimeError(f"No world summary row returned for {period_key}.")

        total_value = as_number(world_record.get("ValueMonth"))
        total_quantity = as_number(world_record.get("QuantityMonth"))
        total_rows.append(
            {
                "period": period_key,
                "year": year,
                "month": month,
                "quarter": (month - 1) // 3 + 1,
                "value": total_value,
                "quantity": total_quantity,
                "ytdValue": as_number(world_record.get("Value")),
                "ytdQuantity": as_number(world_record.get("Quantity")),
            }
        )

        country_value_sum = 0.0
        country_quantity_sum = 0.0
        country_count = 0
        for record in records:
            if record.get("RowType") == "S":
                continue
            country_id = str(record.get("ID", ""))
            meta = country_meta_by_id.get(country_id, {})
            continent = country_to_continent.get(
                country_id,
                {"continentId": "UNMAPPED", "continentName": "ไม่จัดกลุ่ม"},
            )
            if continent["continentId"] == "UNMAPPED":
                missing_continent_ids.add(country_id)

            value = as_number(record.get("ValueMonth"))
            quantity = as_number(record.get("QuantityMonth"))
            country_value_sum += value
            country_quantity_sum += quantity
            country_count += 1
            monthly_rows.append(
                {
                    "period": period_key,
                    "year": year,
                    "month": month,
                    "quarter": (month - 1) // 3 + 1,
                    "countryId": country_id,
                    "countryCode": meta.get("code", ""),
                    "countryName": record.get("CountryName", meta.get("nameTh", "")),
                    "continentId": continent["continentId"],
                    "continentName": continent["continentName"],
                    "value": value,
                    "quantity": quantity,
                }
            )

        validations.append(
            {
                "period": period_key,
                "countryCount": country_count,
                "worldValue": total_value,
                "countryValueSum": country_value_sum,
                "valueDiff": total_value - country_value_sum,
                "worldQuantity": total_quantity,
                "countryQuantitySum": country_quantity_sum,
                "quantityDiff": total_quantity - country_quantity_sum,
            }
        )
        print(f"[{index:02d}/{len(periods)}] fetched {period_key}: {country_count} country rows")
        time.sleep(0.05)

    continent_monthly: dict[tuple[str, str], dict[str, Any]] = {}
    for row in monthly_rows:
        key = (row["period"], row["continentId"])
        if key not in continent_monthly:
            continent_monthly[key] = {
                "period": row["period"],
                "year": row["year"],
                "month": row["month"],
                "quarter": row["quarter"],
                "continentId": row["continentId"],
                "continentName": row["continentName"],
                "value": 0.0,
                "quantity": 0.0,
            }
        continent_monthly[key]["value"] += row["value"]
        continent_monthly[key]["quantity"] += row["quantity"]

    validation_summary = {
        "monthsFetched": len(periods),
        "expectedMonths": len(periods),
        "countryRows": len(monthly_rows),
        "totalRows": len(total_rows),
        "continentRows": len(continent_monthly),
        "maxAbsValueDiff": max(abs(row["valueDiff"]) for row in validations),
        "maxAbsQuantityDiff": max(abs(row["quantityDiff"]) for row in validations),
        "missingContinentCountryIds": sorted(missing_continent_ids),
    }

    dataset = {
        "metadata": {
            "title": f"Dashboard การส่งออก{PRODUCT_NAME}",
            "productName": PRODUCT_NAME,
            "hsCode": HS_CODE,
            "hsName": hs_name,
            "hsVersion": hs_version,
            "hsLookupPayload": hs_lookup_payload,
            "reportUrl": REPORT_URL,
            "endpoint": RESULT_ENDPOINT,
            "source": "Thailand's Trade Statistic, Ministry of Commerce",
            "sourceNote": "ข้อมูลล่าสุดตามหน้า MOC reporthscodeexport01",
            "appBundleId": app_id,
            "fetchedAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "startPeriod": f"{START_YEAR}-{START_MONTH:02d}",
            "latestPeriod": f"{latest_year}-{latest_month:02d}",
            "latestYear": latest_year,
            "latestMonth": latest_month,
            "currency": "THB",
            "valueUnit": "บาท",
            "quantityUnit": "หน่วยตามกรมศุลกากร",
        },
        "continents": continents,
        "countries": countries,
        "monthly": monthly_rows,
        "totals": total_rows,
        "validation": validation_summary,
    }

    (OUT_DIR / "data.js").write_text(
        "window.MOC_EXPORT_DATA = "
        + json.dumps(dataset, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    (DATA_DIR / "dataset.json").write_text(json.dumps(dataset, ensure_ascii=False, indent=2), encoding="utf-8")

    write_csv(
        DATA_DIR / f"monthly_country_hs{HS_CODE}.csv",
        monthly_rows,
        [
            "period",
            "year",
            "month",
            "quarter",
            "countryId",
            "countryCode",
            "countryName",
            "continentId",
            "continentName",
            "value",
            "quantity",
        ],
    )
    write_csv(
        DATA_DIR / f"monthly_continent_hs{HS_CODE}.csv",
        list(continent_monthly.values()),
        ["period", "year", "month", "quarter", "continentId", "continentName", "value", "quantity"],
    )
    write_csv(
        DATA_DIR / f"monthly_total_hs{HS_CODE}.csv",
        total_rows,
        ["period", "year", "month", "quarter", "value", "quantity", "ytdValue", "ytdQuantity"],
    )
    write_csv(
        DATA_DIR / "validation_reconciliation.csv",
        validations,
        [
            "period",
            "countryCount",
            "worldValue",
            "countryValueSum",
            "valueDiff",
            "worldQuantity",
            "countryQuantitySum",
            "quantityDiff",
        ],
    )

    print(json.dumps(validation_summary, ensure_ascii=False, indent=2))
    print(f"Dashboard data written to {OUT_DIR}")


if __name__ == "__main__":
    main()
