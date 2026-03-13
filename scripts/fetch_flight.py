#!/usr/bin/env python3
"""FlightAware AeroAPI helper for GNOME Shell extension.

Commands:
- has-key: returns whether API key exists in keyring
- set-key: stores API key from stdin in keyring
- query --ident IDENT: queries FlightAware and selects in-progress flight
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

SERVICE_ATTR = "flightaware-aeroapi"
ACCOUNT_ATTR = "default"
API_BASE = "https://aeroapi.flightaware.com/aeroapi"


def _run_secret_tool(args: list[str], *, stdin_text: str | None = None, timeout: int = 8) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["secret-tool", *args],
        input=stdin_text,
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout,
    )


def load_api_key() -> str | None:
    # Allow override via environment variable (used in nested dev sessions).
    env_key = os.environ.get("FLYSHELL_API_KEY", "").strip()
    if env_key:
        return env_key

    try:
        proc = _run_secret_tool(["lookup", "service", SERVICE_ATTR, "account", ACCOUNT_ATTR])
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None

    if proc.returncode != 0:
        return None

    key = (proc.stdout or "").strip()
    return key or None


def store_api_key(api_key: str) -> None:
    try:
        proc = _run_secret_tool(
            [
                "store",
                "--label=FlightAware AeroAPI Key",
                "service",
                SERVICE_ATTR,
                "account",
                ACCOUNT_ATTR,
            ],
            stdin_text=f"{api_key}\n",
        )
    except FileNotFoundError as exc:
        raise RuntimeError("secret-tool was not found; install libsecret tools") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Timed out while storing API key") from exc

    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        raise RuntimeError(stderr or "Failed to store API key in keyring")


def _safe_progress(value: Any) -> float | None:
    try:
        progress = float(value)
    except (TypeError, ValueError):
        return None

    return progress


def _is_en_route(status: str) -> bool:
    return "en route" in status.lower()


def choose_best_flight(payload: dict[str, Any], *, include_scheduled: bool = False) -> dict[str, Any] | None:
    """Pick the best flight: prefer en-route, optionally fall back to nearest scheduled."""
    flights = payload.get("flights", [])
    if not isinstance(flights, list):
        return None

    en_route: list[dict[str, Any]] = []
    scheduled: list[dict[str, Any]] = []
    for flight in flights:
        if not isinstance(flight, dict):
            continue

        status = str(flight.get("status", ""))
        progress = _safe_progress(flight.get("progress_percent"))

        if progress is not None and _is_en_route(status) and 0 < progress < 100:
            en_route.append(flight)
        elif include_scheduled and status.lower().startswith("scheduled"):
            scheduled.append(flight)

    if en_route:
        return max(en_route, key=lambda f: float(f.get("progress_percent", 0)))

    if scheduled:
        return scheduled[0]

    return None


def _find_completed_flight(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Return a flight at 100% progress (arrived/completed)."""
    flights = payload.get("flights", [])
    if not isinstance(flights, list):
        return None

    for flight in flights:
        if not isinstance(flight, dict):
            continue
        progress = _safe_progress(flight.get("progress_percent"))
        if progress is not None and progress >= 100:
            return flight

    return None


def _api_request(url: str, api_key: str, timeout: int) -> dict[str, Any]:
    """Make a GET request to the AeroAPI and return parsed JSON."""
    req = Request(
        url,
        headers={
            "Accept": "application/json",
            "x-apikey": api_key,
        },
        method="GET",
    )

    try:
        with urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise RuntimeError(f"HTTP {exc.code}: {detail or exc.reason}") from exc
    except URLError as exc:
        raise RuntimeError(f"Network error: {exc.reason}") from exc

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON from API: {exc}") from exc


def _fetch_flights_payload(ident: str, timeout: int, ident_type: str | None = None) -> dict[str, Any]:
    """Fetch the flights payload from AeroAPI for the given ident."""
    api_key = load_api_key()
    if not api_key:
        raise RuntimeError("API key not configured")

    encoded_ident = quote(ident, safe="")
    url = f"{API_BASE}/flights/{encoded_ident}"
    if ident_type:
        url += f"?ident_type={quote(ident_type, safe='')}"
    return _api_request(url, api_key, timeout)


def _build_selected(flight: dict[str, Any], fallback_ident: str) -> dict[str, Any]:
    departure = flight.get("scheduled_out") or flight.get("estimated_out") or ""
    arrival = flight.get("estimated_in") or flight.get("scheduled_in") or ""
    return {
        "ident": flight.get("ident") or fallback_ident,
        "fa_flight_id": flight.get("fa_flight_id") or "",
        "status": flight.get("status") or "",
        "progress_percent": flight.get("progress_percent", 0),
        "departure": departure,
        "arrival": arrival,
    }


def query_flight(ident: str, timeout: int, ident_type: str | None = None) -> dict[str, Any]:
    payload = _fetch_flights_payload(ident, timeout, ident_type=ident_type)

    selected = choose_best_flight(payload)
    if not selected:
        selected = _find_completed_flight(payload)
        if not selected:
            return {
                "selected": None,
                "message": "No en route flight with progress between 0 and 100",
            }

    return {"selected": _build_selected(selected, ident)}


def fetch_offline(ident: str, timeout: int) -> dict[str, Any]:
    """Fetch flight data and return timestamps for offline progress calculation."""
    payload = _fetch_flights_payload(ident, timeout)

    selected = choose_best_flight(payload, include_scheduled=True)
    if not selected:
        return {
            "selected": None,
            "message": "No suitable flight found for offline mode",
        }

    departure = selected.get("scheduled_out") or selected.get("estimated_out") or ""
    arrival = selected.get("estimated_in") or selected.get("scheduled_in") or ""

    return {
        "selected": {
            "ident": selected.get("ident") or ident,
            "fa_flight_id": selected.get("fa_flight_id") or "",
            "status": selected.get("status") or "",
            "departure": departure,
            "arrival": arrival,
        }
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="FlightAware helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("has-key")

    subparsers.add_parser("set-key")

    query_parser = subparsers.add_parser("query")
    query_parser.add_argument("--ident", required=True)
    query_parser.add_argument("--ident-type", default=None, dest="ident_type",
                              choices=["designator", "registration", "fa_flight_id"])
    query_parser.add_argument("--timeout", type=int, default=10)

    fetch_parser = subparsers.add_parser("fetch-offline")
    fetch_parser.add_argument("--ident", required=True)
    fetch_parser.add_argument("--timeout", type=int, default=10)

    args = parser.parse_args()

    try:
        if args.command == "has-key":
            result = {"has_key": bool(load_api_key())}
        elif args.command == "set-key":
            api_key = sys.stdin.read().strip()
            if not api_key:
                raise RuntimeError("Empty API key")
            store_api_key(api_key)
            result = {"stored": True}
        elif args.command == "query":
            ident = args.ident.strip()
            if args.ident_type != "fa_flight_id":
                ident = ident.upper()
            if not ident:
                raise RuntimeError("Empty flight identifier")
            result = query_flight(ident, max(3, min(args.timeout, 30)),
                                  ident_type=args.ident_type)
        elif args.command == "fetch-offline":
            ident = args.ident.strip().upper()
            if not ident:
                raise RuntimeError("Empty flight identifier")
            result = fetch_offline(ident, max(3, min(args.timeout, 30)))
        else:
            raise RuntimeError("Unsupported command")

        print(json.dumps(result))
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
