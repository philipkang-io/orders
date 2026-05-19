const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const INVENTORY_BASE_URL =
  process.env.INVENTORY_BASE_URL || "http://inventory.inventory.svc.cluster.local:3000";

const ordersById = new Map();
let orderCounter = 1;

function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString("hex");
  const spanId = crypto.randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}-01`;
}

async function fetchJson(url, options = {}) {
  const traceparent = generateTraceparent();
  console.log(`outbound -> ${url} | traceparent=${traceparent}`);
  const headers = { ...(options.headers || {}), traceparent };
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new Error(data.message || res.statusText);
    error.status = res.status;
    throw error;
  }
  return data;
}

async function checkInventory(sku) {
  return fetchJson(
    `${INVENTORY_BASE_URL}/v1/inventory/${encodeURIComponent(sku)}`
  );
}

function computeTotal(items) {
  return items.reduce((sum, item) => {
    const price = typeof item.price === "number" ? item.price : 0;
    return sum + price * item.quantity;
  }, 0);
}

app.post("/v1/orders", async (req, res) => {
  try {
    const { customerId, items } = req.body || {};
    if (!customerId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        code: "BAD_REQUEST",
        message: "customerId and non-empty items are required",
      });
    }

    const firstItem = items[0];
    try {
      await checkInventory(firstItem.sku);
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({
          code: "ITEM_NOT_FOUND",
          message: `item ${firstItem.sku} not found in inventory`,
        });
      }
      throw err;
    }

    const orderId = `o${orderCounter++}`;
    const order = {
      orderId,
      customerId,
      status: "pending",
      items,
      total: computeTotal(items),
      createdAt: new Date().toISOString(),
    };
    ordersById.set(orderId, order);
    return res.status(201).json(order);
  } catch (err) {
    const status = err.status || 500;
    return res
      .status(status)
      .json({ code: "INTERNAL_ERROR", message: err.message });
  }
});

app.get("/v1/orders/:orderId", (req, res) => {
  const order = ordersById.get(req.params.orderId);
  if (!order) {
    return res
      .status(404)
      .json({ code: "ORDER_NOT_FOUND", message: "order not found" });
  }
  return res.json(order);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "orders" });
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`orders listening on port ${port}`);
});
