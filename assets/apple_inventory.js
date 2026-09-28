let APPLE_INVENTORY = null;
let APPLE_PRODUCTS = null;

async function loadAppleInventoryData() {
  try {
    const [inventoryRes, productsRes] = await Promise.all([
      fetch("data/apple_inventory.json?ts=" + Date.now()),
      fetch("data/apple_products.json?ts=" + Date.now())
    ]);

    if (!inventoryRes.ok || !productsRes.ok) {
      throw new Error("Apple inventory data fetch failed");
    }

    APPLE_INVENTORY = await inventoryRes.json();
    APPLE_PRODUCTS = await productsRes.json();

    return true;
  } catch (error) {
    console.error("Apple inventory load error:", error);
    return false;
  }
}

function findAppleProductByJan(jan) {
  if (!APPLE_PRODUCTS?.products) return null;

  return Object.values(
    APPLE_PRODUCTS.products
  ).find(
    item => String(item.jan) === String(jan)
  ) || null;
}

function getAppleInventoryByJan(jan) {
  const product = findAppleProductByJan(jan);

  if (!product) {
    return null;
  }

  const inventory =
    APPLE_INVENTORY?.products?.[
      product.part_number
    ];

  if (!inventory) {
    return {
      product,
      status: "unknown",
      stores: []
    };
  }

  return {
    product,
    status: inventory.overall_status,
    stores: inventory.stores || [],
    availableStoreCount:
      inventory.available_store_count || 0
  };
}

function appleStoreStatusIcon(status) {
  if (status === "available") {
    return "🟢";
  }

  if (status === "unavailable") {
    return "🔴";
  }

  return "⚪";
}

function renderAppleInventory(jan, container) {
  if (!container) return;

  const data = getAppleInventoryByJan(jan);

  if (!data) {
    container.innerHTML = `
      <div class="apple-inventory-empty">
        この商品はApple Store在庫確認の対象外です。
      </div>
    `;
    return;
  }

  const { product, stores } = data;

  const available = stores.filter(
    s => s.status === "available"
  );

  const sortedStores = [...stores].sort(
    (a, b) => {
      if (
        a.status === "available" &&
        b.status !== "available"
      ) return -1;

      if (
        b.status === "available" &&
        a.status !== "available"
      ) return 1;

      return String(
        a.store_name || ""
      ).localeCompare(
        String(b.store_name || ""),
        "ja"
      );
    }
  );

  container.innerHTML = `
    <div class="apple-inventory-card">

      <div class="apple-inventory-header">
        <div>
          <div class="apple-inventory-title">
            🍎 Apple Store 在庫
          </div>

          <div class="apple-inventory-product">
            ${product.model}
            ${product.storage}
            ${product.color}
          </div>
        </div>

        <div class="apple-inventory-count">
          ${
            available.length > 0
              ? `🟢 ${available.length}店舗`
              : "🔴 在庫なし"
          }
        </div>
      </div>

      <div class="apple-inventory-price">
        Apple価格
        <strong>
          ¥${Number(
            product.apple_price
          ).toLocaleString()}
        </strong>
      </div>

      <div class="apple-inventory-list">

        ${
          sortedStores.length
            ? sortedStores.map(
                store => `
                <div class="apple-store-row">
                  <div>
                    <strong>
                      ${appleStoreStatusIcon(
                        store.status
                      )}
                      ${store.store_name}
                    </strong>

                    <span>
                      ${store.state || ""}
                    </span>
                  </div>

                  <div class="apple-store-status ${
                    store.status
                  }">
                    ${
                      store.status ===
                      "available"
                        ? "受取可能"
                        : store.status ===
                          "unavailable"
                        ? "在庫なし"
                        : "確認不可"
                    }
                  </div>
                </div>
              `
              ).join("")
            : `
              <div class="apple-inventory-empty">
                店舗在庫情報を取得できませんでした。
              </div>
            `
        }

      </div>

      <div class="apple-inventory-note">
        Apple Storeの店頭受取情報を表示しています。
        在庫は変動するため、購入前にApple公式画面で
        最終確認してください。
      </div>

    </div>
  `;
}

window.loadAppleInventoryData =
  loadAppleInventoryData;

window.getAppleInventoryByJan =
  getAppleInventoryByJan;

window.renderAppleInventory =
  renderAppleInventory;
