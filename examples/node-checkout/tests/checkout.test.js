import test from "node:test";
import assert from "node:assert/strict";
import { processCheckout } from "../src/api/checkout/process.js";

test("processCheckout computes correct order total and item count", async () => {
  const cart = {
    items: [
      { id: "item-1", price: 10 },
      { id: "item-2", price: 20 },
      { id: "item-3", price: 30 },
    ],
  };

  const res = await processCheckout(cart);
  assert.equal(res.count, 3);
  assert.equal(Math.round(res.total), 66); // (10 + 20 + 30) * 1.1 = 66
});
