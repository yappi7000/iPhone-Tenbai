import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PRODUCTS_FILE = ROOT / "data/apple_products.json"
OUTPUT_FILE = ROOT / "data/apple_inventory.json"

ENDPOINT = "https://www.apple.com/jp/shop/retail/pickup-message"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 Chrome/152 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.apple.com/jp/shop/buy-iphone/iphone-18-pro",
}

# 全国Apple Storeを拾いやすくするための検索起点
ANCHORS = {
    "tokyo": "100-0005",
    "nagoya": "450-0002",
    "kyoto": "600-8006",
    "osaka": "542-0086",
    "fukuoka": "810-0001",
}

BATCH_SIZE = 8


def chunks(values, size):
    for i in range(0, len(values), size):
        yield values[i:i + size]


def fetch_inventory(parts, location):
    params = [("location", location)]

    for i, part in enumerate(parts):
        params.append((f"parts.{i}", part))

    url = ENDPOINT + "?" + urllib.parse.urlencode(params)

    req = urllib.request.Request(
        url,
        headers=HEADERS,
    )

    with urllib.request.urlopen(req, timeout=30) as response:
        raw = response.read()

    data = json.loads(raw)

    if str(data.get("head", {}).get("status")) != "200":
        raise RuntimeError(
            f"Apple API status: "
            f"{data.get('head', {}).get('status')}"
        )

    stores = data.get("body", {}).get("stores")

    if not isinstance(stores, list):
        raise RuntimeError("Apple API stores missing")

    return stores


def pickup_status(part_data):
    display = str(
        part_data.get("pickupDisplay") or ""
    ).lower()

    if display == "available":
        return "available"

    if display == "unavailable":
        return "unavailable"

    return "unknown"


def main():
    master = json.loads(
        PRODUCTS_FILE.read_text()
    )

    products = master["products"]

    if len(products) != 32:
        raise SystemExit(
            f"Apple商品マスターが32 SKUではありません: "
            f"{len(products)}"
        )

    part_numbers = sorted(products.keys())

    observed = {
        part: {
            **products[part],
            "stores": {},
            "request_successes": 0,
            "request_errors": [],
        }
        for part in part_numbers
    }

    stores_master = {}

    for anchor_name, location in ANCHORS.items():
        print("")
        print("=" * 70)
        print(
            f"検索地点: {anchor_name} / {location}"
        )
        print("=" * 70)

        for batch in chunks(
            part_numbers,
            BATCH_SIZE
        ):
            try:
                stores = fetch_inventory(
                    batch,
                    location,
                )

                print(
                    f"取得OK: {len(batch)} SKU / "
                    f"{len(stores)} stores"
                )

                for part in batch:
                    observed[part][
                        "request_successes"
                    ] += 1

                for store in stores:
                    store_number = str(
                        store.get("storeNumber")
                        or ""
                    )

                    if not store_number:
                        continue

                    stores_master[
                        store_number
                    ] = {
                        "store_number": store_number,
                        "name": store.get(
                            "storeName"
                        ),
                        "state": store.get(
                            "state"
                        ),
                        "city": store.get(
                            "city"
                        ),
                        "postal_code": (
                            store.get(
                                "address", {}
                            ).get(
                                "postalCode"
                            )
                        ),
                        "latitude": store.get(
                            "storelatitude"
                        ),
                        "longitude": store.get(
                            "storelongitude"
                        ),
                        "reservation_url": (
                            store.get(
                                "reservationUrl"
                            )
                        ),
                    }

                    availability = (
                        store.get(
                            "partsAvailability"
                        )
                        or {}
                    )

                    for part in batch:
                        part_data = (
                            availability.get(part)
                        )

                        if not isinstance(
                            part_data,
                            dict,
                        ):
                            continue

                        status = pickup_status(
                            part_data
                        )

                        row = {
                            "store_number": (
                                store_number
                            ),
                            "store_name": (
                                store.get(
                                    "storeName"
                                )
                            ),
                            "state": store.get(
                                "state"
                            ),
                            "city": store.get(
                                "city"
                            ),
                            "status": status,
                            "pickup_display": (
                                part_data.get(
                                    "pickupDisplay"
                                )
                            ),
                            "store_pick_eligible": (
                                part_data.get(
                                    "storePickEligible"
                                )
                            ),
                            "pickup_search_quote": (
                                part_data.get(
                                    "pickupSearchQuote"
                                )
                            ),
                        }

                        old = observed[
                            part
                        ]["stores"].get(
                            store_number
                        )

                        # available を最優先。
                        # APIエラーを unavailable 扱いにはしない。
                        rank = {
                            "available": 3,
                            "unavailable": 2,
                            "unknown": 1,
                        }

                        if (
                            old is None
                            or rank.get(
                                status, 0
                            )
                            > rank.get(
                                old.get(
                                    "status"
                                ),
                                0,
                            )
                        ):
                            observed[
                                part
                            ]["stores"][
                                store_number
                            ] = row

            except Exception as e:
                message = (
                    f"{anchor_name}: "
                    f"{type(e).__name__}: {e}"
                )

                print(
                    "取得ERROR:",
                    message,
                )

                for part in batch:
                    observed[
                        part
                    ][
                        "request_errors"
                    ].append(message)

            time.sleep(1)

    output_products = {}

    for part, item in observed.items():
        stores = list(
            item.pop("stores").values()
        )

        stores.sort(
            key=lambda x: (
                x.get("state") or "",
                x.get("city") or "",
                x.get("store_name") or "",
            )
        )

        available_count = sum(
            1
            for s in stores
            if s["status"] == "available"
        )

        unavailable_count = sum(
            1
            for s in stores
            if s["status"] == "unavailable"
        )

        if item[
            "request_successes"
        ] == 0:
            overall_status = "error"
        else:
            overall_status = "ok"

        output_products[part] = {
            **item,
            "overall_status": (
                overall_status
            ),
            "available_store_count": (
                available_count
            ),
            "unavailable_store_count": (
                unavailable_count
            ),
            "stores": stores,
        }

    output = {
        "schema_version": 1,
        "generated_at": datetime.now(
            timezone.utc
        ).isoformat(),
        "source": (
            "Apple Japan retail pickup"
        ),
        "anchors": ANCHORS,
        "stores": stores_master,
        "products": output_products,
    }

    temp = OUTPUT_FILE.with_suffix(
        ".tmp"
    )

    temp.write_text(
        json.dumps(
            output,
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )

    json.loads(temp.read_text())

    temp.replace(OUTPUT_FILE)

    print("")
    print("=" * 70)
    print("Apple Store 在庫取得結果")
    print("=" * 70)
    print(
        "Apple Store数:",
        len(stores_master),
    )

    for part in part_numbers:
        item = output_products[part]

        print(
            f'{part} '
            f'{item["model"]} '
            f'{item["storage"]} '
            f'{item["color"]} '
            f'→ 在庫あり '
            f'{item["available_store_count"]}店'
        )

    print("")
    print(
        "✅ data/apple_inventory.json "
        "を作成しました"
    )


if __name__ == "__main__":
    main()
